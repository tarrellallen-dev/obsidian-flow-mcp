/**
 * Step-3 market block (schema/wire-v1.md "step-3 block"): golden decode, documented offsets,
 * the unavailable case, rejection of malformed blocks, the cache's market views and the four
 * step-4 tools. Golden files come from schema/tools/gen-golden.mjs; the step-1, step-2 and 2.5
 * goldens are untouched (the golden test still pins them), which is the additive guarantee.
 */

// Instrument names in the golden files are EXAMPLES; no contract month is hardcoded by the AddOn.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { StateCache, levelView, profileView } from "../src/cache/stateCache.js";
import { buildServer } from "../src/index.js";
import { FrameSplitter } from "../src/transport/frameSplitter.js";
import {
  decodeFrame,
  FrameType,
  HEADER_BYTES,
  MARKET_PRICE_BYTES,
  MARKET_VWAP_BYTES,
  SNAPSHOT_MARKET_LENGTH_OFFSET,
  SNAPSHOT_MARKET_START,
  SNAPSHOT_STEP2_PAYLOAD_BYTES,
  type MarketBlock,
} from "../src/wire/decoder.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN = join(ROOT, "schema", "golden");
const golden = (name: string) => readFileSync(join(GOLDEN, name));

function market(name: string): MarketBlock {
  const frame = decodeFrame(golden(name));
  if (frame.payload.kind !== "snapshot") throw new Error("expected snapshot");
  if (frame.payload.market === null) throw new Error("expected market block");
  return frame.payload.market;
}

const WALL = 638000000000000000n;
const SESSION_BEGIN = WALL - 36_000_000_000n;

describe("step-3 snapshot golden files", () => {
  it("keeps the step-1 and step-2 blocks in front, byte for byte", () => {
    const buf = golden("snapshot-step3.bin");
    const payload = buf.subarray(4 + HEADER_BYTES);
    expect(payload.length).toBeGreaterThan(SNAPSHOT_STEP2_PAYLOAD_BYTES);
    expect(payload.readBigUInt64LE(0)).toBe(1000n); // eventsDrained
    expect(payload.readUInt32LE(24)).toBe(1299); // dataP50Ns, step-2 block unchanged
    expect(payload.readBigUInt64LE(136)).toBe(10_000_000n); // stopwatchFrequency
    // +160 marketBytes ends the payload exactly.
    const marketBytes = payload.readUInt32LE(SNAPSHOT_MARKET_LENGTH_OFFSET);
    expect(SNAPSHOT_MARKET_START + marketBytes).toBe(payload.length);
    // +164 version 1, +166 flags: sessionKnown | inSession | hasBidAsk | bidAskSplitPresent.
    expect(payload.readUInt16LE(164)).toBe(1);
    expect(payload.readUInt16LE(166)).toBe(0b1111);
    // price block +168..+287, vwap block +288..+355, coverage from +356.
    expect(MARKET_PRICE_BYTES).toBe(120);
    expect(MARKET_VWAP_BYTES).toBe(68);
    expect(payload.readDoubleLE(168)).toBe(101.25); // last
    expect(payload.readBigInt64LE(176)).toBe(30n); // lastSize
    expect(payload.readUInt8(184)).toBe(2); // lastAggressor = ask
    expect(payload.readInt32LE(188)).toBe(1); // spreadTicks
    expect(payload.readDoubleLE(192)).toBe(101.0); // bid
    expect(payload.readDoubleLE(200)).toBe(101.25); // ask
    expect(payload.readDoubleLE(208)).toBe(99.75); // sessionOpen
    expect(payload.readBigUInt64LE(232)).toBe(142n); // sessionVolume
    expect(payload.readBigUInt64LE(240)).toBe(135n); // tapeVolume
    expect(payload.readDoubleLE(256)).toBe(0.25); // tickSize
    expect(payload.readBigInt64LE(272)).toBe(SESSION_BEGIN); // sessionBeginUtc
    expect(payload.readDoubleLE(288)).toBeCloseTo(100.67592592592591, 12); // vwap
    expect(payload.readBigUInt64LE(344)).toBe(135n); // vwapVolume
    expect(payload.readUInt8(352)).toBe(0); // vwapIncludesHistory
    expect(payload.readUInt8(356)).toBe(2); // historyState loaded
    expect(payload.readUInt8(357)).toBe(1); // historyResolution minuteSpread
    expect(payload.readBigInt64LE(360)).toBe(SESSION_BEGIN); // historyFromUtc
    expect(payload.readUInt8(384)).toBe(0); // historyError length 0 -> session profile at +385
    expect(payload.readUInt8(385)).toBe(1); // session available
    expect(payload.readUInt8(386)).toBe(0b0001); // session flags: hasBidAskSplit
    expect(payload.readDoubleLE(389)).toBe(100.5); // session poc
    expect(payload.readDoubleLE(397)).toBe(101.0); // session vah
    expect(payload.readDoubleLE(405)).toBe(100.0); // session val
    expect(payload.readBigUInt64LE(413)).toBe(135n); // totalVolume
    expect(payload.readBigUInt64LE(421)).toBe(35n); // pocVolume
    expect(payload.readBigUInt64LE(429)).toBe(105n); // valueAreaVolume
    expect(payload.readUInt16LE(469)).toBe(3); // nodeCount at +84 of the record
    expect(payload.readDoubleLE(471)).toBe(100.5); // first node price
    expect(payload.readUInt8(495)).toBe(1); // first node kind hvn
  });

  it("decodes the price, vwap and coverage blocks", () => {
    const m = market("snapshot-step3.bin");
    expect(m.version).toBe(1);
    expect(m.flags).toEqual({ sessionKnown: true, inSession: true, hasBidAsk: true, bidAskSplitPresent: true });
    expect(m.price).toMatchObject({
      last: 101.25,
      lastSize: 30n,
      lastAggressor: "ask",
      spreadTicks: 1,
      bid: 101.0,
      ask: 101.25,
      sessionOpen: 99.75,
      sessionHigh: 101.25,
      sessionLow: 99.5,
      sessionVolume: 142n,
      tapeVolume: 135n,
      tradeCount: 7n,
      tickSize: 0.25,
      pointValue: 50,
      sessionBeginUtc: SESSION_BEGIN,
    });
    expect(m.vwap.vwap).toBeCloseTo(13591.25 / 135, 12);
    expect(m.vwap.stdDev).toBeCloseTo(0.41841198250723066, 12);
    expect(m.vwap.sd1Upper).toBeCloseTo(m.vwap.vwap! + m.vwap.stdDev!, 12);
    expect(m.vwap.sd2Lower).toBeCloseTo(m.vwap.vwap! - 2 * m.vwap.stdDev!, 12);
    expect(m.vwap.priceVsVwapTicks).toBeCloseTo((101.25 - 13591.25 / 135) / 0.25, 12);
    expect(m.vwap.volume).toBe(135n);
    expect(m.vwap.includesHistory).toBe(false);
    expect(m.coverage).toMatchObject({
      historyState: "loaded",
      historyResolution: "minuteSpread",
      historyFromUtc: SESSION_BEGIN,
      historyError: "",
    });
    expect(m.coverage.tapeFromUtc).toBe(WALL - 300_000_000n);
  });

  it("decodes the session profile to the hand-computed fixture values", () => {
    const s = market("snapshot-step3.bin").session;
    expect(s.available).toBe(true);
    expect(s.flags).toEqual({ hasBidAskSplit: true, includesHistory: false, nakedPoc: false, outOfRange: false, priorFromLive: false });
    expect([s.poc, s.vah, s.val]).toEqual([100.5, 101.0, 100.0]);
    expect([s.totalVolume, s.pocVolume, s.valueAreaVolume, s.tapeVolume]).toEqual([135n, 35n, 105n, 135n]);
    expect([s.rangeLow, s.rangeHigh]).toEqual([100.0, 101.25]);
    expect(s.nodes.map((n) => [n.price, n.kind, n.volume])).toEqual([
      [100.5, "hvn", 35n],
      [100.75, "lvn", 5n],
      [101.25, "hvn", 30n],
    ]);
    expect(s.nodes[1]!.strength).toBeCloseTo(5 / 6, 12);
    expect(s.nodes[2]!.strength).toBeCloseTo(6 / 7, 12);
    expect(s.checkpoints).toEqual([{ atUtc: SESSION_BEGIN + 18_000_000_000n, poc: 100.25, vah: 100.5, val: 100.0 }]);
    expect(s.histogram.map((l) => [l.price, l.volume, l.tapeVolume, l.bidVolume, l.askVolume])).toEqual([
      [100.0, 10n, 10n, 0n, 10n],
      [100.25, 30n, 30n, 30n, 0n],
      [100.5, 35n, 35n, 5n, 30n],
      [100.75, 5n, 5n, 0n, 0n],
      [101.0, 25n, 25n, 0n, 25n],
      [101.25, 30n, 30n, 0n, 30n],
    ]);
  });

  it("decodes the prior (volume-only, naked POC) and composite (history + tape) records", () => {
    const m = market("snapshot-step3.bin");
    expect(m.prior.available).toBe(true);
    expect(m.prior.flags.hasBidAskSplit).toBe(false);
    expect(m.prior.flags.includesHistory).toBe(true);
    expect(m.prior.flags.nakedPoc).toBe(true);
    expect([m.prior.poc, m.prior.vah, m.prior.val]).toEqual([98.75, 99.25, 98.25]);
    expect(m.prior.histogram).toEqual([]);
    expect(m.prior.checkpoints).toEqual([]);

    expect(m.composite.available).toBe(true);
    expect(m.composite.flags.includesHistory).toBe(true);
    expect([m.composite.totalVolume, m.composite.valueAreaVolume]).toEqual([142n, 108n]);
    expect([m.composite.rangeLow, m.composite.rangeHigh]).toEqual([99.5, 101.25]);
    const at100 = m.composite.histogram.find((l) => l.price === 100.0)!;
    expect([at100.volume, at100.tapeVolume, at100.bidVolume, at100.askVolume]).toEqual([13n, 10n, 0n, 10n]);
    expect(m.composite.histogram[0]).toEqual({ price: 99.5, volume: 2n, tapeVolume: 0n, bidVolume: 0n, askVolume: 0n });
  });

  it("carries NaN prices as null and every profile as unavailable when nothing is computed", () => {
    const m = market("snapshot-step3-unavailable.bin");
    const raw = golden("snapshot-step3-unavailable.bin").subarray(4 + HEADER_BYTES);
    expect(Number.isNaN(raw.readDoubleLE(168))).toBe(true); // last is NaN on the wire
    expect(m.flags).toEqual({ sessionKnown: false, inSession: false, hasBidAsk: false, bidAskSplitPresent: false });
    expect(m.price.last).toBeNull();
    expect(m.price.bid).toBeNull();
    expect(m.price.spreadTicks).toBeNull();
    expect(m.price.sessionOpen).toBeNull();
    expect(m.price.lastAggressor).toBe("none");
    expect(m.price.sessionBeginUtc).toBe(0n);
    expect(m.vwap.vwap).toBeNull();
    expect(m.vwap.sd2Upper).toBeNull();
    expect(m.coverage.historyState).toBe("failed");
    expect(m.coverage.historyError).toBe("NoDataAvailable: no historical data for the range");
    expect(m.coverage.tapeFromUtc).toBe(0n);
    for (const r of [m.session, m.prior, m.composite]) {
      expect(r.available).toBe(false);
      expect(r.poc).toBeNull();
      expect(r.nodes).toEqual([]);
      expect(r.histogram).toEqual([]);
    }
  });

  it("still decodes the step-1 and step-2 goldens with market null", () => {
    for (const name of ["snapshot.bin", "snapshot-step2.bin", "snapshot-step2-unavailable.bin"]) {
      const frame = decodeFrame(golden(name));
      if (frame.payload.kind !== "snapshot") throw new Error("expected snapshot");
      expect(frame.payload.market).toBeNull();
    }
  });

  it("rejects a market block whose marketBytes does not end the payload", () => {
    const buf = Buffer.from(golden("snapshot-step3.bin"));
    buf.writeUInt32LE(buf.readUInt32LE(4 + HEADER_BYTES + 160) - 1, 4 + HEADER_BYTES + 160);
    expect(() => decodeFrame(buf)).toThrow(/marketBytes/);
  });

  it("rejects an unknown market block version", () => {
    const buf = Buffer.from(golden("snapshot-step3.bin"));
    buf.writeUInt16LE(2, 4 + HEADER_BYTES + 164);
    expect(() => decodeFrame(buf)).toThrow(/market block version/);
  });

  it("rejects a payload that is 161..163 bytes (a length field with nothing behind it)", () => {
    const step2 = golden("snapshot-step2.bin");
    const buf = Buffer.concat([step2, Buffer.alloc(2)]);
    buf.writeUInt32LE(HEADER_BYTES + SNAPSHOT_STEP2_PAYLOAD_BYTES + 2, 0);
    expect(() => decodeFrame(buf)).toThrow(/snapshot payload/);
  });

  it("splits a stream mixing step-3, step-2 and step-1 snapshots", () => {
    const frames = new FrameSplitter().push(golden("stream-step3.bin")).map((f) => decodeFrame(f));
    expect(frames.map((f) => f.header.type)).toEqual([
      FrameType.Hello,
      FrameType.Heartbeat,
      FrameType.Snapshot,
      FrameType.Snapshot,
      FrameType.Snapshot,
    ]);
    const [, , s3, s2, s1] = frames;
    if (s3!.payload.kind !== "snapshot" || s2!.payload.kind !== "snapshot" || s1!.payload.kind !== "snapshot") {
      throw new Error("expected snapshots");
    }
    expect(s3!.payload.market).not.toBeNull();
    expect(s3!.payload.instrumentation).not.toBeNull();
    expect(s2!.payload.market).toBeNull();
    expect(s2!.payload.instrumentation).not.toBeNull();
    expect(s1!.payload.market).toBeNull();
    expect(s1!.payload.instrumentation).toBeNull();
  });
});

describe("cache market reads", () => {
  function primed(): StateCache {
    const cache = new StateCache();
    cache.onConnect();
    for (const f of new FrameSplitter().push(golden("stream-step3.bin"))) cache.applyFrame(decodeFrame(f));
    return cache;
  }

  it("selects the named instrument, or the only one, and refuses to guess", () => {
    const cache = primed();
    const byName = cache.selectSlot("NQ 06-26");
    expect("slot" in byName && byName.slot.index).toBe(1);
    const ambiguous = cache.selectSlot();
    expect("error" in ambiguous && ambiguous.error).toMatch(/several instruments/);
    const missing = cache.selectSlot("ZZ");
    expect("error" in missing && missing.error).toMatch(/no instrument "ZZ"/);

    const single = new StateCache();
    single.onConnect();
    single.applyFrame(decodeFrame(golden("hello-empty.bin")));
    expect("error" in single.selectSlot() && (single.selectSlot() as { error: string }).error).toMatch(/no instruments announced/);
  });

  it("reports market present with the envelope fields every read carries", () => {
    const read = primed().readMarket("NQ 06-26");
    if ("error" in read) throw new Error(read.error);
    expect(read.envelope.market).toEqual({ status: "present", reason: null });
    expect(read.envelope.instrument.name).toBe("NQ 06-26");
    expect(read.envelope.sequence).toBe(9);
    expect(read.envelope.freshness).toBe("live");
    expect(typeof read.envelope.stalenessMs).toBe("number");
    expect(read.envelope.stalenessMs).toBe(read.envelope.staleness.receiveToServeMs);
    expect(read.envelope.depth.state).toBe("unavailable");
    expect(read.envelope.depth.reason).toMatch(/not computed/);
    expect(read.envelope.snapshotWallUtc).toBe("2022-09-28T22:13:28.000Z");
    expect(read.price!.session).toEqual({
      known: true,
      inSession: true,
      begin: "2022-09-28T21:13:20.000Z",
      end: "2022-09-29T20:13:20.000Z",
    });
    expect(read.price!.lastAggressor).toBe("ask");
    expect(read.price!.sessionVolume).toBe(142);
    expect(read.vwap!.volume).toBe(135);
    expect(read.coverage).toEqual({
      historyState: "loaded",
      historyResolution: "minuteSpread",
      historyFromWallUtc: "2022-09-28T21:13:20.000Z",
      historyToWallUtc: "2022-09-28T22:12:20.000Z",
      tapeFromWallUtc: "2022-09-28T22:12:50.000Z",
      historyError: null,
      bidAskSplitPresent: true,
    });
  });

  it("reports market absent for a pre-step-3 snapshot and none before any snapshot", () => {
    const cache = primed();
    const absent = cache.readMarket("ES 06-26"); // received step-2 and step-1 snapshots only
    if ("error" in absent) throw new Error(absent.error);
    expect(absent.envelope.market.status).toBe("absent");
    expect(absent.envelope.market.reason).toMatch(/pre-step-3/);
    expect(absent.price).toBeNull();
    expect(absent.vwap).toBeNull();
    expect(absent.block).toBeNull();

    const fresh = new StateCache();
    fresh.onConnect();
    fresh.applyFrame(decodeFrame(golden("hello-base.bin")));
    const none = fresh.readMarket("ES 06-26");
    if ("error" in none) throw new Error(none.error);
    expect(none.envelope.market.status).toBe("none");
    expect(none.envelope.freshness).toBe("reconnecting");
    expect(none.envelope.stalenessMs).toBeNull();
  });

  it("profile view: histogram off by default, nodes and latest developing checkpoint always on", () => {
    const m = market("snapshot-step3.bin");
    const summary = profileView(m, "session");
    expect(summary.histogram).toBeUndefined();
    expect(summary.developing.series).toBeUndefined();
    expect(summary.developing.latest).toEqual({ at: "2022-09-28T21:43:20.000Z", poc: 100.25, vah: 100.5, val: 100.0 });
    expect(summary.developing.count).toBe(1);
    expect(summary.nodes.map((n) => [n.price, n.kind])).toEqual([
      [100.5, "hvn"],
      [100.75, "lvn"],
      [101.25, "hvn"],
    ]);
    expect(summary.bidAskSplit).toBe("live-tape-only");
    expect(summary.nakedPoc).toBeNull();
    expect(summary.source).toBeNull();

    const full = profileView(m, "session", { includeHistogram: true, includeSeries: true });
    expect(full.histogramLevels).toBe(6);
    expect(full.histogram!.length).toBe(6);
    expect(full.developing.series).toHaveLength(1);
  });

  it("profile view: prior is volume-only with nakedPoc and source; composite splits history from tape per level", () => {
    const m = market("snapshot-step3.bin");
    const prior = profileView(m, "prior", { includeHistogram: true });
    expect(prior.bidAskSplit).toBe("unavailable");
    expect(prior.nakedPoc).toBe(true);
    expect(prior.source).toBe("history");
    expect(prior.histogram).toEqual([]);

    const composite = profileView(m, "composite", { includeHistogram: true });
    const levels = composite.histogram!;
    // History-only level: split null. Mixed level: history share and split both visible.
    expect(levels[0]).toEqual({
      price: 99.5,
      volume: 2,
      historyVolume: 2,
      tapeVolume: 0,
      bidVolume: null,
      askVolume: null,
      unattributedVolume: null,
    });
    expect(levels.find((l) => l.price === 100.0)).toEqual({
      price: 100.0,
      volume: 13,
      historyVolume: 3,
      tapeVolume: 10,
      bidVolume: 0,
      askVolume: 10,
      unattributedVolume: 0,
    });
    // Inside-the-spread prints show up as unattributed, never as bid or ask.
    expect(levels.find((l) => l.price === 100.75)).toMatchObject({ bidVolume: 0, askVolume: 0, unattributedVolume: 5 });
    expect(levelView({ price: 1, volume: 4n, tapeVolume: 4n, bidVolume: 1n, askVolume: 2n }).unattributedVolume).toBe(1);
  });

  it("profile view: unavailable records carry a reason that names the cause", () => {
    const m = market("snapshot-step3-unavailable.bin");
    expect(profileView(m, "session").available).toBe(false);
    expect(profileView(m, "prior").reason).toMatch(/history request failed|NoDataAvailable/);
    expect(profileView(m, "composite").reason).toMatch(/composite unavailable/);
    expect(profileView(m, "prior").nakedPoc).toBeNull();
    const pending: MarketBlock = { ...m, coverage: { ...m.coverage, historyState: "pending", historyError: "" } };
    expect(profileView(pending, "prior").reason).toMatch(/pending/);
    const disabled: MarketBlock = { ...m, coverage: { ...m.coverage, historyState: "disabled", historyError: "" } };
    expect(profileView(disabled, "prior").reason).toMatch(/historyBars/);
  });

  it("a roll blanks the cached market block for that index", () => {
    const cache = primed();
    for (const f of new FrameSplitter().push(golden("stream-roll.bin"))) cache.applyFrame(decodeFrame(f));
    // stream-roll's hello replaces the table; index 1 is now the example "NQ 03-27" with no snapshot.
    const read = cache.readMarket("NQ 03-27");
    if ("error" in read) throw new Error(read.error);
    expect(read.envelope.market.status).toBe("none");
  });
});

describe("step-4 tools", () => {
  type Registered = Record<
    string,
    { description?: string; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }
  >;

  function tools(cache: StateCache): Registered {
    const server = buildServer(cache, { nt8Build: "x", feed: "y", source: "test" });
    return (server as unknown as { _registeredTools: Registered })._registeredTools;
  }

  function primed(): StateCache {
    const cache = new StateCache();
    cache.onConnect();
    for (const f of new FrameSplitter().push(golden("stream-step3.bin"))) cache.applyFrame(decodeFrame(f));
    return cache;
  }

  async function call(t: Registered, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    // Calling the handler directly skips zod's defaults, which is why the tools tolerate
    // scope/includeHistogram being undefined.
    const result = await t[name]!.handler(args);
    return JSON.parse(result.content[0]!.text) as Record<string, any>;
  }

  it("registers the four read tools with conflated-snapshot and live-tape-only wording", () => {
    const t = tools(primed());
    for (const name of ["orderflow_snapshot", "price_state", "vwap_state", "volume_profile"]) {
      expect(t[name], name).toBeDefined();
      expect(t[name]!.description).toMatch(/CONFLATED SNAPSHOT/);
      expect(t[name]!.description).toMatch(/Obsidian Flow/);
      expect(t[name]!.description).toMatch(/stalenessMs/);
    }
    expect(t["orderflow_snapshot"]!.description).toMatch(/LIVE-TAPE-ONLY/);
    expect(t["volume_profile"]!.description).toMatch(/LIVE-TAPE-ONLY/);
    expect(t["volume_profile"]!.description).toMatch(/ONLY when includeHistogram/);
  });

  it("orderflow_snapshot is compact: price + vwap + profile summaries + coverage, no histogram", async () => {
    const out = await call(tools(primed()), "orderflow_snapshot", { name: "NQ 06-26" });
    expect(out.instrument.name).toBe("NQ 06-26");
    expect(out.sequence).toBe(9);
    expect(typeof out.stalenessMs).toBe("number");
    expect(out.depth.state).toBe("unavailable");
    expect(out.market.status).toBe("present");
    expect(out.price.last).toBe(101.25);
    expect(out.vwap.vwap).toBeCloseTo(13591.25 / 135, 12);
    expect(out.profile.session.poc).toBe(100.5);
    expect(out.profile.session.histogram).toBeUndefined();
    expect(out.profile.session.nodes).toHaveLength(3);
    expect(out.profile.prior.nakedPoc).toBe(true);
    expect(out.profile.compositeAvailable).toBe(true);
    expect(out.coverage.tapeFromWallUtc).toBe("2022-09-28T22:12:50.000Z");
  });

  it("volume_profile returns the histogram only on request and honours scope", async () => {
    const t = tools(primed());
    const summary = await call(t, "volume_profile", { name: "NQ 06-26" });
    expect(summary.profile.scope).toBe("session");
    expect(summary.profile.histogram).toBeUndefined();
    expect(summary.profile.developing.series).toHaveLength(1);

    const withHistogram = await call(t, "volume_profile", { name: "NQ 06-26", scope: "composite", includeHistogram: true });
    expect(withHistogram.profile.scope).toBe("composite");
    expect(withHistogram.profile.histogramLevels).toBe(8);
    expect(withHistogram.profile.histogram[0].bidVolume).toBeNull();

    const prior = await call(t, "volume_profile", { name: "NQ 06-26", scope: "prior" });
    expect(prior.profile.source).toBe("history");
    expect(prior.profile.bidAskSplit).toBe("unavailable");
  });

  it("price_state and vwap_state carry the envelope and their block; absent market reads as null with a reason", async () => {
    const t = tools(primed());
    const price = await call(t, "price_state", { name: "NQ 06-26" });
    expect(price.price.spreadTicks).toBe(1);
    expect(price.instrument.identity).toBeNull(); // hello-base has no identity section
    const vwap = await call(t, "vwap_state", { name: "NQ 06-26" });
    expect(vwap.vwap.sd1Lower).toBeCloseTo(100.25751394341868, 12);

    const absent = await call(t, "price_state", { name: "ES 06-26" });
    expect(absent.price).toBeNull();
    expect(absent.market.status).toBe("absent");
  });

  it("refuses to guess between several instruments and says which exist", async () => {
    const out = await call(tools(primed()), "price_state", {});
    expect(out.error).toMatch(/several instruments/);
    expect(out.error).toMatch(/ES 06-26/);
  });
});
