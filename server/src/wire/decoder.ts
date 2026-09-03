/**
 * Wire v1 decoder. Mirrors schema/wire-v1.md exactly; pinned by the golden-file test.
 * Little-endian throughout.
 */

export const SCHEMA_VERSION = 1;

/** Bytes of header following the u32 length field. */
export const HEADER_BYTES = 32;

/** Bytes of the length field itself. */
export const LENGTH_PREFIX_BYTES = 4;

/** schema/wire-v1.md: a frame larger than this is a protocol violation, not a config knob. */
export const MAX_FRAME_BYTES = 1_048_576;

/** Header instrument value meaning "this frame is not instrument-scoped". */
export const INSTRUMENT_NONE = 0xffff;

/** .NET DateTime ticks at the Unix epoch. */
export const DOTNET_TICKS_AT_UNIX_EPOCH = 621_355_968_000_000_000n;

export const FrameType = {
  Snapshot: 1,
  Event: 2,
  Hello: 3,
  Heartbeat: 4,
  ExecRequest: 16,
  ExecReply: 17,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export interface FrameHeader {
  /** Value of the length field: header + payload bytes. */
  length: number;
  type: number;
  version: number;
  sequence: number;
  /**
   * Market events the AddOn's rings dropped (ring full) since the previous frame. Not dropped
   * snapshots: snapshots are conflated, so none is ever dropped (schema/wire-v1.md, "Frame").
   */
  ringEventsDropped: number;
  sentTicks: bigint;
  wallUtc: bigint;
  instrument: number;
  reserved: number;
}

/** Config-entry shape the AddOn recognised (schema/wire-v1.md, "identity block", `shape`). */
export type InstrumentShape = "fullyQualified" | "root" | "direct" | "unknown";

/** How the AddOn arrived at the resolved name (`resolvedBy`). */
export type ResolutionMethod = "asTyped" | "nt8Default" | "rolloverTable" | "nextExpiry" | "unknown";

/**
 * The fingerprint of one subscription (schema/wire-v1.md, "identity block"). Produced by the
 * AddOn once at resolve time and once more per roll; carried in the hello and in the
 * contractRolled event. `expiryTicks` is 0n for an instrument that does not expire.
 */
export interface InstrumentIdentity {
  shape: InstrumentShape;
  shapeCode: number;
  resolvedBy: ResolutionMethod;
  resolvedByCode: number;
  /** The config entry exactly as the user typed it. */
  resolvedFrom: string;
  /** NinjaTrader Instrument.FullName; equals the base entry's name. */
  fullName: string;
  masterName: string;
  instrumentType: string;
  exchange: string;
  currency: string;
  tradingHours: string;
  /** .NET ticks of the expiry calendar date at 00:00 (no time zone); 0n = never expires. */
  expiryTicks: bigint;
  tickSize: number;
  pointValue: number;
  /** DateTime.UtcNow ticks of the last roll in the AddOn process; 0n = never rolled. */
  rolledAtUtc: bigint;
  rollCount: number;
}

export interface HelloInstrument {
  index: number;
  name: string;
  tickSize: number;
  pointValue: number;
  /** Null when the publisher predates the step-2.5 identity section. */
  identity: InstrumentIdentity | null;
}

/** A config entry that produced no subscription; has no index and never appears in a header. */
export interface UnresolvedInstrument {
  typed: string;
  reason: string;
}

export interface HelloPayload {
  kind: "hello";
  /**
   * Publisher's Stopwatch.Frequency in ticks per second. Required to interpret sentTicks at all;
   * never assume 10 MHz. The two clocks share no epoch, so this converts tick *differences* into
   * seconds and nothing more (schema/wire-v1.md, "Staleness").
   */
  stopwatchFrequency: bigint;
  instruments: HelloInstrument[];
  /** False when the payload ended after the base table (step-1/step-2 publisher). */
  identityPresent: boolean;
  unresolved: UnresolvedInstrument[];
}

export const EventKind = {
  ContractRolled: 1,
} as const;

export interface ContractRolledEvent {
  eventKind: 1;
  name: "contractRolled";
  rolledAtUtc: bigint;
  previous: InstrumentIdentity;
  next: InstrumentIdentity;
}

export interface UnknownEvent {
  eventKind: number;
  name: "unknown";
  bytes: number;
}

/** Frame type 2 (schema/wire-v1.md, "type 2 - event"). Unknown kinds stay opaque. */
export interface EventPayload {
  kind: "event";
  event: ContractRolledEvent | UnknownEvent;
}

export interface HeartbeatPayload {
  kind: "heartbeat";
}

/**
 * One handler's latency summary from the step-2 snapshot block. Nanoseconds, quantised to two
 * significant digits by the AddOn's log-linear histogram (highest value of the bucket); `maxNs`
 * is exact. A latency field is null when the wire carries the 0xFFFFFFFF "unavailable"
 * sentinel (empty histogram); it is never reported as 0. Allocation figures are -1n when not
 * measured (runtime lacks the counter, or the probe has not run yet); 0n always means measured
 * zero bytes. The allocation counter is thread-wide, see schema/wire-v1.md.
 */
export interface HandlerLatency {
  p50Ns: number | null;
  p99Ns: number | null;
  p999Ns: number | null;
  maxNs: number | null;
  sampleCount: bigint;
  allocBytesPer1024: bigint;
  allocBytesTotal: bigint;
}

/** Publisher frame-serialize timing; one histogram across all instruments. */
export interface SerializeLatency {
  p50Ns: number | null;
  p99Ns: number | null;
  p999Ns: number | null;
  maxNs: number | null;
  sampleCount: bigint;
}

/** u32 nanosecond sentinel meaning "no figure" (schema/wire-v1.md, step-2 block). */
export const NS_UNAVAILABLE = 0xffffffff;

/** Largest measured value a u32 nanosecond field can carry; the AddOn saturates here. */
export const NS_SATURATED = 0xfffffffe;

function readNs(payload: Buffer, at: number): number | null {
  const v = payload.readUInt32LE(at);
  return v === NS_UNAVAILABLE ? null : v;
}

/** Build step 2 instrumentation block, schema/wire-v1.md "step-2 block", offsets +24..+159. */
export interface SnapshotInstrumentation {
  data: HandlerLatency;
  depth: HandlerLatency;
  publisherAllocBytesTotal: bigint;
  serialize: SerializeLatency;
  stopwatchFrequency: bigint;
  ringDropsTotal: bigint;
  sampleOverrunsTotal: bigint;
}

/**
 * Snapshot payload. The step-1 block is always present; `instrumentation` is null when the
 * publisher sent the 24-byte step-1 payload and present when it sent the 160-byte step-2 one.
 * Nothing about the market is computed yet.
 */
export interface SnapshotPayload {
  kind: "snapshot";
  eventsDrained: bigint;
  bytesAllocatedOnPublisher: bigint;
  handlerSamples: bigint;
  instrumentation: SnapshotInstrumentation | null;
}

export interface UnknownPayload {
  kind: "unknown";
  type: number;
  bytes: number;
}

export type Payload = HelloPayload | HeartbeatPayload | SnapshotPayload | EventPayload | UnknownPayload;

export interface Frame {
  header: FrameHeader;
  payload: Payload;
}

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

/** Converts .NET UTC ticks to milliseconds since the Unix epoch. */
export function dotnetTicksToUnixMs(ticks: bigint): number {
  return Number((ticks - DOTNET_TICKS_AT_UNIX_EPOCH) / 10_000n);
}

/** ISO-8601 UTC timestamp for a non-zero .NET ticks value, null for the 0n "never" sentinel. */
export function dotnetTicksToIso(ticks: bigint): string | null {
  if (ticks === 0n) return null;
  return new Date(dotnetTicksToUnixMs(ticks)).toISOString();
}

/** Calendar date (YYYY-MM-DD) for an expiryTicks value, null for the 0n "never expires" sentinel. */
export function expiryTicksToDate(ticks: bigint): string | null {
  if (ticks === 0n) return null;
  return new Date(dotnetTicksToUnixMs(ticks)).toISOString().slice(0, 10);
}

export function decodeHeader(buf: Buffer): FrameHeader {
  if (buf.length < LENGTH_PREFIX_BYTES + HEADER_BYTES) {
    throw new WireError(`frame too short for header: ${buf.length} bytes`);
  }
  const length = buf.readUInt32LE(0);
  return {
    length,
    type: buf.readUInt16LE(4),
    version: buf.readUInt16LE(6),
    sequence: buf.readUInt32LE(8),
    ringEventsDropped: buf.readUInt32LE(12),
    sentTicks: buf.readBigInt64LE(16),
    wallUtc: buf.readBigInt64LE(24),
    instrument: buf.readUInt16LE(32),
    reserved: buf.readUInt16LE(34),
  };
}

/**
 * Decodes exactly one complete frame. `buf` must start at the length field and contain
 * `4 + length` bytes; trailing bytes are rejected so a caller cannot silently mis-split.
 */
export function decodeFrame(buf: Buffer): Frame {
  const header = decodeHeader(buf);

  if (header.length + LENGTH_PREFIX_BYTES > MAX_FRAME_BYTES) {
    throw new WireError(`frame exceeds maxFrameBytes: ${header.length + LENGTH_PREFIX_BYTES}`);
  }
  if (buf.length !== LENGTH_PREFIX_BYTES + header.length) {
    throw new WireError(
      `frame buffer is ${buf.length} bytes, header declares ${LENGTH_PREFIX_BYTES + header.length}`,
    );
  }
  if (header.version !== SCHEMA_VERSION) {
    throw new WireError(`unsupported schema version ${header.version}`);
  }

  const payload = buf.subarray(LENGTH_PREFIX_BYTES + HEADER_BYTES);

  switch (header.type) {
    case FrameType.Hello:
      return { header, payload: decodeHello(payload) };
    case FrameType.Heartbeat:
      if (payload.length !== 0) {
        throw new WireError(`heartbeat payload must be empty, got ${payload.length} bytes`);
      }
      return { header, payload: { kind: "heartbeat" } };
    case FrameType.Snapshot:
      return { header, payload: decodeSnapshot(payload) };
    case FrameType.Event:
      return { header, payload: decodeEvent(payload) };
    default:
      return {
        header,
        payload: { kind: "unknown", type: header.type, bytes: payload.length },
      };
  }
}

/** u64 stopwatchFrequency + u16 count, before the first instrument entry. */
export const HELLO_HEADER_BYTES = 10;

function decodeHello(payload: Buffer): HelloPayload {
  if (payload.length < HELLO_HEADER_BYTES) {
    throw new WireError("hello payload shorter than its fixed header");
  }
  const stopwatchFrequency = payload.readBigUInt64LE(0);
  if (stopwatchFrequency <= 0n) {
    throw new WireError(`hello declares a non-positive stopwatchFrequency: ${stopwatchFrequency}`);
  }
  const count = payload.readUInt16LE(8);
  const instruments: HelloInstrument[] = [];
  let p = HELLO_HEADER_BYTES;

  for (let i = 0; i < count; i++) {
    if (p + 3 > payload.length) {
      throw new WireError(`hello truncated at instrument ${i}`);
    }
    const index = payload.readUInt16LE(p);
    const nameLen = payload.readUInt8(p + 2);
    const entryEnd = p + 3 + nameLen + 16;
    if (entryEnd > payload.length) {
      throw new WireError(`hello truncated inside instrument ${i}`);
    }
    const name = payload.toString("ascii", p + 3, p + 3 + nameLen);
    const tickSize = payload.readDoubleLE(p + 3 + nameLen);
    const pointValue = payload.readDoubleLE(p + 3 + nameLen + 8);
    instruments.push({ index, name, tickSize, pointValue, identity: null });
    p = entryEnd;
  }

  // Step-1/step-2 publisher: the payload ends with the base table.
  if (p === payload.length) {
    return { kind: "hello", stopwatchFrequency, instruments, identityPresent: false, unresolved: [] };
  }

  // Step-2.5 identity section (schema/wire-v1.md, "identity section").
  const cursor = { at: p };
  const identityCount = readU16(payload, cursor, "hello identityCount");
  if (identityCount !== count) {
    throw new WireError(`hello identityCount ${identityCount} does not match count ${count}`);
  }
  for (let i = 0; i < identityCount; i++) {
    const index = readU16(payload, cursor, `hello identity ${i} index`);
    const identity = decodeIdentity(payload, cursor, `hello identity ${i}`);
    const inst = instruments[i];
    if (!inst || inst.index !== index) {
      throw new WireError(`hello identity ${i} names index ${index}, base entry has ${inst?.index}`);
    }
    if (identity.fullName !== inst.name) {
      throw new WireError(
        `hello identity ${i} fullName "${identity.fullName}" differs from base name "${inst.name}"`,
      );
    }
    inst.identity = identity;
  }

  const unresolvedCount = readU16(payload, cursor, "hello unresolvedCount");
  const unresolved: UnresolvedInstrument[] = [];
  for (let i = 0; i < unresolvedCount; i++) {
    const typed = readStr8(payload, cursor, `hello unresolved ${i} typed`);
    const reason = readStr8(payload, cursor, `hello unresolved ${i} reason`);
    unresolved.push({ typed, reason });
  }

  if (cursor.at !== payload.length) {
    throw new WireError(`hello has ${payload.length - cursor.at} trailing bytes`);
  }
  return { kind: "hello", stopwatchFrequency, instruments, identityPresent: true, unresolved };
}

interface Cursor {
  at: number;
}

function need(payload: Buffer, cursor: Cursor, bytes: number, what: string): void {
  if (cursor.at + bytes > payload.length) {
    throw new WireError(`${what}: truncated at byte ${cursor.at}`);
  }
}

function readU8(payload: Buffer, cursor: Cursor, what: string): number {
  need(payload, cursor, 1, what);
  const v = payload.readUInt8(cursor.at);
  cursor.at += 1;
  return v;
}

function readU16(payload: Buffer, cursor: Cursor, what: string): number {
  need(payload, cursor, 2, what);
  const v = payload.readUInt16LE(cursor.at);
  cursor.at += 2;
  return v;
}

function readI64(payload: Buffer, cursor: Cursor, what: string): bigint {
  need(payload, cursor, 8, what);
  const v = payload.readBigInt64LE(cursor.at);
  cursor.at += 8;
  return v;
}

function readF64(payload: Buffer, cursor: Cursor, what: string): number {
  need(payload, cursor, 8, what);
  const v = payload.readDoubleLE(cursor.at);
  cursor.at += 8;
  return v;
}

function readStr8(payload: Buffer, cursor: Cursor, what: string): string {
  const len = readU8(payload, cursor, what);
  need(payload, cursor, len, what);
  const s = payload.toString("ascii", cursor.at, cursor.at + len);
  cursor.at += len;
  return s;
}

const SHAPES: Record<number, InstrumentShape> = { 1: "fullyQualified", 2: "root", 3: "direct" };
const METHODS: Record<number, ResolutionMethod> = {
  1: "asTyped",
  2: "nt8Default",
  3: "rolloverTable",
  4: "nextExpiry",
};

/** Identity block (schema/wire-v1.md, "identity block"): 43 fixed bytes plus seven strings. */
export function decodeIdentity(payload: Buffer, cursor: Cursor, what: string): InstrumentIdentity {
  const shapeCode = readU8(payload, cursor, `${what} shape`);
  const resolvedByCode = readU8(payload, cursor, `${what} resolvedBy`);
  const resolvedFrom = readStr8(payload, cursor, `${what} resolvedFrom`);
  const fullName = readStr8(payload, cursor, `${what} fullName`);
  const masterName = readStr8(payload, cursor, `${what} masterName`);
  const instrumentType = readStr8(payload, cursor, `${what} instrumentType`);
  const exchange = readStr8(payload, cursor, `${what} exchange`);
  const currency = readStr8(payload, cursor, `${what} currency`);
  const tradingHours = readStr8(payload, cursor, `${what} tradingHours`);
  const expiryTicks = readI64(payload, cursor, `${what} expiryTicks`);
  const tickSize = readF64(payload, cursor, `${what} tickSize`);
  const pointValue = readF64(payload, cursor, `${what} pointValue`);
  const rolledAtUtc = readI64(payload, cursor, `${what} rolledAtUtc`);
  const rollCount = readU16(payload, cursor, `${what} rollCount`);
  return {
    shape: SHAPES[shapeCode] ?? "unknown",
    shapeCode,
    resolvedBy: METHODS[resolvedByCode] ?? "unknown",
    resolvedByCode,
    resolvedFrom,
    fullName,
    masterName,
    instrumentType,
    exchange,
    currency,
    tradingHours,
    expiryTicks,
    tickSize,
    pointValue,
    rolledAtUtc,
    rollCount,
  };
}

/** u16 eventKind + u16 reserved, before the body. */
export const EVENT_HEADER_BYTES = 4;

function decodeEvent(payload: Buffer): EventPayload {
  if (payload.length < EVENT_HEADER_BYTES) {
    throw new WireError("event payload shorter than its fixed header");
  }
  const eventKind = payload.readUInt16LE(0);
  const cursor: Cursor = { at: EVENT_HEADER_BYTES };

  if (eventKind === EventKind.ContractRolled) {
    const rolledAtUtc = readI64(payload, cursor, "contractRolled rolledAtUtc");
    const previous = decodeIdentity(payload, cursor, "contractRolled previous");
    const next = decodeIdentity(payload, cursor, "contractRolled next");
    if (cursor.at !== payload.length) {
      throw new WireError(`contractRolled has ${payload.length - cursor.at} trailing bytes`);
    }
    return {
      kind: "event",
      event: { eventKind: EventKind.ContractRolled, name: "contractRolled", rolledAtUtc, previous, next },
    };
  }

  return {
    kind: "event",
    event: { eventKind, name: "unknown", bytes: payload.length - EVENT_HEADER_BYTES },
  };
}

/** Step-1 snapshot payload: 24 bytes, three u64 counters. */
export const SNAPSHOT_PAYLOAD_BYTES = 24;

/** Step-2 snapshot payload: the step-1 block plus 136 bytes of instrumentation. */
export const SNAPSHOT_STEP2_PAYLOAD_BYTES = 160;

function decodeSnapshot(payload: Buffer): SnapshotPayload {
  if (payload.length !== SNAPSHOT_PAYLOAD_BYTES && payload.length !== SNAPSHOT_STEP2_PAYLOAD_BYTES) {
    throw new WireError(
      `snapshot payload must be ${SNAPSHOT_PAYLOAD_BYTES} or ${SNAPSHOT_STEP2_PAYLOAD_BYTES} bytes, got ${payload.length}`,
    );
  }
  return {
    kind: "snapshot",
    eventsDrained: payload.readBigUInt64LE(0),
    bytesAllocatedOnPublisher: payload.readBigUInt64LE(8),
    handlerSamples: payload.readBigUInt64LE(16),
    instrumentation:
      payload.length === SNAPSHOT_STEP2_PAYLOAD_BYTES ? decodeInstrumentation(payload) : null,
  };
}

function decodeHandlerLatency(payload: Buffer, at: number, allocAt: number): HandlerLatency {
  return {
    p50Ns: readNs(payload, at),
    p99Ns: readNs(payload, at + 4),
    p999Ns: readNs(payload, at + 8),
    maxNs: readNs(payload, at + 12),
    sampleCount: payload.readBigUInt64LE(at + 16),
    allocBytesPer1024: payload.readBigInt64LE(allocAt),
    allocBytesTotal: payload.readBigInt64LE(allocAt + 8),
  };
}

function decodeInstrumentation(payload: Buffer): SnapshotInstrumentation {
  const stopwatchFrequency = payload.readBigUInt64LE(136);
  if (stopwatchFrequency <= 0n) {
    throw new WireError(`snapshot declares a non-positive stopwatchFrequency: ${stopwatchFrequency}`);
  }
  return {
    data: decodeHandlerLatency(payload, 24, 72),
    depth: decodeHandlerLatency(payload, 48, 88),
    publisherAllocBytesTotal: payload.readBigInt64LE(104),
    serialize: {
      p50Ns: readNs(payload, 112),
      p99Ns: readNs(payload, 116),
      p999Ns: readNs(payload, 120),
      maxNs: readNs(payload, 124),
      sampleCount: payload.readBigUInt64LE(128),
    },
    stopwatchFrequency,
    ringDropsTotal: payload.readBigUInt64LE(144),
    sampleOverrunsTotal: payload.readBigUInt64LE(152),
  };
}
