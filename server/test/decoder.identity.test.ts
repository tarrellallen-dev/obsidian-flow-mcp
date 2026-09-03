/**
 * Step-2.5 goldens: the hello identity section, the contractRolled event and a roll
 * mid-connection. Golden files come from schema/tools/gen-golden.mjs; every step-1/step-2
 * golden other than hello.bin is byte-identical to its previous version, and the old hello.bin
 * bytes are pinned as hello-base.bin. Instrument names in the fixtures are EXAMPLES.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { StateCache } from "../src/cache/stateCache.js";
import { buildServer } from "../src/index.js";
import { FrameSplitter } from "../src/transport/frameSplitter.js";
import {
  decodeFrame,
  dotnetTicksToIso,
  EventKind,
  expiryTicksToDate,
  FrameType,
  HEADER_BYTES,
  HELLO_HEADER_BYTES,
  WireError,
} from "../src/wire/decoder.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN = join(ROOT, "schema", "golden");
const golden = (name: string) => readFileSync(join(GOLDEN, name));

/** Byte size of one identity block with these strings (43 fixed + string bytes). */
function identityBytes(strings: string[]): number {
  return 43 + strings.reduce((n, s) => n + s.length, 0);
}

describe("hello identity section", () => {
  it("decodes every identity field for the three config shapes", () => {
    const frame = decodeFrame(golden("hello.bin"));
    if (frame.payload.kind !== "hello") throw new Error("expected hello");
    const [es, nq, fx] = frame.payload.instruments;

    expect(es!.identity).toEqual({
      shape: "root",
      shapeCode: 2,
      resolvedBy: "nt8Default",
      resolvedByCode: 2,
      resolvedFrom: "ES",
      fullName: "ES 12-26",
      masterName: "ES",
      instrumentType: "Future",
      exchange: "Globex",
      currency: "UsDollar",
      tradingHours: "CME US Index Futures ETH",
      expiryTicks: es!.identity!.expiryTicks,
      tickSize: 0.25,
      pointValue: 50,
      rolledAtUtc: 0n,
      rollCount: 0,
    });
    expect(expiryTicksToDate(es!.identity!.expiryTicks)).toBe("2026-12-18");
    expect(dotnetTicksToIso(es!.identity!.rolledAtUtc)).toBeNull();

    expect(nq!.identity).toMatchObject({
      shape: "fullyQualified",
      resolvedBy: "asTyped",
      resolvedFrom: "NQ 03-27",
      fullName: "NQ 03-27",
      pointValue: 20,
    });
    expect(expiryTicksToDate(nq!.identity!.expiryTicks)).toBe("2027-03-19");

    expect(fx!.identity).toMatchObject({
      shape: "direct",
      resolvedBy: "asTyped",
      resolvedFrom: "EURUSD",
      fullName: "EURUSD",
      instrumentType: "Forex",
      expiryTicks: 0n,
      tickSize: 0.00001,
      pointValue: 100000,
    });
    expect(expiryTicksToDate(0n)).toBeNull();
  });

  it("pins the payload size from the documented layout", () => {
    // base table
    const base = HELLO_HEADER_BYTES + (19 + 8) + (19 + 8) + (19 + 6);
    // identity section: u16 count, then (u16 index + block) x3
    const esStrings = ["ES", "ES 12-26", "ES", "Future", "Globex", "UsDollar", "CME US Index Futures ETH"];
    const nqStrings = ["NQ 03-27", "NQ 03-27", "NQ", "Future", "Globex", "UsDollar", "CME US Index Futures ETH"];
    const fxStrings = ["EURUSD", "EURUSD", "EURUSD", "Forex", "Default", "UsDollar", "Forex"];
    const identities = 2 + (2 + identityBytes(esStrings)) + (2 + identityBytes(nqStrings)) + (2 + identityBytes(fxStrings));
    // unresolved: u16 count + two u8-prefixed strings
    const unresolved = 2 + (1 + "XYZ".length) + (1 + "not in the NinjaTrader instrument database: XYZ".length);
    expect(golden("hello.bin").length).toBe(4 + HEADER_BYTES + base + identities + unresolved);
  });

  it("reads identity bytes at the documented offsets, independent of the decoder", () => {
    const payload = golden("hello.bin").subarray(4 + HEADER_BYTES);
    const base = HELLO_HEADER_BYTES + (19 + 8) + (19 + 8) + (19 + 6);
    expect(payload.readUInt16LE(base)).toBe(3); // identityCount
    let p = base + 2;
    expect(payload.readUInt16LE(p)).toBe(0); // index
    p += 2;
    expect(payload.readUInt8(p)).toBe(2); // shape: root
    expect(payload.readUInt8(p + 1)).toBe(2); // resolvedBy: nt8Default
    expect(payload.readUInt8(p + 2)).toBe(2); // resolvedFrom length
    expect(payload.toString("ascii", p + 3, p + 5)).toBe("ES");
  });

  it("rejects an identity section whose count disagrees with the base table", () => {
    const buf = Buffer.from(golden("hello.bin"));
    const base = HELLO_HEADER_BYTES + (19 + 8) + (19 + 8) + (19 + 6);
    buf.writeUInt16LE(2, 4 + HEADER_BYTES + base);
    expect(() => decodeFrame(buf)).toThrow(/identityCount/);
  });

  it("rejects an identity whose fullName disagrees with the base entry", () => {
    const buf = Buffer.from(golden("hello.bin"));
    const base = HELLO_HEADER_BYTES + (19 + 8) + (19 + 8) + (19 + 6);
    // first identity: [u16 index][u8 shape][u8 resolvedBy][u8 len "ES"]["ES"][u8 len][fullName...]
    const fullNameAt = 4 + HEADER_BYTES + base + 2 + 2 + 2 + 1 + 2 + 1;
    buf.write("XS", fullNameAt, "ascii");
    expect(() => decodeFrame(buf)).toThrow(/fullName/);
  });

  it("rejects a truncated identity section", () => {
    const whole = golden("hello.bin");
    const buf = Buffer.from(whole.subarray(0, whole.length - 5));
    buf.writeUInt32LE(buf.length - 4, 0);
    expect(() => decodeFrame(buf)).toThrow(WireError);
  });
});

describe("contractRolled event", () => {
  it("decodes both identities and the roll time", () => {
    const frame = decodeFrame(golden("event-contract-rolled.bin"));
    expect(frame.header.type).toBe(FrameType.Event);
    expect(frame.header.instrument).toBe(0);
    if (frame.payload.kind !== "event") throw new Error("expected event");
    const ev = frame.payload.event;
    if (ev.name !== "contractRolled") throw new Error("expected contractRolled");
    expect(ev.eventKind).toBe(EventKind.ContractRolled);
    expect(ev.previous.fullName).toBe("ES 12-26");
    expect(ev.previous.rollCount).toBe(0);
    expect(ev.next.fullName).toBe("ES 03-27");
    expect(ev.next.resolvedFrom).toBe("ES");
    expect(ev.next.resolvedBy).toBe("rolloverTable");
    expect(ev.next.rollCount).toBe(1);
    expect(ev.next.rolledAtUtc).toBe(ev.rolledAtUtc);
    expect(dotnetTicksToIso(ev.rolledAtUtc)).toBe("2022-09-28T23:53:20.000Z");
    expect(expiryTicksToDate(ev.next.expiryTicks)).toBe("2027-03-19");
  });

  it("reads the event header at its documented offsets", () => {
    const payload = golden("event-contract-rolled.bin").subarray(4 + HEADER_BYTES);
    expect(payload.readUInt16LE(0)).toBe(1); // eventKind contractRolled
    expect(payload.readUInt16LE(2)).toBe(0); // reserved
    expect(payload.readUInt8(12)).toBe(2); // previous.shape at +12: root
  });

  it("keeps an unknown eventKind opaque", () => {
    const buf = Buffer.from(golden("event-contract-rolled.bin"));
    buf.writeUInt16LE(999, 4 + HEADER_BYTES);
    const frame = decodeFrame(buf);
    if (frame.payload.kind !== "event") throw new Error("expected event");
    expect(frame.payload.event.name).toBe("unknown");
    expect(frame.payload.event.eventKind).toBe(999);
  });

  it("rejects a contractRolled event with trailing bytes", () => {
    const buf = Buffer.concat([golden("event-contract-rolled.bin"), Buffer.from([0])]);
    buf.writeUInt32LE(buf.length - 4, 0);
    expect(() => decodeFrame(buf)).toThrow(/trailing/);
  });
});

describe("roll mid-connection through the cache", () => {
  function primed(): StateCache {
    const cache = new StateCache();
    cache.onConnect();
    for (const f of new FrameSplitter().push(golden("stream-roll.bin"))) cache.applyFrame(decodeFrame(f));
    return cache;
  }

  it("splits the roll stream into hello, snapshot, hello, event, snapshot", () => {
    const types = new FrameSplitter().push(golden("stream-roll.bin")).map((f) => decodeFrame(f).header.type);
    expect(types).toEqual([FrameType.Hello, FrameType.Snapshot, FrameType.Hello, FrameType.Event, FrameType.Snapshot]);
  });

  it("ends with the new contract at index 0, only the post-roll snapshot, and the boundary recorded", () => {
    const cache = primed();
    const es = cache.viewInstrument(0)!;
    expect(es.name).toBe("ES 03-27");
    expect(es.resolvedFrom).toBe("ES");
    expect(es.expiry).toBe("2027-03-19");
    expect(es.eventsDrained).toBe("510"); // the post-roll snapshot, never the pre-roll 500
    expect(es.sequence).toBe(8);
    expect(es.resolution).toEqual({
      state: "rolled",
      rolledAt: "2022-09-28T23:53:20.000Z",
      rollCount: 1,
      previousName: "ES 12-26",
      reason: null,
    });
    expect(cache.viewInstrument(1)!.name).toBe("NQ 03-27");
    expect(cache.viewInstrument(2)!.identity!.instrumentType).toBe("Forex");
    expect(cache.helloReannouncements).toBe(1);
    expect(cache.health().connectionCount).toBe(1);
    expect(cache.recentEvents().map((e) => e.kind)).toEqual(["connected", "hello", "helloReannounced", "contractRolled"]);
  });

  it("health lists resolution per config entry, unresolved with reason, rolled with time", () => {
    const health = primed().health();
    expect(health.instrumentCount).toBe(3);
    expect(health.unresolvedCount).toBe(1);
    expect(health.instruments).toEqual([
      { resolvedFrom: "ES", name: "ES 03-27", index: 0, state: "rolled", reason: null, rolledAt: "2022-09-28T23:53:20.000Z", rollCount: 1, previousName: "ES 12-26" },
      { resolvedFrom: "NQ 03-27", name: "NQ 03-27", index: 1, state: "resolved", reason: null, rolledAt: null, rollCount: 0, previousName: null },
      { resolvedFrom: "EURUSD", name: "EURUSD", index: 2, state: "resolved", reason: null, rolledAt: null, rollCount: 0, previousName: null },
      { resolvedFrom: "XYZ", name: null, index: null, state: "unresolved", reason: "not in the NinjaTrader instrument database: XYZ", rolledAt: null, rollCount: 0, previousName: null },
    ]);
  });

  it("tool descriptions say a bare root auto-resolves and can roll mid-session", () => {
    const server = buildServer(primed(), { nt8Build: "x", feed: "y", source: "test" });
    const tools = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
    expect(tools["instruments"]!.description).toMatch(/bare futures root/);
    expect(tools["instruments"]!.description).toMatch(/CAN ROLL MID-SESSION/);
    expect(tools["instruments"]!.description).toMatch(/resolvedFrom/);
    expect(tools["health"]!.description).toMatch(/auto-resolves/);
    expect(tools["health"]!.description).toMatch(/roll mid-session/);
    expect(tools["health"]!.description).toMatch(/unresolved/);
  });
});
