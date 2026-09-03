/**
 * Reference port of addon/SessionVolumeProfile.cs, rule for rule. The AddOn is the only thing
 * that computes profiles in production (spec 2.2: tools answer from the cache and never
 * recompute); this port exists so the profile maths can be pinned by a unit test against
 * hand-computed values on this side of the pipe, and so a reviewer can read the rules in one
 * screen. Change one, change both.
 *
 * Rules (also in schema/wire-v1.md, "profile record"):
 * - Levels are indexed by (price - anchor) / tickSize; the first price anchors the array at its
 *   centre. Prices outside the array are counted in outOfRangeVolume and nowhere else.
 * - POC is the level with the most volume. On a tie the level nearer the session VWAP at the
 *   moment the tie arose wins; with the VWAP unknown, or at equal distance, the lower price wins.
 * - Value area is 70 % of in-range volume grown from the POC one level at a time: the neighbour
 *   with more volume is taken, both on equal volume, and a side with nothing left beyond the
 *   occupied range is never taken.
 * - HVN: volume >= 0.30 x POC volume, strictly above every lower neighbour and at or above every
 *   higher neighbour within 2 levels (levels outside the occupied range count as 0);
 *   strength = volume / POC volume.
 * - LVN: strictly between two consecutive HVNs, strictly below every lower neighbour and at or
 *   below every higher neighbour within 2 levels, the window confined to the levels strictly
 *   between those two HVNs; strength = 1 - volume / min(flanking HVN volumes), kept when >= 0.50.
 * - The strongest maxNodes survive (lower price first on equal strength) and are listed by price.
 * - Bid/ask attribution exists only for tape volume; history adds to volume alone.
 */

export const VALUE_AREA_SHARE = 0.7;
export const NODE_WINDOW = 2;
export const HVN_MIN_RATIO = 0.3;
export const LVN_MIN_STRENGTH = 0.5;

/** Aggressor codes as the AddOn stores them (addon/PriceState.cs). */
export const Side = { None: 0, Bid: 1, Ask: 2, Between: 3 } as const;
export type SideValue = (typeof Side)[keyof typeof Side];

export interface ProfileNode {
  price: number;
  strength: number;
  volume: number;
  kind: "hvn" | "lvn";
}

export interface ProfileLevel {
  price: number;
  volume: number;
  tapeVolume: number;
  bidVolume: number;
  askVolume: number;
}

export class VolumeProfile {
  private readonly volume: number[];
  private readonly tape: number[];
  private readonly bid: number[];
  private readonly ask: number[];
  private anchor = 0;
  private anchored = false;
  private minIdx = -1;
  private maxIdx = -1;
  private total = 0;
  private tapeTotal = 0;
  private outOfRange = 0;
  private includesHistory = false;
  private pocIdx = -1;
  private pocVol = 0;
  private dirty = false;
  private vahIdx = -1;
  private valIdx = -1;
  private vaVol = 0;
  private nodeList: ProfileNode[] = [];

  constructor(
    readonly capacity: number,
    readonly maxNodes: number,
    readonly tickSize: number,
  ) {
    this.volume = new Array<number>(capacity).fill(0);
    this.tape = new Array<number>(capacity).fill(0);
    this.bid = new Array<number>(capacity).fill(0);
    this.ask = new Array<number>(capacity).fill(0);
  }

  get isEmpty(): boolean {
    return this.minIdx < 0;
  }
  get totalVolume(): number {
    return this.total;
  }
  get tapeVolume(): number {
    return this.tapeTotal;
  }
  get outOfRangeVolume(): number {
    return this.outOfRange;
  }
  get hasBidAskSplit(): boolean {
    return this.tapeTotal > 0;
  }
  get historyIncluded(): boolean {
    return this.includesHistory;
  }
  get pocVolume(): number {
    return this.pocVol;
  }
  get valueAreaVolume(): number {
    this.recompute();
    return this.vaVol;
  }
  get poc(): number | null {
    return this.pocIdx < 0 ? null : this.priceAt(this.pocIdx);
  }
  get vah(): number | null {
    this.recompute();
    return this.vahIdx < 0 ? null : this.priceAt(this.vahIdx);
  }
  get val(): number | null {
    this.recompute();
    return this.valIdx < 0 ? null : this.priceAt(this.valIdx);
  }
  get rangeLow(): number | null {
    return this.minIdx < 0 ? null : this.priceAt(this.minIdx);
  }
  get rangeHigh(): number | null {
    return this.maxIdx < 0 ? null : this.priceAt(this.maxIdx);
  }
  get nodes(): ProfileNode[] {
    this.recompute();
    return this.nodeList.map((n) => ({ ...n }));
  }

  priceAt(idx: number): number {
    return this.anchor + idx * this.tickSize;
  }

  indexOf(price: number): number {
    if (!(this.tickSize > 0) || Number.isNaN(price)) return -1;
    if (!this.anchored) {
      const rounded = roundAwayFromZero(price / this.tickSize) * this.tickSize;
      this.anchor = rounded - Math.floor(this.capacity / 2) * this.tickSize;
      this.anchored = true;
    }
    const idx = roundAwayFromZero((price - this.anchor) / this.tickSize);
    if (idx < 0 || idx >= this.capacity) return -1;
    return idx;
  }

  volumeAtPrice(price: number): number {
    if (!this.anchored) return 0;
    const idx = this.indexOf(price);
    return idx < 0 ? 0 : this.volume[idx]!;
  }

  addTrade(price: number, volume: number, side: SideValue, vwap: number | null): void {
    if (volume <= 0) return;
    const idx = this.indexOf(price);
    if (idx < 0) {
      this.outOfRange += volume;
      return;
    }
    this.tape[idx]! += volume;
    this.tapeTotal += volume;
    if (side === Side.Bid) this.bid[idx]! += volume;
    else if (side === Side.Ask) this.ask[idx]! += volume;
    this.accumulate(idx, volume, vwap);
  }

  addHistory(price: number, volume: number, vwap: number | null): void {
    if (volume <= 0) return;
    const idx = this.indexOf(price);
    if (idx < 0) {
      this.outOfRange += volume;
      return;
    }
    this.includesHistory = true;
    this.accumulate(idx, volume, vwap);
  }

  /** A history bar: volume spread evenly over low..high, integer remainder to the close. */
  addHistoryBar(low: number, high: number, close: number, volume: number, vwap: number | null): void {
    if (volume <= 0 || !(this.tickSize > 0)) return;
    if (Number.isNaN(low) || Number.isNaN(high) || high < low) {
      this.addHistory(close, volume, vwap);
      return;
    }
    const levels = roundAwayFromZero((high - low) / this.tickSize) + 1;
    if (levels <= 1) {
      this.addHistory(close, volume, vwap);
      return;
    }
    const share = Math.floor(volume / levels);
    const remainder = volume - share * levels;
    if (share > 0) {
      for (let i = 0; i < levels; i++) this.addHistory(low + i * this.tickSize, share, vwap);
    }
    if (remainder > 0) this.addHistory(close, remainder, vwap);
  }

  /** Every occupied level of another profile, split preserved. */
  merge(other: VolumeProfile, vwap: number | null): void {
    if (other.isEmpty || !(this.tickSize > 0)) return;
    for (let i = other.minIdx; i <= other.maxIdx; i++) {
      const v = other.volume[i]!;
      if (v <= 0) continue;
      const idx = this.indexOf(other.priceAt(i));
      if (idx < 0) {
        this.outOfRange += v;
        continue;
      }
      this.tape[idx]! += other.tape[i]!;
      this.tapeTotal += other.tape[i]!;
      this.bid[idx]! += other.bid[i]!;
      this.ask[idx]! += other.ask[i]!;
      if (other.includesHistory) this.includesHistory = true;
      this.accumulate(idx, v, vwap);
    }
    this.outOfRange += other.outOfRange;
  }

  private accumulate(idx: number, volume: number, vwap: number | null): void {
    const v = this.volume[idx]! + volume;
    this.volume[idx] = v;
    this.total += volume;
    if (this.minIdx < 0 || idx < this.minIdx) this.minIdx = idx;
    if (this.maxIdx < 0 || idx > this.maxIdx) this.maxIdx = idx;
    if (v > this.pocVol) {
      this.pocVol = v;
      this.pocIdx = idx;
    } else if (v === this.pocVol && idx !== this.pocIdx) {
      if (this.tieBreakWins(idx, this.pocIdx, vwap)) this.pocIdx = idx;
    }
    this.dirty = true;
  }

  private tieBreakWins(candidate: number, incumbent: number, vwap: number | null): boolean {
    if (vwap === null || Number.isNaN(vwap)) return candidate < incumbent;
    const dc = Math.abs(this.priceAt(candidate) - vwap);
    const di = Math.abs(this.priceAt(incumbent) - vwap);
    if (dc < di) return true;
    if (dc > di) return false;
    return candidate < incumbent;
  }

  recompute(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.pocIdx < 0) {
      this.vahIdx = -1;
      this.valIdx = -1;
      this.vaVol = 0;
      this.nodeList = [];
      return;
    }
    this.computeValueArea();
    this.findNodes();
  }

  private computeValueArea(): void {
    const target = this.total * VALUE_AREA_SHARE;
    let lo = this.pocIdx;
    let hi = this.pocIdx;
    let acc = this.volume[this.pocIdx]!;
    while (acc < target) {
      const up = hi + 1 <= this.maxIdx ? this.volume[hi + 1]! : -1;
      const down = lo - 1 >= this.minIdx ? this.volume[lo - 1]! : -1;
      if (up < 0 && down < 0) break;
      if (up > down) {
        hi++;
        acc += up;
      } else if (down > up) {
        lo--;
        acc += down;
      } else {
        hi++;
        lo--;
        acc += up + down;
      }
    }
    this.vahIdx = hi;
    this.valIdx = lo;
    this.vaVol = acc;
  }

  private findNodes(): void {
    const pocVol = this.pocVol;
    if (pocVol <= 0) {
      this.nodeList = [];
      return;
    }
    const candidates: ProfileNode[] = [];
    for (let i = this.minIdx; i <= this.maxIdx; i++) {
      const v = this.volume[i]!;
      if (v <= 0 || v < pocVol * HVN_MIN_RATIO) continue;
      if (!this.isPeak(i, v)) continue;
      candidates.push({ price: this.priceAt(i), strength: v / pocVol, volume: v, kind: "hvn" });
    }
    const hvnCount = candidates.length;
    for (let h = 0; h + 1 < hvnCount; h++) {
      const below = this.indexOf(candidates[h]!.price);
      const above = this.indexOf(candidates[h + 1]!.price);
      const flank = Math.min(candidates[h]!.volume, candidates[h + 1]!.volume);
      if (flank <= 0) continue;
      for (let i = below + 1; i < above; i++) {
        const v = this.volume[i]!;
        const strength = 1 - v / flank;
        if (strength < LVN_MIN_STRENGTH) continue;
        if (!this.isTrough(i, v, below, above)) continue;
        candidates.push({ price: this.priceAt(i), strength, volume: v, kind: "lvn" });
      }
    }
    candidates.sort((a, b) => (b.strength !== a.strength ? b.strength - a.strength : a.price - b.price));
    const kept = candidates.slice(0, this.maxNodes);
    kept.sort((a, b) => a.price - b.price);
    this.nodeList = kept;
  }

  private isPeak(i: number, v: number): boolean {
    for (let j = i - NODE_WINDOW; j <= i + NODE_WINDOW; j++) {
      if (j === i) continue;
      const o = j < this.minIdx || j > this.maxIdx ? 0 : this.volume[j]!;
      if (j < i ? v <= o : v < o) return false;
    }
    return true;
  }

  private isTrough(i: number, v: number, below: number, above: number): boolean {
    const from = Math.max(i - NODE_WINDOW, below + 1);
    const to = Math.min(i + NODE_WINDOW, above - 1);
    for (let j = from; j <= to; j++) {
      if (j === i) continue;
      const o = this.volume[j]!;
      if (j < i ? v >= o : v > o) return false;
    }
    return true;
  }

  /** Histogram window of at most `levels` levels around the POC, clipped to the occupied range. */
  histogram(levels: number): ProfileLevel[] {
    if (this.pocIdx < 0 || levels <= 0) return [];
    let start = this.pocIdx - Math.floor(levels / 2);
    if (start < this.minIdx) start = this.minIdx;
    let end = start + levels - 1;
    if (end > this.maxIdx) {
      end = this.maxIdx;
      start = end - levels + 1;
      if (start < this.minIdx) start = this.minIdx;
    }
    const out: ProfileLevel[] = [];
    for (let idx = start; idx <= end; idx++) {
      out.push({
        price: this.priceAt(idx),
        volume: this.volume[idx]!,
        tapeVolume: this.tape[idx]!,
        bidVolume: this.bid[idx]!,
        askVolume: this.ask[idx]!,
      });
    }
    return out;
  }
}

/** .NET Math.Round(x, MidpointRounding.AwayFromZero) for the index arithmetic. */
export function roundAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Volume-weighted Welford, the same recurrence as addon/VwapCalculator.cs, so the VWAP the
 * unit test feeds to the tie-break is the one the AddOn would have had at that moment.
 */
export class Vwap {
  private weight = 0;
  private mean = 0;
  private m2 = 0;

  add(price: number, volume: number): void {
    if (volume <= 0 || Number.isNaN(price)) return;
    const w = this.weight + volume;
    const delta = price - this.mean;
    this.mean += delta * (volume / w);
    this.m2 += volume * delta * (price - this.mean);
    this.weight = w;
  }

  get value(): number | null {
    return this.weight > 0 ? this.mean : null;
  }

  get stdDev(): number | null {
    if (this.weight <= 0) return null;
    const v = this.m2 / this.weight;
    return v > 0 ? Math.sqrt(v) : 0;
  }

  get totalWeight(): number {
    return this.weight;
  }
}

/** addon/PriceState.cs OnLast: at or above the ask is ask volume, at or below the bid is bid. */
export function classify(price: number, bid: number | null, ask: number | null): SideValue {
  if (bid === null || ask === null) return Side.None;
  if (price >= ask) return Side.Ask;
  if (price <= bid) return Side.Bid;
  return Side.Between;
}
