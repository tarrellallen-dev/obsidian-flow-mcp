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
  dropped: number;
  sentTicks: bigint;
  wallUtc: bigint;
  instrument: number;
  reserved: number;
}

export interface HelloInstrument {
  index: number;
  name: string;
  tickSize: number;
  pointValue: number;
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
}

export interface HeartbeatPayload {
  kind: "heartbeat";
}

/** Build step 1 snapshot payload. Nothing about the market is computed yet. */
export interface SnapshotPayload {
  kind: "snapshot";
  eventsDrained: bigint;
  bytesAllocatedOnPublisher: bigint;
  handlerSamples: bigint;
}

export interface UnknownPayload {
  kind: "unknown";
  type: number;
  bytes: number;
}

export type Payload = HelloPayload | HeartbeatPayload | SnapshotPayload | UnknownPayload;

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
    dropped: buf.readUInt32LE(12),
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
    instruments.push({ index, name, tickSize, pointValue });
    p = entryEnd;
  }

  if (p !== payload.length) {
    throw new WireError(`hello has ${payload.length - p} trailing bytes`);
  }
  return { kind: "hello", stopwatchFrequency, instruments };
}

/** Step-1 snapshot payload: 24 bytes, three u64 counters. */
export const SNAPSHOT_PAYLOAD_BYTES = 24;

function decodeSnapshot(payload: Buffer): SnapshotPayload {
  if (payload.length !== SNAPSHOT_PAYLOAD_BYTES) {
    throw new WireError(
      `snapshot payload must be ${SNAPSHOT_PAYLOAD_BYTES} bytes, got ${payload.length}`,
    );
  }
  return {
    kind: "snapshot",
    eventsDrained: payload.readBigUInt64LE(0),
    bytesAllocatedOnPublisher: payload.readBigUInt64LE(8),
    handlerSamples: payload.readBigUInt64LE(16),
  };
}
