/**
 * In-process cache. MCP read tools answer from here and never await I/O (spec 2.2).
 *
 * One slot per instrument. Reconnect semantics come straight from schema/wire-v1.md: on every
 * connect the whole table is marked `reconnecting` and frames are ignored until a fresh hello
 * arrives, because instrument indices are valid only for the connection that announced them.
 */

import type {
  Frame,
  HandlerLatency,
  HelloInstrument,
  SnapshotPayload,
} from "../wire/decoder.js";
import { FrameType } from "../wire/decoder.js";

export type Freshness = "live" | "stale" | "reconnecting";

/** Bounded ring of recent events (spec 3.2). Step 1 records connection lifecycle only. */
export const DEFAULT_EVENT_RING_SIZE = 256;

/** A slot older than this at service time reports `stale`. */
export const DEFAULT_STALE_AFTER_MS = 2_000;

export interface CachedEvent {
  kind: string;
  wallUtcMs: number;
  detail: string;
}

export interface InstrumentSlot {
  index: number;
  name: string;
  tickSize: number;
  pointValue: number;
  /** Last decoded snapshot payload, null until the first snapshot for this instrument. */
  snapshot: SnapshotPayload | null;
  /** process.hrtime.bigint() when the last snapshot was received. */
  receivedAtNs: bigint | null;
  /** receivedAtNs minus the frame's sentTicks rescaled to ns. Constant offset included. */
  offsetNs: bigint | null;
  sequence: number;
  droppedTotal: number;
}

/**
 * Staleness is two numbers and they are never merged (schema/wire-v1.md, "Staleness").
 * `receiveToServeMs` is measured on one clock. `oneWayEstimateMs` is an estimate of the
 * publisher-to-client hop derived from heartbeat cadence, and is a lower bound on jitter rather
 * than a measurement of one-way latency; it is null until two heartbeats have been seen.
 */
export interface Staleness {
  receiveToServeMs: number | null;
  oneWayEstimateMs: number | null;
  oneWayEstimateBasis: "heartbeat-cadence-min-filter" | "insufficient-heartbeats";
}

export interface InstrumentView {
  index: number;
  name: string;
  tickSize: number;
  pointValue: number;
  freshness: Freshness;
  staleness: Staleness;
  sequence: number;
  droppedTotal: number;
  eventsDrained: string | null;
  bytesAllocatedOnPublisher: string | null;
  handlerSamples: string | null;
}

/** -1 on the wire means "not measured"; it is surfaced as the value plus a label, never as 0. */
export interface AllocFigure {
  bytes: number;
  status: "measured" | "unavailable";
}

/** Latency fields are null when the AddOn's histogram was empty; never 0 for "no data". */
export interface HandlerLatencyView {
  p50Ns: number | null;
  p99Ns: number | null;
  p999Ns: number | null;
  maxNs: number | null;
  sampleCount: string;
  allocBytesPer1024: AllocFigure;
  allocBytesTotal: AllocFigure;
}

export interface SerializeLatencyView {
  p50Ns: number | null;
  p99Ns: number | null;
  p999Ns: number | null;
  maxNs: number | null;
  sampleCount: string;
}

/**
 * Per-instrument instrumentation as last reported by the AddOn (step-2 snapshot block).
 * `instrumentation` is "absent" when the publisher is a step-1 build sending 24-byte snapshots,
 * and "none" when no snapshot has arrived on this connection.
 */
export interface InstrumentLatencyView {
  index: number;
  name: string;
  freshness: Freshness;
  staleness: Staleness;
  sequence: number;
  instrumentation: "present" | "absent" | "none";
  data: HandlerLatencyView | null;
  depth: HandlerLatencyView | null;
  publisherAllocBytesTotal: AllocFigure | null;
  serialize: SerializeLatencyView | null;
  stopwatchFrequency: string | null;
  ringDropsTotal: string | null;
  sampleOverrunsTotal: string | null;
  /** Ring event drops from frame headers, summed on this connection (same as instruments tool). */
  droppedTotal: number;
}

export interface CacheHealth {
  pipeState: string;
  endpoint: string;
  helloReceived: boolean;
  connectionCount: number;
  instrumentCount: number;
  framesReceived: number;
  lastFrameStaleness: Staleness;
  stopwatchFrequency: string | null;
  heartbeatsSeen: number;
  droppedTotal: number;
  eventsDrained: string | null;
  lastError: string | null;
}

export interface StateCacheOptions {
  eventRingSize?: number;
  staleAfterMs?: number;
  /** Injectable clock for tests. Defaults to process.hrtime.bigint. */
  now?: () => bigint;
}

const NS_PER_MS = 1_000_000;
const NS_PER_SECOND = 1_000_000_000n;

export class StateCache {
  private readonly slots = new Map<number, InstrumentSlot>();
  private readonly events: CachedEvent[] = [];
  private readonly eventRingSize: number;
  private readonly staleAfterMs: number;
  private readonly now: () => bigint;

  private helloReceivedValue = false;
  private connectionCountValue = 0;
  private framesReceivedValue = 0;
  private lastFrameAtNs: bigint | null = null;
  private lastErrorValue: string | null = null;
  private pipeStateValue = "disconnected";
  private endpointValue = "";
  private ignoredBeforeHello = 0;

  // Staleness estimation state. Cleared on every connect: neither the publisher's clock offset
  // nor its Stopwatch frequency may be carried across connections.
  private stopwatchFrequencyValue: bigint | null = null;
  private lastFrameOffsetNs: bigint | null = null;
  private heartbeatsSeenValue = 0;
  private minOffsetNs: bigint | null = null;

  constructor(options: StateCacheOptions = {}) {
    this.eventRingSize = options.eventRingSize ?? DEFAULT_EVENT_RING_SIZE;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? process.hrtime.bigint;
  }

  get helloReceived(): boolean {
    return this.helloReceivedValue;
  }

  get framesReceived(): number {
    return this.framesReceivedValue;
  }

  get connectionCount(): number {
    return this.connectionCountValue;
  }

  /** Frames dropped by the splitter or decoder are counted here, not in the slots. */
  get framesIgnoredBeforeHello(): number {
    return this.ignoredBeforeHello;
  }

  get heartbeatsSeen(): number {
    return this.heartbeatsSeenValue;
  }

  get stopwatchFrequency(): bigint | null {
    return this.stopwatchFrequencyValue;
  }

  setEndpoint(endpoint: string): void {
    this.endpointValue = endpoint;
  }

  setPipeState(state: string): void {
    this.pipeStateValue = state;
  }

  setError(message: string | null): void {
    this.lastErrorValue = message;
  }

  /**
   * Called on every (re)connect. Instruments stay visible so `instruments` can still answer,
   * but every slot reads `reconnecting` and carries no snapshot until a fresh hello lands.
   */
  onConnect(): void {
    this.connectionCountValue++;
    this.helloReceivedValue = false;
    this.lastFrameAtNs = null;
    this.resetStalenessEstimator();
    for (const slot of this.slots.values()) {
      slot.snapshot = null;
      slot.receivedAtNs = null;
      slot.offsetNs = null;
      slot.sequence = 0;
    }
    this.pushEvent("connected", "connection " + this.connectionCountValue);
  }

  onDisconnect(reason: string): void {
    this.helloReceivedValue = false;
    this.pipeStateValue = "disconnected";
    this.pushEvent("disconnected", reason);
  }

  /** Feeds one decoded frame. Frames before a hello are ignored, by protocol. */
  applyFrame(frame: Frame): void {
    if (frame.header.type === FrameType.Hello) {
      this.applyHello(frame);
      return;
    }

    if (!this.helloReceivedValue) {
      this.ignoredBeforeHello++;
      return;
    }

    this.framesReceivedValue++;
    const receivedAtNs = this.now();
    this.lastFrameAtNs = receivedAtNs;
    const offsetNs = this.observeOffset(frame.header.sentTicks, receivedAtNs);

    if (frame.header.type === FrameType.Heartbeat) {
      // Heartbeats are the only frames on a fixed publisher-side schedule, so they are the only
      // ones that carry information about the transport's variable delay.
      this.heartbeatsSeenValue++;
      if (offsetNs !== null && (this.minOffsetNs === null || offsetNs < this.minOffsetNs)) {
        this.minOffsetNs = offsetNs;
      }
      return;
    }

    if (frame.header.type === FrameType.Snapshot && frame.payload.kind === "snapshot") {
      const slot = this.slots.get(frame.header.instrument);
      if (!slot) {
        // Instrument index not in the current hello table: protocol violation, ignore.
        this.ignoredBeforeHello++;
        return;
      }
      slot.snapshot = frame.payload;
      slot.receivedAtNs = receivedAtNs;
      slot.offsetNs = offsetNs;
      slot.sequence = frame.header.sequence;
      slot.droppedTotal += frame.header.ringEventsDropped;
    }
  }

  private applyHello(frame: Frame): void {
    if (frame.payload.kind !== "hello") return;

    this.slots.clear();
    for (const inst of frame.payload.instruments) {
      this.slots.set(inst.index, blankSlot(inst));
    }
    this.helloReceivedValue = true;
    this.framesReceivedValue++;
    this.lastFrameAtNs = this.now();
    this.pipeStateValue = "connected";
    this.resetStalenessEstimator();
    this.stopwatchFrequencyValue = frame.payload.stopwatchFrequency;
    this.lastFrameOffsetNs = this.observeOffset(frame.header.sentTicks, this.lastFrameAtNs);
    this.pushEvent("hello", `${frame.payload.instruments.length} instrument(s)`);
  }

  private resetStalenessEstimator(): void {
    this.stopwatchFrequencyValue = null;
    this.lastFrameOffsetNs = null;
    this.minOffsetNs = null;
    this.heartbeatsSeenValue = 0;
  }

  /**
   * receiveTime minus sendTime, both in ns, with the two clocks' unknown constant offset still
   * in it. Only differences between two of these are meaningful. Null until a hello has supplied
   * the publisher's Stopwatch frequency.
   */
  private observeOffset(sentTicks: bigint, receivedAtNs: bigint): bigint | null {
    const freq = this.stopwatchFrequencyValue;
    if (freq === null || freq <= 0n) {
      this.lastFrameOffsetNs = null;
      return null;
    }
    const offset = receivedAtNs - (sentTicks * NS_PER_SECOND) / freq;
    this.lastFrameOffsetNs = offset;
    return offset;
  }

  /**
   * Estimated publisher-to-client hop for a frame observed at `offsetNs`, in ms. This is the
   * amount by which that frame's transit exceeded the minimum transit seen on this connection;
   * the constant clock offset cancels, the constant part of the transport delay does not and is
   * therefore excluded. A lower bound on jitter, not a one-way latency measurement.
   */
  private oneWayEstimateMs(offsetNs: bigint | null): number | null {
    if (offsetNs === null || this.minOffsetNs === null || this.heartbeatsSeenValue < 2) return null;
    return Number(offsetNs - this.minOffsetNs) / NS_PER_MS;
  }

  private stalenessOf(receivedAtNs: bigint | null, offsetNs: bigint | null): Staleness {
    const estimate = this.oneWayEstimateMs(offsetNs);
    return {
      receiveToServeMs: receivedAtNs === null ? null : Number(this.now() - receivedAtNs) / NS_PER_MS,
      oneWayEstimateMs: estimate,
      oneWayEstimateBasis:
        estimate === null ? "insufficient-heartbeats" : "heartbeat-cadence-min-filter",
    };
  }

  /**
   * Milliseconds, as a float. Dividing bigint nanoseconds by 1e6 in bigint arithmetic would
   * truncate every sub-millisecond age to 0 and make a fresh frame indistinguishable from one
   * that has not been timestamped.
   */
  private msSince(at: bigint | null): number | null {
    if (at === null) return null;
    return Number(this.now() - at) / NS_PER_MS;
  }

  private freshnessFor(slot: InstrumentSlot): Freshness {
    if (!this.helloReceivedValue) return "reconnecting";
    const ms = this.msSince(slot.receivedAtNs);
    if (ms === null) return "reconnecting";
    return ms > this.staleAfterMs ? "stale" : "live";
  }

  viewInstrument(index: number): InstrumentView | null {
    const slot = this.slots.get(index);
    return slot ? this.viewOf(slot) : null;
  }

  viewInstrumentByName(name: string): InstrumentView | null {
    for (const slot of this.slots.values()) {
      if (slot.name === name) return this.viewOf(slot);
    }
    return null;
  }

  viewInstruments(): InstrumentView[] {
    return [...this.slots.values()]
      .sort((a, b) => a.index - b.index)
      .map((slot) => this.viewOf(slot));
  }

  private viewOf(slot: InstrumentSlot): InstrumentView {
    const snapshot = slot.snapshot;
    return {
      index: slot.index,
      name: slot.name,
      tickSize: slot.tickSize,
      pointValue: slot.pointValue,
      freshness: this.freshnessFor(slot),
      staleness: this.stalenessOf(slot.receivedAtNs, slot.offsetNs),
      sequence: slot.sequence,
      droppedTotal: slot.droppedTotal,
      eventsDrained: snapshot ? snapshot.eventsDrained.toString() : null,
      bytesAllocatedOnPublisher: snapshot ? snapshot.bytesAllocatedOnPublisher.toString() : null,
      handlerSamples: snapshot ? snapshot.handlerSamples.toString() : null,
    };
  }

  viewLatency(): InstrumentLatencyView[] {
    return [...this.slots.values()]
      .sort((a, b) => a.index - b.index)
      .map((slot) => this.latencyOf(slot));
  }

  viewLatencyByName(name: string): InstrumentLatencyView | null {
    for (const slot of this.slots.values()) {
      if (slot.name === name) return this.latencyOf(slot);
    }
    return null;
  }

  private latencyOf(slot: InstrumentSlot): InstrumentLatencyView {
    const snapshot = slot.snapshot;
    const inst = snapshot?.instrumentation ?? null;
    return {
      index: slot.index,
      name: slot.name,
      freshness: this.freshnessFor(slot),
      staleness: this.stalenessOf(slot.receivedAtNs, slot.offsetNs),
      sequence: slot.sequence,
      instrumentation: snapshot === null ? "none" : inst === null ? "absent" : "present",
      data: inst ? handlerView(inst.data) : null,
      depth: inst ? handlerView(inst.depth) : null,
      publisherAllocBytesTotal: inst ? allocFigure(inst.publisherAllocBytesTotal) : null,
      serialize: inst
        ? {
            p50Ns: inst.serialize.p50Ns,
            p99Ns: inst.serialize.p99Ns,
            p999Ns: inst.serialize.p999Ns,
            maxNs: inst.serialize.maxNs,
            sampleCount: inst.serialize.sampleCount.toString(),
          }
        : null,
      stopwatchFrequency: inst ? inst.stopwatchFrequency.toString() : null,
      ringDropsTotal: inst ? inst.ringDropsTotal.toString() : null,
      sampleOverrunsTotal: inst ? inst.sampleOverrunsTotal.toString() : null,
      droppedTotal: slot.droppedTotal,
    };
  }

  health(): CacheHealth {
    let droppedTotal = 0;
    let eventsDrained: bigint | null = null;
    for (const slot of this.slots.values()) {
      droppedTotal += slot.droppedTotal;
      if (slot.snapshot) {
        const value = slot.snapshot.eventsDrained;
        if (eventsDrained === null || value > eventsDrained) eventsDrained = value;
      }
    }

    return {
      pipeState: this.pipeStateValue,
      endpoint: this.endpointValue,
      helloReceived: this.helloReceivedValue,
      connectionCount: this.connectionCountValue,
      instrumentCount: this.slots.size,
      framesReceived: this.framesReceivedValue,
      lastFrameStaleness: this.stalenessOf(this.lastFrameAtNs, this.lastFrameOffsetNs),
      stopwatchFrequency:
        this.stopwatchFrequencyValue === null ? null : this.stopwatchFrequencyValue.toString(),
      heartbeatsSeen: this.heartbeatsSeenValue,
      droppedTotal,
      eventsDrained: eventsDrained === null ? null : eventsDrained.toString(),
      lastError: this.lastErrorValue,
    };
  }

  pushEvent(kind: string, detail: string): void {
    this.events.push({ kind, wallUtcMs: Date.now(), detail });
    while (this.events.length > this.eventRingSize) this.events.shift();
  }

  recentEvents(limit = 32): CachedEvent[] {
    return this.events.slice(Math.max(0, this.events.length - limit));
  }
}

export function allocFigure(bytes: bigint): AllocFigure {
  return bytes < 0n
    ? { bytes: -1, status: "unavailable" }
    : { bytes: Number(bytes), status: "measured" };
}

function handlerView(h: HandlerLatency): HandlerLatencyView {
  return {
    p50Ns: h.p50Ns,
    p99Ns: h.p99Ns,
    p999Ns: h.p999Ns,
    maxNs: h.maxNs,
    sampleCount: h.sampleCount.toString(),
    allocBytesPer1024: allocFigure(h.allocBytesPer1024),
    allocBytesTotal: allocFigure(h.allocBytesTotal),
  };
}

function blankSlot(inst: HelloInstrument): InstrumentSlot {
  return {
    index: inst.index,
    name: inst.name,
    tickSize: inst.tickSize,
    pointValue: inst.pointValue,
    snapshot: null,
    receivedAtNs: null,
    offsetNs: null,
    sequence: 0,
    droppedTotal: 0,
  };
}
