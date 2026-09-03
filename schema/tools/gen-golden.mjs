// Reference encoder for wire v1, written from schema/wire-v1.md and deliberately independent
// of server/src/wire/decoder.ts. Regenerate with:
//
//   node schema/tools/gen-golden.mjs
//
// The generated files are committed. If a change to the decoder makes the golden test fail,
// fix the decoder or amend wire-v1.md and this encoder together - never regenerate to make a
// red test green.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "golden");

const HEADER_BYTES = 32;
const VERSION = 1;
const INSTRUMENT_NONE = 0xffff;

const TYPE_SNAPSHOT = 1;
const TYPE_HELLO = 3;
const TYPE_HEARTBEAT = 4;

function frame({ type, sequence, dropped, sentTicks, wallUtc, instrument, payload }) {
  const buf = Buffer.alloc(4 + HEADER_BYTES + payload.length);
  buf.writeUInt32LE(HEADER_BYTES + payload.length, 0);
  buf.writeUInt16LE(type, 4);
  buf.writeUInt16LE(VERSION, 6);
  buf.writeUInt32LE(sequence, 8);
  buf.writeUInt32LE(dropped, 12);
  buf.writeBigInt64LE(sentTicks, 16);
  buf.writeBigInt64LE(wallUtc, 24);
  buf.writeUInt16LE(instrument, 32);
  buf.writeUInt16LE(0, 34);
  payload.copy(buf, 4 + HEADER_BYTES);
  return buf;
}

// Windows QPC is commonly 10 MHz, but the value is machine-dependent and the client must never
// assume it - which is exactly why it is on the wire.
const STOPWATCH_FREQUENCY = 10_000_000n;

function helloPayload(instruments, stopwatchFrequency = STOPWATCH_FREQUENCY) {
  const parts = [];
  const head = Buffer.alloc(10);
  head.writeBigUInt64LE(stopwatchFrequency, 0);
  head.writeUInt16LE(instruments.length, 8);
  parts.push(head);

  for (const inst of instruments) {
    const name = Buffer.from(inst.name, "ascii");
    if (name.length > 255) throw new Error("instrument name too long");
    const entry = Buffer.alloc(19 + name.length);
    entry.writeUInt16LE(inst.index, 0);
    entry.writeUInt8(name.length, 2);
    name.copy(entry, 3);
    entry.writeDoubleLE(inst.tickSize, 3 + name.length);
    entry.writeDoubleLE(inst.pointValue, 11 + name.length);
    parts.push(entry);
  }
  return Buffer.concat(parts);
}

function snapshotPayload({ eventsDrained, bytesAllocatedOnPublisher, handlerSamples }) {
  const buf = Buffer.alloc(24);
  buf.writeBigUInt64LE(eventsDrained, 0);
  buf.writeBigUInt64LE(bytesAllocatedOnPublisher, 8);
  buf.writeBigUInt64LE(handlerSamples, 16);
  return buf;
}

// Fixed values so the files are byte-stable across regenerations.
const SENT = 1234567890123n;
const WALL = 638000000000000000n;

const hello = frame({
  type: TYPE_HELLO,
  sequence: 0,
  dropped: 0,
  sentTicks: SENT,
  wallUtc: WALL,
  instrument: INSTRUMENT_NONE,
  payload: helloPayload([
    { index: 0, name: "ES 06-26", tickSize: 0.25, pointValue: 50 },
    { index: 1, name: "NQ 06-26", tickSize: 0.25, pointValue: 20 },
  ]),
});

const helloEmpty = frame({
  type: TYPE_HELLO,
  sequence: 0,
  dropped: 0,
  sentTicks: SENT,
  wallUtc: WALL,
  instrument: INSTRUMENT_NONE,
  payload: helloPayload([]),
});

const heartbeat = frame({
  type: TYPE_HEARTBEAT,
  sequence: 1,
  dropped: 0,
  sentTicks: SENT + 10_000_000n,
  wallUtc: WALL + 10_000_000n,
  instrument: INSTRUMENT_NONE,
  payload: Buffer.alloc(0),
});

const snapshot = frame({
  type: TYPE_SNAPSHOT,
  sequence: 2,
  dropped: 7,
  sentTicks: SENT + 20_000_000n,
  wallUtc: WALL + 20_000_000n,
  instrument: 1,
  payload: snapshotPayload({
    eventsDrained: 123456789n,
    bytesAllocatedOnPublisher: 4096n,
    handlerSamples: 65536n,
  }),
});

const snapshot0 = frame({
  type: TYPE_SNAPSHOT,
  sequence: 3,
  dropped: 0,
  sentTicks: SENT + 30_000_000n,
  wallUtc: WALL + 30_000_000n,
  instrument: 0,
  payload: snapshotPayload({
    eventsDrained: 1n,
    bytesAllocatedOnPublisher: 0n,
    handlerSamples: 2n,
  }),
});

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "hello.bin"), hello);
writeFileSync(join(OUT, "hello-empty.bin"), helloEmpty);
writeFileSync(join(OUT, "heartbeat.bin"), heartbeat);
writeFileSync(join(OUT, "snapshot.bin"), snapshot);
writeFileSync(join(OUT, "stream.bin"), Buffer.concat([hello, heartbeat, snapshot, snapshot0]));

console.log("wrote golden files to", OUT);
