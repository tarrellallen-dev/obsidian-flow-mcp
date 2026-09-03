/**
 * Golden-file test. The .bin files in schema/golden are produced by schema/tools/gen-golden.mjs,
 * an independent reference encoder written from schema/wire-v1.md. If this test fails, either
 * the decoder drifted or the layout changed; do not regenerate the golden files to make it pass.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  decodeFrame,
  decodeHeader,
  dotnetTicksToUnixMs,
  FrameType,
  HEADER_BYTES,
  HELLO_HEADER_BYTES,
  INSTRUMENT_NONE,
  MAX_FRAME_BYTES,
  SCHEMA_VERSION,
  SNAPSHOT_PAYLOAD_BYTES,
  WireError,
} from "../src/wire/decoder.js";
import { FrameSplitter } from "../src/transport/frameSplitter.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema", "golden");
const golden = (name: string) => readFileSync(join(GOLDEN, name));

describe("wire v1 golden files", () => {
  it("pins the header layout", () => {
    const buf = golden("heartbeat.bin");
    expect(buf.length).toBe(4 + HEADER_BYTES);

    const h = decodeHeader(buf);
    expect(h.length).toBe(HEADER_BYTES);
    expect(h.type).toBe(FrameType.Heartbeat);
    expect(h.version).toBe(SCHEMA_VERSION);
    expect(h.sequence).toBe(1);
    expect(h.ringEventsDropped).toBe(0);
    expect(h.instrument).toBe(INSTRUMENT_NONE);
    expect(h.reserved).toBe(0);
  });

  // Instrument names in the golden files are EXAMPLES (schema/wire-v1.md); the AddOn
  // hardcodes no contract month.
  it("decodes the step-2 base-table hello, identities absent", () => {
    const frame = decodeFrame(golden("hello-base.bin"));
    expect(frame.header.type).toBe(FrameType.Hello);
    expect(frame.header.instrument).toBe(INSTRUMENT_NONE);
    if (frame.payload.kind !== "hello") throw new Error("expected hello");

    expect(frame.payload.stopwatchFrequency).toBe(10_000_000n);
    expect(frame.payload.identityPresent).toBe(false);
    expect(frame.payload.unresolved).toEqual([]);
    expect(frame.payload.instruments).toEqual([
      { index: 0, name: "ES 06-26", tickSize: 0.25, pointValue: 50, identity: null },
      { index: 1, name: "NQ 06-26", tickSize: 0.25, pointValue: 20, identity: null },
    ]);
    // 4 length + 32 header + 10 hello header + two entries of 19 + 8 name bytes.
    expect(golden("hello-base.bin").length).toBe(4 + HEADER_BYTES + HELLO_HEADER_BYTES + 2 * (19 + 8));
  });

  it("decodes the step-2.5 hello with its identity section", () => {
    const frame = decodeFrame(golden("hello.bin"));
    if (frame.payload.kind !== "hello") throw new Error("expected hello");
    expect(frame.payload.identityPresent).toBe(true);
    expect(frame.payload.instruments.map((i) => [i.index, i.name, i.identity?.resolvedFrom])).toEqual([
      [0, "ES 12-26", "ES"],
      [1, "NQ 03-27", "NQ 03-27"],
      [2, "EURUSD", "EURUSD"],
    ]);
    expect(frame.payload.unresolved).toEqual([
      { typed: "XYZ", reason: "not in the NinjaTrader instrument database: XYZ" },
    ]);
  });

  it("decodes an empty hello", () => {
    const frame = decodeFrame(golden("hello-empty.bin"));
    if (frame.payload.kind !== "hello") throw new Error("expected hello");
    expect(frame.payload.stopwatchFrequency).toBe(10_000_000n);
    expect(frame.payload.instruments).toEqual([]);
    expect(frame.payload.identityPresent).toBe(false);
  });

  it("rejects a hello declaring a non-positive stopwatchFrequency", () => {
    const buf = Buffer.from(golden("hello-empty.bin"));
    buf.writeBigUInt64LE(0n, 4 + HEADER_BYTES);
    expect(() => decodeFrame(buf)).toThrow(/stopwatchFrequency/);
  });

  it("decodes a heartbeat as an empty payload", () => {
    const frame = decodeFrame(golden("heartbeat.bin"));
    expect(frame.payload).toEqual({ kind: "heartbeat" });
  });

  it("decodes the step-1 snapshot payload", () => {
    const buf = golden("snapshot.bin");
    expect(buf.length).toBe(4 + HEADER_BYTES + SNAPSHOT_PAYLOAD_BYTES);

    const frame = decodeFrame(buf);
    expect(frame.header.instrument).toBe(1);
    expect(frame.header.ringEventsDropped).toBe(7);
    if (frame.payload.kind !== "snapshot") throw new Error("expected snapshot");
    expect(frame.payload.eventsDrained).toBe(123456789n);
    expect(frame.payload.bytesAllocatedOnPublisher).toBe(4096n);
    expect(frame.payload.handlerSamples).toBe(65536n);
  });

  it("splits the concatenated golden stream into four frames", () => {
    const frames = new FrameSplitter().push(golden("stream.bin"));
    expect(frames.map((f) => decodeFrame(f).header.type)).toEqual([
      FrameType.Hello,
      FrameType.Heartbeat,
      FrameType.Snapshot,
      FrameType.Snapshot,
    ]);
  });

  it("converts wallUtc ticks to a sane Unix time", () => {
    const frame = decodeFrame(golden("hello.bin"));
    const ms = dotnetTicksToUnixMs(frame.header.wallUtc);
    expect(new Date(ms).getUTCFullYear()).toBe(2022);
  });
});

describe("decoder rejections", () => {
  it("rejects a truncated buffer", () => {
    expect(() => decodeFrame(golden("snapshot.bin").subarray(0, 20))).toThrow(WireError);
  });

  it("rejects a buffer with trailing bytes", () => {
    const buf = Buffer.concat([golden("snapshot.bin"), Buffer.from([0])]);
    expect(() => decodeFrame(buf)).toThrow(WireError);
  });

  it("rejects an unknown schema version", () => {
    const buf = Buffer.from(golden("heartbeat.bin"));
    buf.writeUInt16LE(99, 6);
    expect(() => decodeFrame(buf)).toThrow(/schema version/);
  });

  it("rejects a non-empty heartbeat", () => {
    const buf = Buffer.concat([golden("heartbeat.bin"), Buffer.from([1, 2, 3])]);
    buf.writeUInt32LE(HEADER_BYTES + 3, 0);
    expect(() => decodeFrame(buf)).toThrow(/heartbeat payload/);
  });

  it("rejects a snapshot payload of the wrong size", () => {
    const buf = Buffer.concat([golden("snapshot.bin"), Buffer.from([0])]);
    buf.writeUInt32LE(HEADER_BYTES + SNAPSHOT_PAYLOAD_BYTES + 1, 0);
    expect(() => decodeFrame(buf)).toThrow(/snapshot payload/);
  });

  it("rejects a declared frame above maxFrameBytes", () => {
    const buf = Buffer.from(golden("heartbeat.bin"));
    buf.writeUInt32LE(MAX_FRAME_BYTES, 0);
    expect(() => decodeFrame(buf)).toThrow(/maxFrameBytes/);
  });

  it("keeps unknown frame types as opaque rather than throwing", () => {
    const buf = Buffer.from(golden("heartbeat.bin"));
    buf.writeUInt16LE(FrameType.ExecReply, 4);
    const frame = decodeFrame(buf);
    expect(frame.payload).toEqual({ kind: "unknown", type: FrameType.ExecReply, bytes: 0 });
  });
});
