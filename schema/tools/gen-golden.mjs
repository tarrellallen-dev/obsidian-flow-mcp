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
const TYPE_EVENT = 2;
const TYPE_HELLO = 3;
const TYPE_HEARTBEAT = 4;

const EVENT_CONTRACT_ROLLED = 1;

// Every instrument name in this file is an EXAMPLE fixture. The AddOn hardcodes no contract
// month; see addon/README.md "Instrument names".

function frame({ type, sequence, ringEventsDropped, sentTicks, wallUtc, instrument, payload }) {
  const buf = Buffer.alloc(4 + HEADER_BYTES + payload.length);
  buf.writeUInt32LE(HEADER_BYTES + payload.length, 0);
  buf.writeUInt16LE(type, 4);
  buf.writeUInt16LE(VERSION, 6);
  buf.writeUInt32LE(sequence, 8);
  buf.writeUInt32LE(ringEventsDropped, 12);
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

function str8(s) {
  const b = Buffer.from(s ?? "", "ascii");
  if (b.length > 255) throw new Error("string too long for u8 length");
  return Buffer.concat([Buffer.from([b.length]), b]);
}

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

// Base table only (steps 1 and 2). Byte-identical to what a step-2 publisher sends.
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

// .NET ticks (100 ns since 0001-01-01) of a calendar date at 00:00, no time zone.
const DOTNET_TICKS_AT_UNIX_EPOCH = 621_355_968_000_000_000n;
function dateTicks(year, month, day) {
  return BigInt(Date.UTC(year, month - 1, day)) * 10_000n + DOTNET_TICKS_AT_UNIX_EPOCH;
}

const SHAPE = { fullyQualified: 1, root: 2, direct: 3 };
const RESOLVED_BY = { asTyped: 1, nt8Default: 2, rolloverTable: 3, nextExpiry: 4 };

// Identity block, schema/wire-v1.md "identity block". Same bytes in the hello and the event.
function identityBlock(id) {
  const fixed = Buffer.alloc(8 + 8 + 8 + 8 + 2);
  fixed.writeBigInt64LE(id.expiryTicks, 0);
  fixed.writeDoubleLE(id.tickSize, 8);
  fixed.writeDoubleLE(id.pointValue, 16);
  fixed.writeBigInt64LE(id.rolledAtUtc ?? 0n, 24);
  fixed.writeUInt16LE(id.rollCount ?? 0, 32);
  return Buffer.concat([
    Buffer.from([SHAPE[id.shape], RESOLVED_BY[id.resolvedBy]]),
    str8(id.resolvedFrom),
    str8(id.name),
    str8(id.masterName),
    str8(id.instrumentType),
    str8(id.exchange),
    str8(id.currency),
    str8(id.tradingHours),
    fixed,
  ]);
}

// Step-2.5 hello: base table, then the identity section (identities in table order, then the
// unresolved config entries).
function helloPayloadWithIdentity(instruments, unresolved, stopwatchFrequency = STOPWATCH_FREQUENCY) {
  const parts = [helloPayload(instruments, stopwatchFrequency)];
  parts.push(u16(instruments.length));
  for (const inst of instruments) {
    parts.push(u16(inst.index), identityBlock(inst));
  }
  parts.push(u16(unresolved.length));
  for (const u of unresolved) {
    parts.push(str8(u.typed), str8(u.reason));
  }
  return Buffer.concat(parts);
}

function contractRolledPayload(previous, next) {
  const head = Buffer.alloc(12);
  head.writeUInt16LE(EVENT_CONTRACT_ROLLED, 0);
  head.writeUInt16LE(0, 2);
  head.writeBigInt64LE(next.rolledAtUtc, 4);
  return Buffer.concat([head, identityBlock(previous), identityBlock(next)]);
}

// Step-1 snapshot payload: 24 bytes. Still a valid snapshot in step 2 (the decoder accepts
// both sizes), so this stays byte-identical.
function snapshotPayload({ eventsDrained, bytesAllocatedOnPublisher, handlerSamples }) {
  const buf = Buffer.alloc(24);
  buf.writeBigUInt64LE(eventsDrained, 0);
  buf.writeBigUInt64LE(bytesAllocatedOnPublisher, 8);
  buf.writeBigUInt64LE(handlerSamples, 16);
  return buf;
}

// Step-2 snapshot payload: the step-1 block followed by 136 bytes of instrumentation,
// offsets per schema/wire-v1.md "step-2 block". u32 ns fields reserve 0xFFFFFFFF for
// "unavailable" and saturate at 0xFFFFFFFE; i64 alloc fields carry -1 for "not measured".
const NS_UNAVAILABLE = 0xffffffff;
const NS_SATURATED = 0xfffffffe;
function snapshotPayloadStep2(step1, s2) {
  const head = snapshotPayload(step1);
  const buf = Buffer.alloc(136);
  let p = 0;
  const u32 = (v) => { buf.writeUInt32LE(v, p); p += 4; };
  const u64 = (v) => { buf.writeBigUInt64LE(v, p); p += 8; };
  const i64 = (v) => { buf.writeBigInt64LE(v, p); p += 8; };
  u32(s2.data.p50); u32(s2.data.p99); u32(s2.data.p999); u32(s2.data.max);   // +24 .. +39
  u64(s2.data.count);                                                          // +40
  u32(s2.depth.p50); u32(s2.depth.p99); u32(s2.depth.p999); u32(s2.depth.max); // +48 .. +63
  u64(s2.depth.count);                                                         // +64
  i64(s2.data.allocPer1024); i64(s2.data.allocTotal);                          // +72, +80
  i64(s2.depth.allocPer1024); i64(s2.depth.allocTotal);                        // +88, +96
  i64(s2.publisherAllocTotal);                                                 // +104
  u32(s2.serialize.p50); u32(s2.serialize.p99); u32(s2.serialize.p999); u32(s2.serialize.max); // +112 .. +127
  u64(s2.serialize.count);                                                     // +128
  u64(s2.stopwatchFrequency);                                                  // +136
  u64(s2.ringDropsTotal);                                                      // +144
  u64(s2.sampleOverrunsTotal);                                                 // +152
  if (p !== 136) throw new Error("step-2 block is " + p + " bytes, expected 136");
  return Buffer.concat([head, buf]);
}

// Fixed values so the files are byte-stable across regenerations.
const SENT = 1234567890123n;
const WALL = 638000000000000000n;

// Step-2 hello, base table only. Kept byte-identical (it was hello.bin through step 2) so the
// decoder keeps accepting a publisher that predates the identity section. Example names.
const helloBase = frame({
  type: TYPE_HELLO,
  sequence: 0,
  ringEventsDropped: 0,
  sentTicks: SENT,
  wallUtc: WALL,
  instrument: INSTRUMENT_NONE,
  payload: helloPayload([
    { index: 0, name: "ES 06-26", tickSize: 0.25, pointValue: 50 },
    { index: 1, name: "NQ 06-26", tickSize: 0.25, pointValue: 20 },
  ]),
});

// Step-2.5 hello. Three config shapes, one unresolved entry. All names are examples.
const esFront = {
  index: 0,
  name: "ES 12-26",
  tickSize: 0.25,
  pointValue: 50,
  shape: "root",
  resolvedBy: "nt8Default",
  resolvedFrom: "ES",
  masterName: "ES",
  instrumentType: "Future",
  exchange: "Globex",
  currency: "UsDollar",
  tradingHours: "CME US Index Futures ETH",
  expiryTicks: dateTicks(2026, 12, 18),
  rolledAtUtc: 0n,
  rollCount: 0,
};
const nqQualified = {
  index: 1,
  name: "NQ 03-27",
  tickSize: 0.25,
  pointValue: 20,
  shape: "fullyQualified",
  resolvedBy: "asTyped",
  resolvedFrom: "NQ 03-27",
  masterName: "NQ",
  instrumentType: "Future",
  exchange: "Globex",
  currency: "UsDollar",
  tradingHours: "CME US Index Futures ETH",
  expiryTicks: dateTicks(2027, 3, 19),
  rolledAtUtc: 0n,
  rollCount: 0,
};
const eurusd = {
  index: 2,
  name: "EURUSD",
  tickSize: 0.00001,
  pointValue: 100000,
  shape: "direct",
  resolvedBy: "asTyped",
  resolvedFrom: "EURUSD",
  masterName: "EURUSD",
  instrumentType: "Forex",
  exchange: "Default",
  currency: "UsDollar",
  tradingHours: "Forex",
  expiryTicks: 0n,
  rolledAtUtc: 0n,
  rollCount: 0,
};
const unresolved = [{ typed: "XYZ", reason: "not in the NinjaTrader instrument database: XYZ" }];

const hello = frame({
  type: TYPE_HELLO,
  sequence: 0,
  ringEventsDropped: 0,
  sentTicks: SENT,
  wallUtc: WALL,
  instrument: INSTRUMENT_NONE,
  payload: helloPayloadWithIdentity([esFront, nqQualified, eurusd], unresolved),
});

// The same table after index 0 rolled: nothing moves, the identity at 0 is replaced.
const ROLLED_AT = WALL + 60_000_000_000n; // 100 minutes after WALL, in .NET ticks
const esNext = {
  ...esFront,
  name: "ES 03-27",
  resolvedBy: "rolloverTable",
  expiryTicks: dateTicks(2027, 3, 19),
  rolledAtUtc: ROLLED_AT,
  rollCount: 1,
};

const helloRolled = frame({
  type: TYPE_HELLO,
  sequence: 6,
  ringEventsDropped: 0,
  sentTicks: SENT + 60_000_000n,
  wallUtc: ROLLED_AT,
  instrument: INSTRUMENT_NONE,
  payload: helloPayloadWithIdentity([esNext, nqQualified, eurusd], unresolved),
});

const eventContractRolled = frame({
  type: TYPE_EVENT,
  sequence: 7,
  ringEventsDropped: 0,
  sentTicks: SENT + 60_000_001n,
  wallUtc: ROLLED_AT,
  instrument: 0,
  payload: contractRolledPayload(esFront, esNext),
});

const helloEmpty = frame({
  type: TYPE_HELLO,
  sequence: 0,
  ringEventsDropped: 0,
  sentTicks: SENT,
  wallUtc: WALL,
  instrument: INSTRUMENT_NONE,
  payload: helloPayload([]),
});

const heartbeat = frame({
  type: TYPE_HEARTBEAT,
  sequence: 1,
  ringEventsDropped: 0,
  sentTicks: SENT + 10_000_000n,
  wallUtc: WALL + 10_000_000n,
  instrument: INSTRUMENT_NONE,
  payload: Buffer.alloc(0),
});

const snapshot = frame({
  type: TYPE_SNAPSHOT,
  sequence: 2,
  ringEventsDropped: 7,
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
  ringEventsDropped: 0,
  sentTicks: SENT + 30_000_000n,
  wallUtc: WALL + 30_000_000n,
  instrument: 0,
  payload: snapshotPayload({
    eventsDrained: 1n,
    bytesAllocatedOnPublisher: 0n,
    handlerSamples: 2n,
  }),
});

const snapshotStep2 = frame({
  type: TYPE_SNAPSHOT,
  sequence: 4,
  ringEventsDropped: 3,
  sentTicks: SENT + 40_000_000n,
  wallUtc: WALL + 40_000_000n,
  instrument: 1,
  payload: snapshotPayloadStep2(
    { eventsDrained: 987654321n, bytesAllocatedOnPublisher: 8192n, handlerSamples: 300000n },
    {
      data: { p50: 1299, p99: 8999, p999: 45999, max: 71234, count: 200000n, allocPer1024: 0n, allocTotal: 1536n },
      depth: { p50: 999, p99: 4599, p999: 12999, max: 30001, count: 100000n, allocPer1024: 0n, allocTotal: 0n },
      publisherAllocTotal: 8192n,
      serialize: { p50: 2099, p99: 6999, p999: 19999, max: NS_SATURATED, count: 12345n },
      stopwatchFrequency: STOPWATCH_FREQUENCY,
      ringDropsTotal: 3n,
      sampleOverrunsTotal: 0n,
    },
  ),
});

// Every allocation figure -1: the host runtime did not expose the per-thread counter. The
// step-1 u64 field is 0 in that case by its own definition. The data and serialize histograms
// are empty, so their latency fields carry the 0xFFFFFFFF "unavailable" sentinel, never 0.
const snapshotStep2Unavailable = frame({
  type: TYPE_SNAPSHOT,
  sequence: 5,
  ringEventsDropped: 0,
  sentTicks: SENT + 50_000_000n,
  wallUtc: WALL + 50_000_000n,
  instrument: 0,
  payload: snapshotPayloadStep2(
    { eventsDrained: 10n, bytesAllocatedOnPublisher: 0n, handlerSamples: 4n },
    {
      data: { p50: NS_UNAVAILABLE, p99: NS_UNAVAILABLE, p999: NS_UNAVAILABLE, max: NS_UNAVAILABLE, count: 0n, allocPer1024: -1n, allocTotal: -1n },
      depth: { p50: 109, p99: 109, p999: 109, max: 105, count: 4n, allocPer1024: -1n, allocTotal: -1n },
      publisherAllocTotal: -1n,
      serialize: { p50: NS_UNAVAILABLE, p99: NS_UNAVAILABLE, p999: NS_UNAVAILABLE, max: NS_UNAVAILABLE, count: 0n },
      stopwatchFrequency: 2_441_442n,
      ringDropsTotal: 0n,
      sampleOverrunsTotal: 7n,
    },
  ),
});

mkdirSync(OUT, { recursive: true });
// A roll mid-connection: snapshot of the old contract, re-announced hello, the boundary event,
// snapshot of the new contract, all for index 0.
const snapshotBeforeRoll = frame({
  type: TYPE_SNAPSHOT,
  sequence: 5,
  ringEventsDropped: 0,
  sentTicks: SENT + 50_000_000n,
  wallUtc: WALL + 50_000_000n,
  instrument: 0,
  payload: snapshotPayload({ eventsDrained: 500n, bytesAllocatedOnPublisher: 0n, handlerSamples: 250n }),
});
const snapshotAfterRoll = frame({
  type: TYPE_SNAPSHOT,
  sequence: 8,
  ringEventsDropped: 0,
  sentTicks: SENT + 70_000_000n,
  wallUtc: WALL + 70_000_000n,
  instrument: 0,
  payload: snapshotPayload({ eventsDrained: 510n, bytesAllocatedOnPublisher: 0n, handlerSamples: 3n }),
});

writeFileSync(join(OUT, "hello.bin"), hello);
writeFileSync(join(OUT, "hello-base.bin"), helloBase);
writeFileSync(join(OUT, "hello-empty.bin"), helloEmpty);
writeFileSync(join(OUT, "hello-rolled.bin"), helloRolled);
writeFileSync(join(OUT, "event-contract-rolled.bin"), eventContractRolled);
writeFileSync(join(OUT, "heartbeat.bin"), heartbeat);
writeFileSync(join(OUT, "snapshot.bin"), snapshot);
writeFileSync(join(OUT, "stream.bin"), Buffer.concat([helloBase, heartbeat, snapshot, snapshot0]));
writeFileSync(join(OUT, "snapshot-step2.bin"), snapshotStep2);
writeFileSync(join(OUT, "snapshot-step2-unavailable.bin"), snapshotStep2Unavailable);
writeFileSync(join(OUT, "stream-step2.bin"), Buffer.concat([helloBase, heartbeat, snapshotStep2, snapshot0]));
writeFileSync(
  join(OUT, "stream-roll.bin"),
  Buffer.concat([hello, snapshotBeforeRoll, helloRolled, eventContractRolled, snapshotAfterRoll]),
);

console.log("wrote golden files to", OUT);
