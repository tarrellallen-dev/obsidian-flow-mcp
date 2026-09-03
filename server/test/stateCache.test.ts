/**
 * Cache semantics: staleness at service time, and the reconnect rule from schema/wire-v1.md
 * (mark everything reconnecting, ignore frames until a fresh hello).
 */

import { describe, expect, it } from "vitest";

import { StateCache } from "../src/cache/stateCache.js";
import {
  EventKind,
  FrameType,
  type Frame,
  type InstrumentIdentity,
  type UnresolvedInstrument,
} from "../src/wire/decoder.js";

// Instrument names in these fixtures ("ES 06-26" and the like) are EXAMPLES; nothing in the
// server or the AddOn hardcodes a contract month.

/** Identity fixture for a bare root resolved to an example front contract. */
function identity(resolvedFrom: string, fullName: string, overrides: Partial<InstrumentIdentity> = {}): InstrumentIdentity {
  return {
    shape: "root",
    shapeCode: 2,
    resolvedBy: "nt8Default",
    resolvedByCode: 2,
    resolvedFrom,
    fullName,
    masterName: resolvedFrom,
    instrumentType: "Future",
    exchange: "Globex",
    currency: "UsDollar",
    tradingHours: "CME US Index Futures ETH",
    expiryTicks: 638_700_000_000_000_000n,
    tickSize: 0.25,
    pointValue: 50,
    rolledAtUtc: 0n,
    rollCount: 0,
    ...overrides,
  };
}

/** Hello with the step-2.5 identity section. `entries` are [resolvedFrom, fullName] pairs. */
function helloWithIdentity(
  entries: [string, string, Partial<InstrumentIdentity>?][],
  unresolved: UnresolvedInstrument[] = [],
  sequence = 0,
): Frame {
  const base = helloFrame(entries.map((e) => e[1]), sequence);
  if (base.payload.kind !== "hello") throw new Error("unreachable");
  base.payload.identityPresent = true;
  base.payload.unresolved = unresolved;
  base.payload.instruments = base.payload.instruments.map((inst, i) => ({
    ...inst,
    identity: identity(entries[i]![0], entries[i]![1], entries[i]![2] ?? {}),
  }));
  return base;
}

function contractRolledFrame(instrument: number, sequence: number, previous: InstrumentIdentity, next: InstrumentIdentity): Frame {
  return {
    header: {
      length: 32,
      type: FrameType.Event,
      version: 1,
      sequence,
      ringEventsDropped: 0,
      sentTicks: BigInt(sequence),
      wallUtc: 638_000_000_000_000_000n,
      instrument,
      reserved: 0,
    },
    payload: {
      kind: "event",
      event: { eventKind: EventKind.ContractRolled, name: "contractRolled", rolledAtUtc: next.rolledAtUtc, previous, next },
    },
  };
}

function helloFrame(names: string[], sequence = 0): Frame {
  return {
    header: {
      length: 32,
      type: FrameType.Hello,
      version: 1,
      sequence,
      ringEventsDropped: 0,
      sentTicks: 0n,
      wallUtc: 638_000_000_000_000_000n,
      instrument: 0xffff,
      reserved: 0,
    },
    payload: {
      kind: "hello",
      stopwatchFrequency: 10_000_000n,
      instruments: names.map((name, index) => ({
        index,
        name,
        tickSize: 0.25,
        pointValue: 50,
        identity: null,
      })),
      identityPresent: false,
      unresolved: [],
    },
  };
}

function snapshotFrame(
  instrument: number,
  sequence: number,
  dropped = 0,
  sentTicks?: bigint,
): Frame {
  return {
    header: {
      length: 56,
      type: FrameType.Snapshot,
      version: 1,
      sequence,
      ringEventsDropped: dropped,
      sentTicks: sentTicks ?? BigInt(sequence),
      wallUtc: 638_000_000_000_000_000n,
      instrument,
      reserved: 0,
    },
    payload: {
      kind: "snapshot",
      eventsDrained: BigInt(sequence * 10),
      bytesAllocatedOnPublisher: 0n,
      handlerSamples: BigInt(sequence),
      instrumentation: null,
    },
  };
}

function heartbeatFrame(sequence: number, sentTicks?: bigint): Frame {
  return {
    header: {
      length: 32,
      type: FrameType.Heartbeat,
      version: 1,
      sequence,
      ringEventsDropped: 0,
      sentTicks: sentTicks ?? BigInt(sequence),
      wallUtc: 638_000_000_000_000_000n,
      instrument: 0xffff,
      reserved: 0,
    },
    payload: { kind: "heartbeat" },
  };
}

/** Controllable nanosecond clock so staleness is asserted, not slept for. */
function fakeClock() {
  let ns = 1_000_000_000n;
  return {
    now: () => ns,
    advanceMs(ms: number) {
      ns += BigInt(ms) * 1_000_000n;
    },
    advanceNs(delta: bigint) {
      ns += delta;
    },
    setNs(value: bigint) {
      ns = value;
    },
  };
}

describe("StateCache", () => {
  it("ignores frames until a hello arrives", () => {
    const cache = new StateCache();
    cache.applyFrame(snapshotFrame(0, 1));
    cache.applyFrame(heartbeatFrame(2));
    expect(cache.helloReceived).toBe(false);
    expect(cache.framesReceived).toBe(0);
    expect(cache.framesIgnoredBeforeHello).toBe(2);
    expect(cache.viewInstruments()).toEqual([]);
  });

  it("populates instruments from hello and snapshots into slots", () => {
    const cache = new StateCache();
    cache.applyFrame(helloFrame(["ES 06-26", "NQ 06-26"]));
    cache.applyFrame(snapshotFrame(1, 5, 3));

    const es = cache.viewInstrumentByName("ES 06-26")!;
    const nq = cache.viewInstrumentByName("NQ 06-26")!;

    expect(es.eventsDrained).toBeNull();
    expect(es.freshness).toBe("reconnecting"); // hello seen, no snapshot for this slot yet
    expect(nq.eventsDrained).toBe("50");
    expect(nq.sequence).toBe(5);
    expect(nq.droppedTotal).toBe(3);
    expect(nq.freshness).toBe("live");
  });

  it("reports live, then stale, as the clock advances", () => {
    const clock = fakeClock();
    const cache = new StateCache({ now: clock.now, staleAfterMs: 2000 });

    cache.applyFrame(helloFrame(["ES 06-26"]));
    cache.applyFrame(snapshotFrame(0, 1));
    expect(cache.viewInstrument(0)!.freshness).toBe("live");
    expect(cache.viewInstrument(0)!.staleness.receiveToServeMs).toBe(0);

    clock.advanceMs(500);
    expect(cache.viewInstrument(0)!.staleness.receiveToServeMs).toBe(500);
    expect(cache.viewInstrument(0)!.freshness).toBe("live");

    clock.advanceMs(2000);
    expect(cache.viewInstrument(0)!.staleness.receiveToServeMs).toBe(2500);
    expect(cache.viewInstrument(0)!.freshness).toBe("stale");

    // A later snapshot refreshes the slot.
    cache.applyFrame(snapshotFrame(0, 2));
    expect(cache.viewInstrument(0)!.freshness).toBe("live");
  });

  it("marks everything reconnecting on connect and ignores frames until a fresh hello", () => {
    const cache = new StateCache();
    cache.applyFrame(helloFrame(["ES 06-26"]));
    cache.applyFrame(snapshotFrame(0, 1));
    expect(cache.viewInstrument(0)!.freshness).toBe("live");

    cache.onDisconnect("socket closed");
    cache.onConnect();

    const view = cache.viewInstrument(0)!;
    expect(view.freshness).toBe("reconnecting");
    expect(view.eventsDrained).toBeNull();
    expect(view.staleness.receiveToServeMs).toBeNull();

    // Stale-connection frames are dropped: indices are not valid across connections.
    cache.applyFrame(snapshotFrame(0, 99));
    expect(cache.viewInstrument(0)!.eventsDrained).toBeNull();

    cache.applyFrame(helloFrame(["ES 06-26"]));
    cache.applyFrame(snapshotFrame(0, 1));
    expect(cache.viewInstrument(0)!.freshness).toBe("live");
    expect(cache.health().connectionCount).toBe(1);
  });

  it("drops a snapshot for an instrument index not in the current hello table", () => {
    const cache = new StateCache();
    cache.applyFrame(helloFrame(["ES 06-26"]));
    cache.applyFrame(snapshotFrame(7, 1));
    expect(cache.viewInstruments()).toHaveLength(1);
    expect(cache.viewInstrument(0)!.eventsDrained).toBeNull();
  });

  it("reports transport health", () => {
    const cache = new StateCache();
    cache.setEndpoint("/tmp/of.sock");
    cache.setPipeState("connected");
    cache.applyFrame(helloFrame(["ES 06-26", "NQ 06-26"]));
    cache.applyFrame(snapshotFrame(0, 1, 2));
    cache.applyFrame(snapshotFrame(1, 2, 4));

    const health = cache.health();
    expect(health.endpoint).toBe("/tmp/of.sock");
    expect(health.helloReceived).toBe(true);
    expect(health.instrumentCount).toBe(2);
    expect(health.framesReceived).toBe(3);
    expect(health.droppedTotal).toBe(6);
    expect(health.eventsDrained).toBe("20");
    expect(health.lastFrameStaleness.receiveToServeMs).not.toBeNull();
    expect(health.stopwatchFrequency).toBe("10000000");
  });

  it("reports sub-millisecond ages as fractions, not as zero", () => {
    const clock = fakeClock();
    const cache = new StateCache({ now: clock.now });
    cache.applyFrame(helloFrame(["ES 06-26"]));
    cache.applyFrame(snapshotFrame(0, 1));

    clock.advanceNs(250_000n); // 0.25 ms
    expect(cache.viewInstrument(0)!.staleness.receiveToServeMs).toBeCloseTo(0.25, 6);
  });

  it("estimates the one-way hop from heartbeat cadence, and refuses to before two heartbeats", () => {
    const clock = fakeClock();
    const cache = new StateCache({ now: clock.now });

    // Publisher Stopwatch runs at 10 MHz in these fixtures: one tick is 100 ns.
    clock.setNs(1_000_000_000n);
    cache.applyFrame(helloFrame(["ES 06-26"]));

    cache.applyFrame(snapshotFrame(0, 1, 0, 10_000_000n));
    expect(cache.viewInstrument(0)!.staleness.oneWayEstimateMs).toBeNull();
    expect(cache.viewInstrument(0)!.staleness.oneWayEstimateBasis).toBe("insufficient-heartbeats");

    // Heartbeat 1: sent at 1.0 s publisher time, received at 1.001 s local -> offset 1 ms.
    clock.setNs(1_001_000_000n);
    cache.applyFrame(heartbeatFrame(2, 10_000_000n));
    expect(cache.viewInstrument(0)!.staleness.oneWayEstimateMs).toBeNull();

    // Heartbeat 2: sent at 2.0 s, received at 2.003 s -> offset 3 ms. The minimum stays 1 ms.
    clock.setNs(2_003_000_000n);
    cache.applyFrame(heartbeatFrame(3, 20_000_000n));

    // Snapshot sent at 2.5 s, received at 2.5045 s -> offset 4.5 ms, 3.5 ms above the minimum.
    clock.setNs(2_504_500_000n);
    cache.applyFrame(snapshotFrame(0, 4, 0, 25_000_000n));

    const staleness = cache.viewInstrument(0)!.staleness;
    expect(staleness.oneWayEstimateMs).toBeCloseTo(3.5, 6);
    expect(staleness.oneWayEstimateBasis).toBe("heartbeat-cadence-min-filter");
    expect(staleness.receiveToServeMs).toBe(0);
    expect(cache.heartbeatsSeen).toBe(2);
    expect(cache.stopwatchFrequency).toBe(10_000_000n);
  });

  it("discards the clock estimate on reconnect", () => {
    const cache = new StateCache();
    cache.applyFrame(helloFrame(["ES 06-26"]));
    cache.applyFrame(heartbeatFrame(1, 10_000_000n));
    cache.applyFrame(heartbeatFrame(2, 20_000_000n));
    expect(cache.heartbeatsSeen).toBe(2);

    cache.onDisconnect("socket closed");
    cache.onConnect();
    expect(cache.heartbeatsSeen).toBe(0);
    expect(cache.stopwatchFrequency).toBeNull();
    expect(cache.health().lastFrameStaleness.oneWayEstimateBasis).toBe("insufficient-heartbeats");
  });

  it("reports identity-absent resolution for a pre-2.5 hello", () => {
    const cache = new StateCache();
    cache.applyFrame(helloFrame(["ES 06-26"]));
    const view = cache.viewInstrument(0)!;
    expect(view.identity).toBeNull();
    expect(view.resolvedFrom).toBe("ES 06-26");
    expect(view.expiry).toBeNull();
    expect(view.resolution.state).toBe("identity-absent");
    expect(cache.health().instruments).toEqual([
      {
        resolvedFrom: "ES 06-26",
        name: "ES 06-26",
        index: 0,
        state: "identity-absent",
        reason: null,
        rolledAt: null,
        rollCount: 0,
        previousName: null,
      },
    ]);
  });

  it("exposes identity, resolvedFrom, expiry and unresolved entries from a 2.5 hello", () => {
    const cache = new StateCache();
    cache.applyFrame(
      helloWithIdentity(
        [
          ["ES", "ES 12-26"],
          ["EURUSD", "EURUSD", { shape: "direct", shapeCode: 3, resolvedBy: "asTyped", resolvedByCode: 1, instrumentType: "Forex", expiryTicks: 0n, tickSize: 0.00001, pointValue: 100000 }],
        ],
        [{ typed: "XYZ", reason: "not in the NinjaTrader instrument database: XYZ" }],
      ),
    );

    const es = cache.viewInstrumentByName("ES")!; // matched by resolvedFrom
    expect(es.name).toBe("ES 12-26");
    expect(es.resolvedFrom).toBe("ES");
    expect(es.identity!.shape).toBe("root");
    expect(es.identity!.instrumentType).toBe("Future");
    expect(es.expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(es.resolution).toEqual({ state: "resolved", rolledAt: null, rollCount: 0, previousName: null, reason: null });

    const fx = cache.viewInstrumentByName("EURUSD")!;
    expect(fx.identity!.shape).toBe("direct");
    expect(fx.expiry).toBeNull();

    const health = cache.health();
    expect(health.unresolvedCount).toBe(1);
    expect(health.instruments.map((i) => [i.resolvedFrom, i.state])).toEqual([
      ["ES", "resolved"],
      ["EURUSD", "resolved"],
      ["XYZ", "unresolved"],
    ]);
    expect(health.instruments[2]!.reason).toMatch(/instrument database/);
    expect(cache.unresolvedInstruments).toHaveLength(1);
  });

  it("re-validates indices on a hello re-announcement after a roll: identity replaced, series reset, others kept", () => {
    const cache = new StateCache();
    cache.onConnect();
    cache.applyFrame(helloWithIdentity([["ES", "ES 12-26"], ["NQ 03-27", "NQ 03-27", { shape: "fullyQualified", shapeCode: 1 }]]));
    cache.applyFrame(snapshotFrame(0, 1, 2));
    cache.applyFrame(snapshotFrame(1, 2, 5));
    expect(cache.viewInstrument(0)!.eventsDrained).toBe("10");
    expect(cache.viewInstrument(1)!.eventsDrained).toBe("20");

    const rolledAt = 638_000_100_000_000_000n;
    const previous = identity("ES", "ES 12-26");
    const next = identity("ES", "ES 03-27", { resolvedBy: "rolloverTable", resolvedByCode: 3, rolledAtUtc: rolledAt, rollCount: 1 });

    // Re-announced hello: same connection, same indices, new identity at index 0.
    cache.applyFrame(helloWithIdentity([["ES", "ES 03-27", { resolvedBy: "rolloverTable", resolvedByCode: 3, rolledAtUtc: rolledAt, rollCount: 1 }], ["NQ 03-27", "NQ 03-27", { shape: "fullyQualified", shapeCode: 1 }]], [], 3));
    cache.applyFrame(contractRolledFrame(0, 4, previous, next));

    expect(cache.helloReceived).toBe(true);
    expect(cache.helloReannouncements).toBe(1);
    expect(cache.health().connectionCount).toBe(1);

    // Index 0 is a new series: old snapshot gone, identity replaced, boundary recorded.
    const es = cache.viewInstrument(0)!;
    expect(es.name).toBe("ES 03-27");
    expect(es.resolvedFrom).toBe("ES");
    expect(es.eventsDrained).toBeNull();
    expect(es.droppedTotal).toBe(0);
    expect(es.freshness).toBe("reconnecting");
    expect(es.resolution.state).toBe("rolled");
    expect(es.resolution.rollCount).toBe(1);
    expect(es.resolution.previousName).toBe("ES 12-26");
    expect(es.resolution.rolledAt).toBe("2022-09-29T01:00:00.000Z"); // 638_000_100_000_000_000 .NET ticks
    expect(es.identity!.resolvedBy).toBe("rolloverTable");

    // Index 1 did not change and keeps its series.
    const nq = cache.viewInstrument(1)!;
    expect(nq.eventsDrained).toBe("20");
    expect(nq.droppedTotal).toBe(5);
    expect(nq.resolution.state).toBe("resolved");

    // A snapshot of the new contract lands in the re-validated slot.
    cache.applyFrame(snapshotFrame(0, 5));
    expect(cache.viewInstrument(0)!.eventsDrained).toBe("50");
    expect(cache.viewInstrument(0)!.freshness).toBe("live");

    // Both the roll and the re-announcement are in the event ring, and health says rolled.
    const kinds = cache.recentEvents().map((e) => e.kind);
    expect(kinds).toContain("helloReannounced");
    expect(kinds).toContain("contractRolled");
    const rolled = cache.recentEvents().find((e) => e.kind === "contractRolled")!;
    expect(rolled.detail).toContain("ES 12-26 -> ES 03-27");
    expect(cache.health().helloReannouncements).toBe(1);
    expect(cache.health().instruments[0]).toMatchObject({ resolvedFrom: "ES", name: "ES 03-27", state: "rolled", previousName: "ES 12-26" });

    // Instruments that vanish from a re-announced table are dropped, not kept stale.
    cache.applyFrame(helloWithIdentity([["ES", "ES 03-27", { rolledAtUtc: rolledAt, rollCount: 1 }]], [], 6));
    expect(cache.viewInstruments().map((v) => v.index)).toEqual([0]);
    expect(cache.viewInstrument(0)!.eventsDrained).toBe("50"); // unchanged index keeps its series
  });

  it("clears the series when a contractRolled event arrives without a preceding re-announcement", () => {
    const cache = new StateCache();
    cache.applyFrame(helloWithIdentity([["ES", "ES 12-26"]]));
    cache.applyFrame(snapshotFrame(0, 1));
    const previous = identity("ES", "ES 12-26");
    const next = identity("ES", "ES 03-27", { rolledAtUtc: 638_000_100_000_000_000n, rollCount: 1 });
    cache.applyFrame(contractRolledFrame(0, 2, previous, next));
    const es = cache.viewInstrument(0)!;
    expect(es.name).toBe("ES 03-27");
    expect(es.eventsDrained).toBeNull();
    expect(es.resolution.state).toBe("rolled");
    expect(es.resolution.previousName).toBe("ES 12-26");
  });

  it("bounds the event ring", () => {
    const cache = new StateCache({ eventRingSize: 4 });
    for (let i = 0; i < 20; i++) cache.pushEvent("tick", String(i));
    const events = cache.recentEvents(100);
    expect(events).toHaveLength(4);
    expect(events[3]!.detail).toBe("19");
  });
});
