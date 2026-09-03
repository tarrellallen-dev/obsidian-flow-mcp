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
  InstrumentIdentity,
  MarketBlock,
  ProfileRecord,
  SnapshotPayload,
  UnresolvedInstrument,
  WireProfileCheckpoint,
  WireProfileLevel,
} from "../wire/decoder.js";
import { FrameType, dotnetTicksToIso, expiryTicksToDate } from "../wire/decoder.js";

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

/**
 * Per-instrument resolution state, for the health tool. "rolled" means the AddOn re-resolved a
 * bare root to a different contract at `rolledAt`, either on this connection (a contractRolled
 * event was seen) or earlier in the AddOn process (the hello identity carried rolledAtUtc).
 */
export interface ResolutionState {
  state: "resolved" | "rolled" | "unresolved" | "identity-absent";
  rolledAt: string | null;
  rollCount: number;
  /** fullName of the contract this slot held before the last roll seen on this connection. */
  previousName: string | null;
  reason: string | null;
}

export interface InstrumentSlot {
  index: number;
  name: string;
  tickSize: number;
  pointValue: number;
  /** Null when the publisher predates the identity section. */
  identity: InstrumentIdentity | null;
  /** Previous identity when a contractRolled event was seen on this connection. */
  previousIdentity: InstrumentIdentity | null;
  /** Last decoded snapshot payload, null until the first snapshot for this instrument. */
  snapshot: SnapshotPayload | null;
  /** process.hrtime.bigint() when the last snapshot was received. */
  receivedAtNs: bigint | null;
  /** receivedAtNs minus the frame's sentTicks rescaled to ns. Constant offset included. */
  offsetNs: bigint | null;
  sequence: number;
  droppedTotal: number;
  /** wallUtc from the header of the cached snapshot; null until one arrives. */
  snapshotWallUtc: bigint | null;
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

/** The identity block with ticks rendered as dates; what `instruments` returns per entry. */
export interface IdentityView {
  resolvedFrom: string;
  shape: string;
  resolvedBy: string;
  fullName: string;
  masterName: string;
  instrumentType: string;
  exchange: string;
  currency: string;
  tradingHours: string;
  /** YYYY-MM-DD, or null when the instrument does not expire. */
  expiry: string | null;
  expiryTicks: string;
  tickSize: number;
  pointValue: number;
  rolledAt: string | null;
  rollCount: number;
}

export interface InstrumentView {
  index: number;
  name: string;
  /** What the user typed in the AddOn config; equals name when identity is absent. */
  resolvedFrom: string;
  /** YYYY-MM-DD, null when the instrument does not expire or identity is absent. */
  expiry: string | null;
  tickSize: number;
  pointValue: number;
  identity: IdentityView | null;
  resolution: ResolutionState;
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

/** One line per config entry in the health tool. */
export interface InstrumentHealth {
  resolvedFrom: string;
  name: string | null;
  index: number | null;
  state: ResolutionState["state"];
  reason: string | null;
  rolledAt: string | null;
  rollCount: number;
  previousName: string | null;
}

// ---------------------------------------------------------------------------------------------
// Step-4 market views. Every read carries the same envelope: the resolved instrument, freshness,
// the two staleness numbers (plus stalenessMs, the measured one), sequence, ring drops, depth
// availability and whether the AddOn sent a market block at all.
// ---------------------------------------------------------------------------------------------

export type ProfileScope = "session" | "prior" | "composite";

export interface InstrumentRef {
  index: number;
  name: string;
  resolvedFrom: string;
  identity: IdentityView | null;
}

/** Whether the last snapshot carried the step-3 market block. */
export interface MarketAvailability {
  status: "present" | "absent" | "none";
  reason: string | null;
}

export interface DepthAvailability {
  state: "live" | "unavailable";
  reason: string | null;
}

export interface ReadEnvelope {
  instrument: InstrumentRef;
  freshness: Freshness;
  /** Measured receive-to-serve age of the cached snapshot in ms; null when nothing is cached. */
  stalenessMs: number | null;
  staleness: Staleness;
  sequence: number;
  droppedTotal: number;
  depth: DepthAvailability;
  market: MarketAvailability;
  /** From the frame header of the cached snapshot. */
  snapshotWallUtc: string | null;
}

export interface SessionView {
  known: boolean;
  inSession: boolean;
  begin: string | null;
  end: string | null;
}

export interface PriceView {
  last: number | null;
  lastSize: number;
  /** none | bid (seller hit the bid) | ask (buyer lifted the offer) | between | unknown. */
  lastAggressor: string;
  bid: number | null;
  ask: number | null;
  spreadTicks: number | null;
  sessionOpen: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  /** History bars folded in plus tape. */
  sessionVolume: number;
  tapeVolume: number;
  tradeCount: number;
  tickSize: number;
  pointValue: number;
  session: SessionView;
}

export interface VwapView {
  vwap: number | null;
  stdDev: number | null;
  sd1Upper: number | null;
  sd1Lower: number | null;
  sd2Upper: number | null;
  sd2Lower: number | null;
  priceVsVwapTicks: number | null;
  volume: number;
  includesHistory: boolean;
}

export interface CoverageView {
  historyState: string;
  historyResolution: string;
  historyFromWallUtc: string | null;
  historyToWallUtc: string | null;
  tapeFromWallUtc: string | null;
  historyError: string | null;
  /** True when any tape volume is in the session profile: bid/ask figures exist from tapeFrom on. */
  bidAskSplitPresent: boolean;
}

export interface NodeView {
  price: number;
  kind: string;
  strength: number;
  volume: number;
}

export interface CheckpointView {
  at: string | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
}

export interface LevelView {
  price: number;
  volume: number;
  historyVolume: number;
  tapeVolume: number;
  /** Null when the level has no tape volume: the split exists for live tape only. */
  bidVolume: number | null;
  askVolume: number | null;
  /** Tape prints inside the spread, attributable to neither side. */
  unattributedVolume: number | null;
}

export interface ProfileView {
  scope: ProfileScope;
  available: boolean;
  reason: string | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
  pocVolume: number;
  valueAreaVolume: number;
  totalVolume: number;
  tapeVolume: number;
  outOfRangeVolume: number;
  rangeLow: number | null;
  rangeHigh: number | null;
  bidAskSplit: "live-tape-only" | "unavailable";
  includesHistory: boolean;
  /** Prior only: true while the current session has not traded through the prior POC. */
  nakedPoc: boolean | null;
  /** Prior only: "live" when promoted from a session the AddOn watched whole, else "history". */
  source: "live" | "history" | null;
  nodes: NodeView[];
  developing: { latest: CheckpointView | null; count: number; series?: CheckpointView[] };
  histogram?: LevelView[];
  histogramLevels?: number;
}

export interface MarketRead {
  envelope: ReadEnvelope;
  price: PriceView | null;
  vwap: VwapView | null;
  coverage: CoverageView | null;
  block: MarketBlock | null;
}

export interface CacheHealth {
  pipeState: string;
  endpoint: string;
  helloReceived: boolean;
  connectionCount: number;
  instrumentCount: number;
  unresolvedCount: number;
  /** Hellos on the current connection beyond the first: one per roll re-announcement. */
  helloReannouncements: number;
  instruments: InstrumentHealth[];
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
  private unresolved: UnresolvedInstrument[] = [];
  private helloReannouncementsValue = 0;
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

  get helloReannouncements(): number {
    return this.helloReannouncementsValue;
  }

  get unresolvedInstruments(): UnresolvedInstrument[] {
    return [...this.unresolved];
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
    this.helloReannouncementsValue = 0;
    this.lastFrameAtNs = null;
    this.resetStalenessEstimator();
    for (const slot of this.slots.values()) {
      slot.snapshot = null;
      slot.receivedAtNs = null;
      slot.offsetNs = null;
      slot.sequence = 0;
      slot.snapshotWallUtc = null;
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
      slot.snapshotWallUtc = frame.header.wallUtc;
      return;
    }

    if (frame.header.type === FrameType.Event && frame.payload.kind === "event") {
      this.applyEvent(frame);
    }
  }

  /**
   * Discrete events (schema/wire-v1.md, "type 2 - event"). contractRolled marks the boundary
   * for one index: the slot's cached snapshot belongs to the previous contract and is
   * discarded, the previous identity is kept for the health tool, and the event goes into the
   * ring so events_recent can show it. The identity itself was already replaced by the
   * re-announced hello that precedes the event; if the event arrives first (it should not),
   * the identity is taken from the event so the two are never out of step.
   */
  private applyEvent(frame: Frame): void {
    if (frame.payload.kind !== "event") return;
    const ev = frame.payload.event;

    if (ev.name === "contractRolled") {
      const slot = this.slots.get(frame.header.instrument);
      if (!slot) {
        this.ignoredBeforeHello++;
        return;
      }
      slot.previousIdentity = ev.previous;
      if (slot.identity === null || slot.identity.fullName !== ev.next.fullName) {
        slot.identity = ev.next;
        slot.name = ev.next.fullName;
        slot.tickSize = ev.next.tickSize;
        slot.pointValue = ev.next.pointValue;
      }
      slot.snapshot = null;
      slot.receivedAtNs = null;
      slot.offsetNs = null;
      slot.sequence = frame.header.sequence;
      slot.snapshotWallUtc = null;
      this.pushEvent(
        "contractRolled",
        `${ev.previous.resolvedFrom}: ${ev.previous.fullName} -> ${ev.next.fullName} at ${dotnetTicksToIso(ev.rolledAtUtc) ?? "?"} (index ${frame.header.instrument}, sequence ${frame.header.sequence})`,
      );
      return;
    }

    this.pushEvent("unknownEvent", `eventKind ${ev.eventKind}, ${ev.bytes} byte(s)`);
  }

  /**
   * First hello on a connection: rebuild the table. A later hello on the same connection is a
   * re-announcement after a roll (schema/wire-v1.md, "re-announcement"): indices are
   * re-validated against the new table rather than the table being thrown away. An index that
   * disappeared is dropped; an index whose fullName changed starts a new series with a blank
   * slot (the previous identity is remembered); an unchanged index keeps its snapshot and
   * counters.
   */
  private applyHello(frame: Frame): void {
    if (frame.payload.kind !== "hello") return;

    const reannounce = this.helloReceivedValue;
    if (!reannounce) {
      this.slots.clear();
      for (const inst of frame.payload.instruments) {
        this.slots.set(inst.index, blankSlot(inst));
      }
    } else {
      this.helloReannouncementsValue++;
      const next = new Map<number, InstrumentSlot>();
      let replaced = 0;
      for (const inst of frame.payload.instruments) {
        const existing = this.slots.get(inst.index);
        if (existing && existing.name === inst.name) {
          // Same contract: keep the series. Refresh identity fields (rollCount etc.) in case
          // the publisher's copy moved on without a change of contract.
          if (inst.identity) existing.identity = inst.identity;
          next.set(inst.index, existing);
          continue;
        }
        const fresh = blankSlot(inst);
        if (existing) {
          fresh.previousIdentity = existing.identity;
          fresh.droppedTotal = 0;
          replaced++;
        }
        next.set(inst.index, fresh);
      }
      const dropped = [...this.slots.keys()].filter((i) => !next.has(i)).length;
      this.slots.clear();
      for (const [index, slot] of next) this.slots.set(index, slot);
      this.pushEvent(
        "helloReannounced",
        `${frame.payload.instruments.length} instrument(s), ${replaced} replaced, ${dropped} dropped`,
      );
    }

    this.unresolved = [...frame.payload.unresolved];
    this.helloReceivedValue = true;
    this.framesReceivedValue++;
    this.lastFrameAtNs = this.now();
    this.pipeStateValue = "connected";
    if (!reannounce) {
      this.resetStalenessEstimator();
      this.stopwatchFrequencyValue = frame.payload.stopwatchFrequency;
      this.pushEvent(
        "hello",
        `${frame.payload.instruments.length} instrument(s), ${frame.payload.unresolved.length} unresolved` +
          (frame.payload.identityPresent ? "" : ", identity section absent (pre-2.5 publisher)"),
      );
    }
    this.lastFrameOffsetNs = this.observeOffset(frame.header.sentTicks, this.lastFrameAtNs);
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

  /** Matches the resolved name first, then what the user typed (e.g. a bare root). */
  viewInstrumentByName(name: string): InstrumentView | null {
    const slot = this.findSlot(name);
    return slot ? this.viewOf(slot) : null;
  }

  private findSlot(name: string): InstrumentSlot | null {
    for (const slot of this.slots.values()) {
      if (slot.name === name) return slot;
    }
    for (const slot of this.slots.values()) {
      if (slot.identity && slot.identity.resolvedFrom === name) return slot;
    }
    return null;
  }

  private resolutionOf(slot: InstrumentSlot): ResolutionState {
    const id = slot.identity;
    if (id === null) {
      return { state: "identity-absent", rolledAt: null, rollCount: 0, previousName: null, reason: null };
    }
    const rolledAt = dotnetTicksToIso(id.rolledAtUtc);
    return {
      state: id.rollCount > 0 || slot.previousIdentity !== null ? "rolled" : "resolved",
      rolledAt,
      rollCount: id.rollCount,
      previousName: slot.previousIdentity ? slot.previousIdentity.fullName : null,
      reason: null,
    };
  }

  viewInstruments(): InstrumentView[] {
    return [...this.slots.values()]
      .sort((a, b) => a.index - b.index)
      .map((slot) => this.viewOf(slot));
  }

  private viewOf(slot: InstrumentSlot): InstrumentView {
    const snapshot = slot.snapshot;
    const id = slot.identity;
    return {
      index: slot.index,
      name: slot.name,
      resolvedFrom: id ? id.resolvedFrom : slot.name,
      expiry: id ? expiryTicksToDate(id.expiryTicks) : null,
      tickSize: slot.tickSize,
      pointValue: slot.pointValue,
      identity: id ? identityView(id) : null,
      resolution: this.resolutionOf(slot),
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
    const slot = this.findSlot(name);
    return slot ? this.latencyOf(slot) : null;
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

    const instruments: InstrumentHealth[] = [...this.slots.values()]
      .sort((a, b) => a.index - b.index)
      .map((slot) => {
        const r = this.resolutionOf(slot);
        return {
          resolvedFrom: slot.identity ? slot.identity.resolvedFrom : slot.name,
          name: slot.name,
          index: slot.index,
          state: r.state,
          reason: r.reason,
          rolledAt: r.rolledAt,
          rollCount: r.rollCount,
          previousName: r.previousName,
        };
      });
    for (const u of this.unresolved) {
      instruments.push({
        resolvedFrom: u.typed,
        name: null,
        index: null,
        state: "unresolved",
        reason: u.reason,
        rolledAt: null,
        rollCount: 0,
        previousName: null,
      });
    }

    return {
      pipeState: this.pipeStateValue,
      endpoint: this.endpointValue,
      helloReceived: this.helloReceivedValue,
      connectionCount: this.connectionCountValue,
      instrumentCount: this.slots.size,
      unresolvedCount: this.unresolved.length,
      helloReannouncements: this.helloReannouncementsValue,
      instruments,
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

  // ---------------------------------------------------------------------------------------
  // Step-4 market reads
  // ---------------------------------------------------------------------------------------

  /**
   * The slot a read tool should answer for: the named instrument (resolved name or config
   * entry as typed), or the only instrument when none is named. Returns an error message
   * otherwise, so a tool never silently picks one of several.
   */
  selectSlot(name?: string): { slot: InstrumentSlot } | { error: string } {
    if (name) {
      const slot = this.findSlot(name);
      if (slot) return { slot };
      const known = [...this.slots.values()].map((s) => s.name);
      return {
        error: `no instrument "${name}" in the current hello table (known: ${known.length ? known.join(", ") : "none"}; helloReceived=${this.helloReceivedValue})`,
      };
    }
    const all = [...this.slots.values()];
    if (all.length === 1) return { slot: all[0]! };
    if (all.length === 0) {
      return { error: `no instruments announced yet (helloReceived=${this.helloReceivedValue}, pipe ${this.pipeStateValue})` };
    }
    return { error: `several instruments are announced (${all.map((s) => s.name).join(", ")}); pass name` };
  }

  private envelopeOf(slot: InstrumentSlot): ReadEnvelope {
    const snapshot = slot.snapshot;
    const staleness = this.stalenessOf(slot.receivedAtNs, slot.offsetNs);
    const market: MarketAvailability =
      snapshot === null
        ? { status: "none", reason: "no snapshot received for this instrument on the current connection" }
        : snapshot.market === null
          ? { status: "absent", reason: "the AddOn sent a snapshot without the step-3 market block (pre-step-3 build)" }
          : { status: "present", reason: null };
    return {
      instrument: {
        index: slot.index,
        name: slot.name,
        resolvedFrom: slot.identity ? slot.identity.resolvedFrom : slot.name,
        identity: slot.identity ? identityView(slot.identity) : null,
      },
      freshness: this.freshnessFor(slot),
      stalenessMs: staleness.receiveToServeMs,
      staleness,
      sequence: slot.sequence,
      droppedTotal: slot.droppedTotal,
      depth: { state: "unavailable", reason: "market depth is not computed in this build step (book state lands in step 6)" },
      market,
      snapshotWallUtc: slot.snapshotWallUtc === null ? null : dotnetTicksToIso(slot.snapshotWallUtc),
    };
  }

  /** Envelope plus the decoded price, vwap and coverage views; null views when no market block. */
  readMarket(name?: string): MarketRead | { error: string } {
    const sel = this.selectSlot(name);
    if ("error" in sel) return sel;
    const slot = sel.slot;
    const block = slot.snapshot?.market ?? null;
    return {
      envelope: this.envelopeOf(slot),
      price: block ? priceView(block) : null,
      vwap: block ? vwapView(block) : null,
      coverage: block ? coverageView(block) : null,
      block,
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

export function identityView(id: InstrumentIdentity): IdentityView {
  return {
    resolvedFrom: id.resolvedFrom,
    shape: id.shape,
    resolvedBy: id.resolvedBy,
    fullName: id.fullName,
    masterName: id.masterName,
    instrumentType: id.instrumentType,
    exchange: id.exchange,
    currency: id.currency,
    tradingHours: id.tradingHours,
    expiry: expiryTicksToDate(id.expiryTicks),
    expiryTicks: id.expiryTicks.toString(),
    tickSize: id.tickSize,
    pointValue: id.pointValue,
    rolledAt: dotnetTicksToIso(id.rolledAtUtc),
    rollCount: id.rollCount,
  };
}

function blankSlot(inst: HelloInstrument): InstrumentSlot {
  return {
    index: inst.index,
    name: inst.name,
    tickSize: inst.tickSize,
    pointValue: inst.pointValue,
    identity: inst.identity,
    previousIdentity: null,
    snapshot: null,
    receivedAtNs: null,
    offsetNs: null,
    sequence: 0,
    droppedTotal: 0,
    snapshotWallUtc: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Step-4 view builders. bigint volumes become numbers (they fit), .NET ticks become ISO strings,
// NaN already became null in the decoder.
// ---------------------------------------------------------------------------------------------

function ticksIso(ticks: bigint): string | null {
  return ticks === 0n ? null : dotnetTicksToIso(ticks);
}

export function priceView(m: MarketBlock): PriceView {
  const p = m.price;
  return {
    last: p.last,
    lastSize: Number(p.lastSize),
    lastAggressor: p.lastAggressor,
    bid: p.bid,
    ask: p.ask,
    spreadTicks: p.spreadTicks,
    sessionOpen: p.sessionOpen,
    sessionHigh: p.sessionHigh,
    sessionLow: p.sessionLow,
    sessionVolume: Number(p.sessionVolume),
    tapeVolume: Number(p.tapeVolume),
    tradeCount: Number(p.tradeCount),
    tickSize: p.tickSize,
    pointValue: p.pointValue,
    session: {
      known: m.flags.sessionKnown,
      inSession: m.flags.inSession,
      begin: ticksIso(p.sessionBeginUtc),
      end: ticksIso(p.sessionEndUtc),
    },
  };
}

export function vwapView(m: MarketBlock): VwapView {
  const v = m.vwap;
  return {
    vwap: v.vwap,
    stdDev: v.stdDev,
    sd1Upper: v.sd1Upper,
    sd1Lower: v.sd1Lower,
    sd2Upper: v.sd2Upper,
    sd2Lower: v.sd2Lower,
    priceVsVwapTicks: v.priceVsVwapTicks,
    volume: Number(v.volume),
    includesHistory: v.includesHistory,
  };
}

export function coverageView(m: MarketBlock): CoverageView {
  const c = m.coverage;
  return {
    historyState: c.historyState,
    historyResolution: c.historyResolution,
    historyFromWallUtc: ticksIso(c.historyFromUtc),
    historyToWallUtc: ticksIso(c.historyToUtc),
    tapeFromWallUtc: ticksIso(c.tapeFromUtc),
    historyError: c.historyError.length > 0 ? c.historyError : null,
    bidAskSplitPresent: m.flags.bidAskSplitPresent,
  };
}

function checkpointView(c: WireProfileCheckpoint): CheckpointView {
  return { at: ticksIso(c.atUtc), poc: c.poc, vah: c.vah, val: c.val };
}

export function levelView(l: WireProfileLevel): LevelView {
  const tape = Number(l.tapeVolume);
  const volume = Number(l.volume);
  const bid = Number(l.bidVolume);
  const ask = Number(l.askVolume);
  return {
    price: l.price,
    volume,
    historyVolume: volume - tape,
    tapeVolume: tape,
    bidVolume: tape > 0 ? bid : null,
    askVolume: tape > 0 ? ask : null,
    unattributedVolume: tape > 0 ? tape - bid - ask : null,
  };
}

/**
 * One profile record as a tool response. The histogram is included only on request and the
 * full developing series only for the volume_profile tool; the summary always carries
 * POC/VAH/VAL, the latest developing checkpoint and the node list.
 */
export function profileView(
  m: MarketBlock,
  scope: ProfileScope,
  options: { includeHistogram?: boolean; includeSeries?: boolean } = {},
): ProfileView {
  const r: ProfileRecord = scope === "session" ? m.session : scope === "prior" ? m.prior : m.composite;
  const reason = r.available
    ? null
    : scope === "prior"
      ? m.coverage.historyState === "failed"
        ? `prior session unavailable: ${m.coverage.historyError || "history request failed"}`
        : m.coverage.historyState === "pending"
          ? "prior session unavailable: history request pending"
          : m.coverage.historyState === "disabled"
            ? "prior session unavailable: historyBars is \"none\" in the AddOn config"
            : "prior session unavailable: no prior-session bars yet"
      : scope === "composite"
        ? "composite unavailable: no volume in either the prior or the current session yet"
        : "session profile unavailable: tick size unknown for this instrument";
  const latest = r.checkpoints.length > 0 ? checkpointView(r.checkpoints[r.checkpoints.length - 1]!) : null;
  const view: ProfileView = {
    scope,
    available: r.available,
    reason,
    poc: r.poc,
    vah: r.vah,
    val: r.val,
    pocVolume: Number(r.pocVolume),
    valueAreaVolume: Number(r.valueAreaVolume),
    totalVolume: Number(r.totalVolume),
    tapeVolume: Number(r.tapeVolume),
    outOfRangeVolume: Number(r.outOfRangeVolume),
    rangeLow: r.rangeLow,
    rangeHigh: r.rangeHigh,
    bidAskSplit: r.flags.hasBidAskSplit ? "live-tape-only" : "unavailable",
    includesHistory: r.flags.includesHistory,
    nakedPoc: scope === "prior" ? (r.available ? r.flags.nakedPoc : null) : null,
    source: scope === "prior" ? (r.available ? (r.flags.priorFromLive ? "live" : "history") : null) : null,
    nodes: r.nodes.map((n) => ({ price: n.price, kind: n.kind, strength: n.strength, volume: Number(n.volume) })),
    developing: { latest, count: r.checkpoints.length },
  };
  if (options.includeSeries) view.developing.series = r.checkpoints.map(checkpointView);
  if (options.includeHistogram) {
    view.histogram = r.histogram.map(levelView);
    view.histogramLevels = r.histogram.length;
  }
  return view;
}
