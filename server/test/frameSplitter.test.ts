/**
 * Frame splitter: the only component that knows the transport is a byte stream. Fuzzed against
 * random chunk boundaries with a seeded PRNG so a failure is reproducible.
 */

import { describe, expect, it } from "vitest";

import { FrameSplitter } from "../src/transport/frameSplitter.js";
import { decodeFrame, HEADER_BYTES, MAX_FRAME_BYTES, WireError } from "../src/wire/decoder.js";

/** mulberry32: small, deterministic, good enough to shuffle chunk boundaries. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFrame(type: number, sequence: number, payloadBytes: number): Buffer {
  const buf = Buffer.alloc(4 + HEADER_BYTES + payloadBytes);
  buf.writeUInt32LE(HEADER_BYTES + payloadBytes, 0);
  buf.writeUInt16LE(type, 4);
  buf.writeUInt16LE(1, 6);
  buf.writeUInt32LE(sequence, 8);
  buf.writeUInt32LE(0, 12);
  buf.writeBigInt64LE(BigInt(sequence) * 1000n, 16);
  buf.writeBigInt64LE(638_000_000_000_000_000n, 24);
  buf.writeUInt16LE(sequence % 3, 32);
  buf.writeUInt16LE(0, 34);
  for (let i = 0; i < payloadBytes; i++) buf[4 + HEADER_BYTES + i] = (sequence + i) & 0xff;
  return buf;
}

function chunkRandomly(stream: Buffer, rand: () => number): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < stream.length) {
    const remaining = stream.length - offset;
    // 1..(remaining) bytes, skewed small so partial headers happen often.
    const size = 1 + Math.floor(rand() * Math.min(remaining, 40));
    chunks.push(stream.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}

describe("FrameSplitter", () => {
  it("emits nothing until a frame is complete", () => {
    const splitter = new FrameSplitter();
    const frame = makeFrame(4, 0, 0);
    expect(splitter.push(frame.subarray(0, 2))).toEqual([]);
    expect(splitter.push(frame.subarray(2, 10))).toEqual([]);
    expect(splitter.pending).toBe(10);
    const out = splitter.push(frame.subarray(10));
    expect(out).toHaveLength(1);
    expect(out[0]!.equals(frame)).toBe(true);
    expect(splitter.pending).toBe(0);
  });

  it("emits several frames coalesced into one chunk", () => {
    const splitter = new FrameSplitter();
    const stream = Buffer.concat([makeFrame(4, 0, 0), makeFrame(1, 1, 24), makeFrame(4, 2, 0)]);
    expect(splitter.push(stream)).toHaveLength(3);
  });

  it("reassembles a fuzzed stream byte-for-byte, for 200 seeds", () => {
    const frames: Buffer[] = [];
    for (let i = 0; i < 40; i++) {
      const type = i % 3 === 0 ? 4 : 1;
      frames.push(makeFrame(type, i, type === 4 ? 0 : 24));
    }
    const stream = Buffer.concat(frames);

    for (let seed = 1; seed <= 200; seed++) {
      const splitter = new FrameSplitter();
      const rand = prng(seed);
      const collected: Buffer[] = [];
      for (const chunk of chunkRandomly(stream, rand)) {
        collected.push(...splitter.push(chunk));
      }

      expect(splitter.pending, `seed ${seed} left bytes buffered`).toBe(0);
      expect(collected.length, `seed ${seed} frame count`).toBe(frames.length);
      for (let i = 0; i < frames.length; i++) {
        expect(collected[i]!.equals(frames[i]!), `seed ${seed} frame ${i}`).toBe(true);
        // Every emitted buffer must still decode: the copy-on-consume must not have
        // invalidated frames handed out earlier in the same push.
        expect(decodeFrame(collected[i]!).header.sequence).toBe(i);
      }
    }
  });

  it("survives a stream delivered one byte at a time", () => {
    const frames = [makeFrame(3, 0, 2), makeFrame(1, 1, 24), makeFrame(4, 2, 0)];
    const stream = Buffer.concat(frames);
    const splitter = new FrameSplitter();
    const collected: Buffer[] = [];
    for (const byte of stream) collected.push(...splitter.push(Buffer.from([byte])));
    expect(collected).toHaveLength(3);
    expect(collected[1]!.equals(frames[1]!)).toBe(true);
  });

  it("throws and resets when a declared frame exceeds maxFrameBytes", () => {
    const splitter = new FrameSplitter();
    const bad = Buffer.alloc(8);
    bad.writeUInt32LE(MAX_FRAME_BYTES, 0);
    expect(() => splitter.push(bad)).toThrow(WireError);
    expect(splitter.pending).toBe(0);
  });

  it("honours a lowered maxFrameBytes", () => {
    const splitter = new FrameSplitter(64);
    expect(() => splitter.push(makeFrame(1, 0, 256))).toThrow(/maxFrameBytes/);
  });
});
