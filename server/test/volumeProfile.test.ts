/**
 * Profile maths pinned to values computed by hand (worked in the comments), against the
 * TypeScript port of addon/SessionVolumeProfile.cs. The same fixture is what
 * schema/golden/snapshot-step3.bin carries, so the decoder test and this test agree on the
 * numbers by construction.
 */

import { describe, expect, it } from "vitest";

import { Side, VolumeProfile, Vwap, classify, roundAwayFromZero } from "../src/profile/volumeProfile.js";

const TICK = 0.25;

interface Print {
  bid: number;
  ask: number;
  price: number;
  size: number;
}

// Seven prints. Bid/ask are set before each print so the aggressor rule is exercised.
//   1. 100.00 x10 at the ask           -> 100.00: 10 (ask)
//   2. 100.25 x30 at the bid           -> 100.25: 30 (bid)          POC 100.25
//   3. 100.50 x30 at the ask           -> 100.50: 30 (ask)          tie 30/30; VWAP after this
//                                          print = 7022.5/70 = 100.3214, nearer 100.25 -> POC stays
//   4. 100.75 x5  inside the spread    -> 100.75: 5 (unattributed)
//   5. 101.00 x25 at the ask           -> 101.00: 25 (ask)
//   6. 100.50 x5  at the bid           -> 100.50: 35 (30 ask + 5 bid)   POC 100.50
//   7. 101.25 x30 at the ask           -> 101.25: 30 (ask)
// Levels 100.00..101.25 = [10, 30, 35, 5, 25, 30], total 135.
const FIXTURE_A: Print[] = [
  { bid: 99.75, ask: 100.0, price: 100.0, size: 10 },
  { bid: 100.25, ask: 100.5, price: 100.25, size: 30 },
  { bid: 100.25, ask: 100.5, price: 100.5, size: 30 },
  { bid: 100.5, ask: 101.0, price: 100.75, size: 5 },
  { bid: 100.75, ask: 101.0, price: 101.0, size: 25 },
  { bid: 100.5, ask: 100.75, price: 100.5, size: 5 },
  { bid: 101.0, ask: 101.25, price: 101.25, size: 30 },
];

function runFixture(prints: Print[]): { profile: VolumeProfile; vwap: Vwap } {
  const profile = new VolumeProfile(1024, 16, TICK);
  const vwap = new Vwap();
  for (const p of prints) {
    const side = classify(p.price, p.bid, p.ask);
    vwap.add(p.price, p.size);
    profile.addTrade(p.price, p.size, side, vwap.value);
  }
  return { profile, vwap };
}

describe("volume profile maths (port of addon/SessionVolumeProfile.cs)", () => {
  it("classifies the aggressor at or above the ask / at or below the bid", () => {
    expect(classify(100.0, 99.75, 100.0)).toBe(Side.Ask);
    expect(classify(100.25, 100.25, 100.5)).toBe(Side.Bid);
    expect(classify(100.75, 100.5, 101.0)).toBe(Side.Between);
    expect(classify(100.0, null, 100.0)).toBe(Side.None);
  });

  it("POC: 100.50 with 35 contracts; the 30/30 tie after print 3 went to the level nearer VWAP", () => {
    const { profile } = runFixture(FIXTURE_A.slice(0, 3));
    // After print 3 both 100.25 and 100.50 hold 30. VWAP = (1000 + 3007.5 + 3015) / 70 = 100.3214;
    // |100.25 - VWAP| = 0.0714 < |100.50 - VWAP| = 0.1786, so the incumbent 100.25 keeps the POC.
    expect(profile.poc).toBe(100.25);
    expect(profile.pocVolume).toBe(30);

    const full = runFixture(FIXTURE_A).profile;
    expect(full.poc).toBe(100.5);
    expect(full.pocVolume).toBe(35);
    expect(full.totalVolume).toBe(135);
    expect(full.tapeVolume).toBe(135);
    expect(full.rangeLow).toBe(100.0);
    expect(full.rangeHigh).toBe(101.25);
    expect(full.outOfRangeVolume).toBe(0);
    expect(full.hasBidAskSplit).toBe(true);
    expect(full.historyIncluded).toBe(false);
  });

  it("value area: 70 % of 135 = 94.5 grown from the POC gives VAL 100.00, VAH 101.00, 105 contracts", () => {
    // Start 100.50 (35). Neighbours: up 100.75 (5) vs down 100.25 (30) -> down, acc 65.
    // up 5 vs down 100.00 (10) -> down, acc 75. up 5 vs down (none) -> up, acc 80.
    // up 101.00 (25) vs down (none) -> up, acc 105 >= 94.5, stop. lo = 100.00, hi = 101.00.
    const { profile } = runFixture(FIXTURE_A);
    expect(profile.val).toBe(100.0);
    expect(profile.vah).toBe(101.0);
    expect(profile.valueAreaVolume).toBe(105);
  });

  it("nodes: HVN 100.50 (1.0), LVN 100.75 (5/6), HVN 101.25 (6/7); 101.00 and 100.25 are not peaks", () => {
    // Window +-2 over [10, 30, 35, 5, 25, 30]:
    //   100.50 (35): > 10, > 30 below; >= 5, >= 25 above -> HVN, strength 35/35 = 1.
    //   101.25 (30): > 5, > 25 below; nothing above -> HVN, strength 30/35 = 6/7.
    //   101.00 (25): 25 >= 35 fails. 100.25 (30): 30 >= 35 fails. 100.00 (10): 10 >= 30 fails.
    //   LVN between 100.50 and 101.25: 100.75 (5): < 30, < 35 below; <= 25, <= 30 above;
    //   strength = 1 - 5 / min(35, 30) = 1 - 1/6 = 5/6 >= 0.5. 101.00 (25) is not a trough (25 >= 5).
    const { profile } = runFixture(FIXTURE_A);
    const nodes = profile.nodes;
    expect(nodes.map((n) => [n.price, n.kind, n.volume])).toEqual([
      [100.5, "hvn", 35],
      [100.75, "lvn", 5],
      [101.25, "hvn", 30],
    ]);
    expect(nodes[0]!.strength).toBe(1);
    expect(nodes[1]!.strength).toBeCloseTo(5 / 6, 12);
    expect(nodes[2]!.strength).toBeCloseTo(6 / 7, 12);
  });

  it("histogram carries the tape-only split per level", () => {
    const { profile } = runFixture(FIXTURE_A);
    const levels = profile.histogram(64);
    expect(levels.map((l) => [l.price, l.volume, l.tapeVolume, l.bidVolume, l.askVolume])).toEqual([
      [100.0, 10, 10, 0, 10],
      [100.25, 30, 30, 30, 0],
      [100.5, 35, 35, 5, 30],
      [100.75, 5, 5, 0, 0], // inside the spread: neither side
      [101.0, 25, 25, 0, 25],
      [101.25, 30, 30, 0, 30],
    ]);
    // A window smaller than the range starts floor(levels / 2) below the POC and is clipped to
    // the occupied range.
    expect(profile.histogram(3).map((l) => l.price)).toEqual([100.25, 100.5, 100.75]);
    expect(profile.histogram(4).map((l) => l.price)).toEqual([100.0, 100.25, 100.5, 100.75]);
    expect(profile.histogram(5).map((l) => l.price)).toEqual([100.0, 100.25, 100.5, 100.75, 101.0]);
  });

  it("VWAP: 13591.25 / 135 = 100.6759..., Welford variance equals the direct formula", () => {
    const { vwap } = runFixture(FIXTURE_A);
    const mean = 13591.25 / 135;
    expect(vwap.value).toBeCloseTo(mean, 12);
    expect(vwap.totalWeight).toBe(135);
    let m2 = 0;
    for (const p of FIXTURE_A) m2 += p.size * (p.price - mean) ** 2;
    expect(vwap.stdDev).toBeCloseTo(Math.sqrt(m2 / 135), 12);
    expect(vwap.stdDev).toBeCloseTo(0.41841198250723066, 12);
  });

  it("history bar: 7 contracts over 99.50..100.00 close 100.00 -> 2, 2, 3 with no split", () => {
    // 3 levels, share = floor(7 / 3) = 2, remainder 1 to the close level 100.00.
    const h = new VolumeProfile(1024, 16, TICK);
    h.addHistoryBar(99.5, 100.0, 100.0, 7, null);
    expect(h.histogram(64).map((l) => [l.price, l.volume, l.tapeVolume])).toEqual([
      [99.5, 2, 0],
      [99.75, 2, 0],
      [100.0, 3, 0],
    ]);
    expect(h.hasBidAskSplit).toBe(false);
    expect(h.historyIncluded).toBe(true);
    // 70 % of 7 = 4.9: POC 100.00 (3), then down 99.75 (2) -> 5 >= 4.9. VAH 100.00, VAL 99.75.
    expect(h.poc).toBe(100.0);
    expect(h.vah).toBe(100.0);
    expect(h.val).toBe(99.75);
    expect(h.valueAreaVolume).toBe(5);
    expect(h.nodes.map((n) => [n.price, n.kind, n.strength])).toEqual([[100.0, "hvn", 1]]);
  });

  it("composite merge of history and tape: total 142, VA 108, range 99.50..101.25, 100.00 = 3 history + 10 tape", () => {
    const h = new VolumeProfile(1024, 16, TICK);
    h.addHistoryBar(99.5, 100.0, 100.0, 7, null);
    const { profile, vwap } = runFixture(FIXTURE_A);
    const m = new VolumeProfile(1024, 16, TICK);
    m.merge(h, null);
    m.merge(profile, vwap.value);
    // 70 % of 142 = 99.4. POC 100.50 (35); down 30 -> 65; down 100.00 (13) vs up 5 -> 78;
    // down 99.75 (2) vs up 5 -> up, 83; up 101.00 (25) vs down 2 -> 108 >= 99.4. VAL 100, VAH 101.
    expect(m.totalVolume).toBe(142);
    expect(m.tapeVolume).toBe(135);
    expect(m.poc).toBe(100.5);
    expect(m.vah).toBe(101.0);
    expect(m.val).toBe(100.0);
    expect(m.valueAreaVolume).toBe(108);
    expect(m.rangeLow).toBe(99.5);
    expect(m.rangeHigh).toBe(101.25);
    expect(m.historyIncluded).toBe(true);
    const at100 = m.histogram(64).find((l) => l.price === 100.0)!;
    expect([at100.volume, at100.tapeVolume, at100.bidVolume, at100.askVolume]).toEqual([13, 10, 0, 10]);
    expect(m.nodes.map((n) => [n.price, n.kind])).toEqual([
      [100.5, "hvn"],
      [100.75, "lvn"],
      [101.25, "hvn"],
    ]);
  });

  it("POC tie-break: nearer VWAP wins; equidistant -> lower price; VWAP unknown -> lower price", () => {
    const c = new VolumeProfile(1024, 16, TICK);
    c.addHistory(100.0, 10, null);
    c.addHistory(101.0, 10, 100.75); // |101 - 100.75| = 0.25 < |100 - 100.75| = 0.75
    expect(c.poc).toBe(101.0);
    c.addHistory(100.5, 10, 100.75); // equidistant (0.25 each) -> lower price
    expect(c.poc).toBe(100.5);
    c.addHistory(102.0, 10, null); // unknown VWAP -> lower (incumbent) stays
    expect(c.poc).toBe(100.5);
    c.addHistory(102.0, 1, null); // strictly more volume always wins
    expect(c.poc).toBe(102.0);
  });

  it("bounds: prices outside the array are counted, never indexed", () => {
    const p = new VolumeProfile(16, 4, TICK); // anchor = first price - 8 ticks
    p.addTrade(100.0, 5, Side.Ask, null);
    p.addTrade(100.0 + 7 * TICK, 1, Side.Ask, null); // idx 15, last valid
    p.addTrade(100.0 + 8 * TICK, 9, Side.Ask, null); // idx 16, out of range
    p.addTrade(100.0 - 9 * TICK, 4, Side.Bid, null); // idx -1, out of range
    expect(p.totalVolume).toBe(6);
    expect(p.outOfRangeVolume).toBe(13);
    expect(p.rangeHigh).toBe(101.75);
    expect(p.poc).toBe(100.0);
  });

  it("node cap keeps the strongest, lower price first on equal strength, listed by price", () => {
    // Three equal peaks at 100.00, 101.00, 102.00 (10 each) with empty levels between them.
    // Every peak is an HVN of strength 1, and the lowest empty level of each gap (100.25,
    // 101.25) is an LVN of strength 1 - 0/10 = 1: a gap is the strongest possible low-volume
    // node. All five tie on strength, so the cap of 2 keeps the two lowest prices.
    const p = new VolumeProfile(1024, 2, TICK);
    for (const px of [100.0, 101.0, 102.0]) p.addHistory(px, 10, null);
    expect(p.nodes.map((n) => [n.price, n.kind, n.strength])).toEqual([
      [100.0, "hvn", 1],
      [100.25, "lvn", 1],
    ]);
    const all = new VolumeProfile(1024, 16, TICK);
    for (const px of [100.0, 101.0, 102.0]) all.addHistory(px, 10, null);
    expect(all.nodes.map((n) => [n.price, n.kind])).toEqual([
      [100.0, "hvn"],
      [100.25, "lvn"],
      [101.0, "hvn"],
      [101.25, "lvn"],
      [102.0, "hvn"],
    ]);
  });

  it("empty profile reports nothing", () => {
    const p = new VolumeProfile(64, 4, TICK);
    expect(p.isEmpty).toBe(true);
    expect(p.poc).toBeNull();
    expect(p.vah).toBeNull();
    expect(p.nodes).toEqual([]);
    expect(p.histogram(8)).toEqual([]);
  });

  it("roundAwayFromZero matches .NET MidpointRounding.AwayFromZero", () => {
    expect(roundAwayFromZero(2.5)).toBe(3);
    expect(roundAwayFromZero(-2.5)).toBe(-3);
    expect(roundAwayFromZero(2.4)).toBe(2);
  });
});
