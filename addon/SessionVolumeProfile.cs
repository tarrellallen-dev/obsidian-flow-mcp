// Obsidian Flow MCP - AddOn
// Step 3, spec section 4 "profile" blocks: per-price volume in a preallocated array indexed by
// (price - anchor) / tickSize, with POC, 70 % value area, developing checkpoints, HVN/LVN nodes
// and a histogram window around the POC. Publisher thread only. Every array is sized once from
// config; steady-state Add and Recompute allocate nothing.
//
// Bid/ask attribution exists only for volume this AddOn saw on the live tape. History folded in
// from BarsRequest bars adds to Volume alone; TapeVolume, BidVolume and AskVolume stay untouched
// for it, so a level's history share is Volume - TapeVolume and a consumer can tell the two apart.
//
// The same rules are mirrored, line for line, by server/src/profile/volumeProfile.ts, which the
// TypeScript unit test pins to hand-computed values. Change one, change both.
// .NET Framework 4.8. ASCII only.

using System;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public static class ProfileNodeKind
    {
        public const byte Hvn = 1;
        public const byte Lvn = 2;
    }

    // Blittable so the node table is a plain preallocated array.
    public struct ProfileNode
    {
        public double Price;
        public double Strength;     // 0..1, see FindNodes
        public long Volume;
        public byte Kind;
    }

    // POC/VAH/VAL as they stood at a fixed-time checkpoint (spec: developing values).
    public struct ProfileCheckpoint
    {
        public long AtUtcTicks;
        public double Poc;
        public double Vah;
        public double Val;
    }

    public sealed class SessionVolumeProfile
    {
        // Value area share of total in-range volume.
        public const double ValueAreaShare = 0.70;

        // Node rules (documented in schema/wire-v1.md, "nodes"). Window is levels either side.
        public const int NodeWindow = 2;
        public const double HvnMinRatio = 0.30;     // level volume / POC volume
        public const double LvnMinStrength = 0.50;  // 1 - level volume / smaller flanking HVN

        public const int MaxCheckpoints = 48;

        private readonly int _capacity;
        private readonly long[] _volume;
        private readonly long[] _tape;
        private readonly long[] _bid;
        private readonly long[] _ask;

        private readonly ProfileNode[] _nodes;
        private readonly ProfileNode[] _candidates;
        private readonly int _maxNodes;
        private int _nodeCount;

        private readonly ProfileCheckpoint[] _checkpoints;
        private int _checkpointCount;

        private double _tickSize;
        private double _anchor;
        private bool _anchored;

        private int _minIdx = -1;
        private int _maxIdx = -1;
        private long _total;
        private long _tapeTotal;
        private long _outOfRange;
        private bool _includesHistory;

        private int _pocIdx = -1;
        private long _pocVolume;

        // Value area and nodes are recomputed lazily, at frame time, only when something changed.
        private bool _dirty;
        private int _vahIdx = -1;
        private int _valIdx = -1;
        private long _valueAreaVolume;

        public SessionVolumeProfile(int capacity, int maxNodes, double tickSize)
        {
            if (capacity < 16)
                capacity = 16;
            if (maxNodes < 1)
                maxNodes = 1;
            _capacity = capacity;
            _volume = new long[capacity];
            _tape = new long[capacity];
            _bid = new long[capacity];
            _ask = new long[capacity];
            _maxNodes = maxNodes;
            _nodes = new ProfileNode[maxNodes];
            // Every level in the occupied range could in principle qualify; the candidate table
            // is bounded by capacity so FindNodes never needs to grow it.
            _candidates = new ProfileNode[capacity];
            _checkpoints = new ProfileCheckpoint[MaxCheckpoints];
            Reset(tickSize);
        }

        public int Capacity { get { return _capacity; } }
        public double TickSize { get { return _tickSize; } }
        public bool IsEmpty { get { return _minIdx < 0; } }
        public bool IsUsable { get { return _tickSize > 0.0; } }
        public long TotalVolume { get { return _total; } }
        public long TapeVolume { get { return _tapeTotal; } }
        public long OutOfRangeVolume { get { return _outOfRange; } }
        public bool IncludesHistory { get { return _includesHistory; } }
        public bool HasBidAskSplit { get { return _tapeTotal > 0; } }
        public long PocVolume { get { return _pocVolume; } }
        public long ValueAreaVolume { get { return _valueAreaVolume; } }
        public int NodeCount { get { return _nodeCount; } }
        public ProfileNode[] Nodes { get { return _nodes; } }
        public int CheckpointCount { get { return _checkpointCount; } }
        public ProfileCheckpoint[] Checkpoints { get { return _checkpoints; } }

        public double Poc { get { return _pocIdx < 0 ? double.NaN : PriceAt(_pocIdx); } }
        public double Vah { get { return _vahIdx < 0 ? double.NaN : PriceAt(_vahIdx); } }
        public double Val { get { return _valIdx < 0 ? double.NaN : PriceAt(_valIdx); } }
        public double RangeLow { get { return _minIdx < 0 ? double.NaN : PriceAt(_minIdx); } }
        public double RangeHigh { get { return _maxIdx < 0 ? double.NaN : PriceAt(_maxIdx); } }

        // Clears every accumulator. Arrays are wiped over the previously occupied range only, so
        // a reset costs the size of the last session, not the capacity.
        public void Reset(double tickSize)
        {
            if (_minIdx >= 0)
            {
                Array.Clear(_volume, _minIdx, _maxIdx - _minIdx + 1);
                Array.Clear(_tape, _minIdx, _maxIdx - _minIdx + 1);
                Array.Clear(_bid, _minIdx, _maxIdx - _minIdx + 1);
                Array.Clear(_ask, _minIdx, _maxIdx - _minIdx + 1);
            }
            _tickSize = tickSize;
            _anchored = false;
            _anchor = 0.0;
            _minIdx = -1;
            _maxIdx = -1;
            _total = 0;
            _tapeTotal = 0;
            _outOfRange = 0;
            _includesHistory = false;
            _pocIdx = -1;
            _pocVolume = 0;
            _vahIdx = -1;
            _valIdx = -1;
            _valueAreaVolume = 0;
            _nodeCount = 0;
            _checkpointCount = 0;
            _dirty = false;
        }

        public double PriceAt(int idx)
        {
            return _anchor + idx * _tickSize;
        }

        // Index of a price, or -1 when it falls outside the array. The first price anchors the
        // array at its centre, so a session can travel capacity / 2 ticks either way from it.
        public int IndexOf(double price)
        {
            if (!IsUsable || double.IsNaN(price))
                return -1;
            if (!_anchored)
            {
                double rounded = Math.Round(price / _tickSize, MidpointRounding.AwayFromZero) * _tickSize;
                _anchor = rounded - (_capacity / 2) * _tickSize;
                _anchored = true;
            }
            double raw = (price - _anchor) / _tickSize;
            long idx = (long)Math.Round(raw, MidpointRounding.AwayFromZero);
            if (idx < 0 || idx >= _capacity)
                return -1;
            return (int)idx;
        }

        public long VolumeAt(int idx) { return _volume[idx]; }
        public long TapeAt(int idx) { return _tape[idx]; }
        public long BidAt(int idx) { return _bid[idx]; }
        public long AskAt(int idx) { return _ask[idx]; }
        public int MinIndex { get { return _minIdx; } }
        public int MaxIndex { get { return _maxIdx; } }

        // Volume at an exact price level, 0 when the level is empty or outside the array.
        public long VolumeAtPrice(double price)
        {
            if (!_anchored)
                return 0;
            int idx = IndexOf(price);
            return idx < 0 ? 0 : _volume[idx];
        }

        // One print from the live tape. side is an Aggressor value; vwap (NaN allowed) settles a
        // POC tie deterministically: the tied level nearer the session VWAP wins, and at equal
        // distance the lower price does.
        public void AddTrade(double price, long volume, byte side, double vwap)
        {
            if (volume <= 0)
                return;
            int idx = IndexOf(price);
            if (idx < 0)
            {
                _outOfRange += volume;
                return;
            }
            _tape[idx] += volume;
            _tapeTotal += volume;
            if (side == Aggressor.Bid)
                _bid[idx] += volume;
            else if (side == Aggressor.Ask)
                _ask[idx] += volume;
            Accumulate(idx, volume, vwap);
        }

        // Volume from history (no split). Goes to Volume only.
        public void AddHistory(double price, long volume, double vwap)
        {
            if (volume <= 0)
                return;
            int idx = IndexOf(price);
            if (idx < 0)
            {
                _outOfRange += volume;
                return;
            }
            _includesHistory = true;
            Accumulate(idx, volume, vwap);
        }

        // A history bar with a price range: its volume is spread evenly over every tick from low
        // to high, and the remainder of the integer division goes to the close level. This is the
        // usual minute-bar approximation; it is labelled as such on the wire (historyResolution).
        public void AddHistoryBar(double low, double high, double close, long volume, double vwap)
        {
            if (volume <= 0 || !IsUsable)
                return;
            if (double.IsNaN(low) || double.IsNaN(high) || high < low)
            {
                AddHistory(close, volume, vwap);
                return;
            }
            long levels = (long)Math.Round((high - low) / _tickSize, MidpointRounding.AwayFromZero) + 1;
            if (levels <= 1)
            {
                AddHistory(close, volume, vwap);
                return;
            }
            long share = volume / levels;
            long remainder = volume - share * levels;
            if (share > 0)
            {
                for (long i = 0; i < levels; i++)
                    AddHistory(low + i * _tickSize, share, vwap);
            }
            if (remainder > 0)
                AddHistory(close, remainder, vwap);
        }

        // Adds every occupied level of another profile, split preserved. Used to seed the
        // composite from the prior session and the current session.
        public void Merge(SessionVolumeProfile other, double vwap)
        {
            if (other == null || other.IsEmpty || !IsUsable)
                return;
            for (int i = other._minIdx; i <= other._maxIdx; i++)
            {
                long v = other._volume[i];
                if (v <= 0)
                    continue;
                int idx = IndexOf(other.PriceAt(i));
                if (idx < 0)
                {
                    _outOfRange += v;
                    continue;
                }
                _tape[idx] += other._tape[i];
                _tapeTotal += other._tape[i];
                _bid[idx] += other._bid[i];
                _ask[idx] += other._ask[i];
                if (other._includesHistory)
                    _includesHistory = true;
                Accumulate(idx, v, vwap);
            }
            _outOfRange += other._outOfRange;
        }

        private void Accumulate(int idx, long volume, double vwap)
        {
            long v = _volume[idx] + volume;
            _volume[idx] = v;
            _total += volume;
            if (_minIdx < 0 || idx < _minIdx)
                _minIdx = idx;
            if (_maxIdx < 0 || idx > _maxIdx)
                _maxIdx = idx;

            if (v > _pocVolume)
            {
                _pocVolume = v;
                _pocIdx = idx;
            }
            else if (v == _pocVolume && idx != _pocIdx)
            {
                if (TieBreakWins(idx, _pocIdx, vwap))
                    _pocIdx = idx;
            }
            _dirty = true;
        }

        // Deterministic POC tie-break (spec section 4: toward the session VWAP side). The level
        // nearer the VWAP wins; when the VWAP is unknown or both are equidistant the lower price
        // wins. Ties are settled when they arise, from the VWAP at that moment, so the result is
        // a pure function of the event order.
        private bool TieBreakWins(int candidate, int incumbent, double vwap)
        {
            if (double.IsNaN(vwap))
                return candidate < incumbent;
            double dc = Math.Abs(PriceAt(candidate) - vwap);
            double di = Math.Abs(PriceAt(incumbent) - vwap);
            if (dc < di)
                return true;
            if (dc > di)
                return false;
            return candidate < incumbent;
        }

        // Value area and nodes, only when something changed since the last call. Cost is
        // proportional to the occupied range, never to the array capacity.
        public void Recompute()
        {
            if (!_dirty)
                return;
            _dirty = false;
            if (_pocIdx < 0)
            {
                _vahIdx = -1;
                _valIdx = -1;
                _valueAreaVolume = 0;
                _nodeCount = 0;
                return;
            }
            ComputeValueArea();
            FindNodes();
        }

        // 70 % of in-range volume, grown one level at a time from the POC: whichever neighbour
        // (the level just above the current top, the level just below the current bottom) holds
        // more volume is taken; at equal volume both are taken; a side with nothing left beyond
        // the occupied range is never taken.
        private void ComputeValueArea()
        {
            double target = _total * ValueAreaShare;
            int lo = _pocIdx;
            int hi = _pocIdx;
            long acc = _volume[_pocIdx];

            while (acc < target)
            {
                long up = hi + 1 <= _maxIdx ? _volume[hi + 1] : -1L;
                long down = lo - 1 >= _minIdx ? _volume[lo - 1] : -1L;
                if (up < 0 && down < 0)
                    break;
                if (up > down)
                {
                    hi++;
                    acc += up;
                }
                else if (down > up)
                {
                    lo--;
                    acc += down;
                }
                else
                {
                    hi++;
                    lo--;
                    acc += up + down;
                }
            }

            _vahIdx = hi;
            _valIdx = lo;
            _valueAreaVolume = acc;
        }

        // HVN: a level whose volume is at least HvnMinRatio of the POC's and is the peak of its
        // window (strictly above every lower neighbour, at or above every higher one, so a
        // plateau yields its lowest price once). Strength = volume / POC volume.
        // LVN: a level strictly between two HVNs that is the trough of its window (strictly
        // below every lower neighbour, at or below every higher one), with
        // strength = 1 - volume / min(flanking HVN volumes) of at least LvnMinStrength.
        // Levels outside the occupied range count as zero volume for HVN windows and are not
        // consulted for LVN windows. The strongest MaxNodes survive (lower price first on equal
        // strength); the table is then ordered by price.
        private void FindNodes()
        {
            int count = 0;
            long pocVol = _pocVolume;
            if (pocVol <= 0)
            {
                _nodeCount = 0;
                return;
            }

            // Pass 1: HVNs into the candidate table.
            for (int i = _minIdx; i <= _maxIdx; i++)
            {
                long v = _volume[i];
                if (v <= 0 || v < pocVol * HvnMinRatio)
                    continue;
                if (!IsPeak(i, v))
                    continue;
                ProfileNode n;
                n.Price = PriceAt(i);
                n.Strength = (double)v / pocVol;
                n.Volume = v;
                n.Kind = ProfileNodeKind.Hvn;
                _candidates[count++] = n;
            }
            int hvnCount = count;

            // Pass 2: LVNs between consecutive HVNs.
            for (int h = 0; h + 1 < hvnCount; h++)
            {
                int below = IndexOf(_candidates[h].Price);
                int above = IndexOf(_candidates[h + 1].Price);
                long flank = Math.Min(_candidates[h].Volume, _candidates[h + 1].Volume);
                if (flank <= 0)
                    continue;
                for (int i = below + 1; i < above; i++)
                {
                    long v = _volume[i];
                    double strength = 1.0 - (double)v / flank;
                    if (strength < LvnMinStrength)
                        continue;
                    if (!IsTrough(i, v, below, above))
                        continue;
                    ProfileNode n;
                    n.Price = PriceAt(i);
                    n.Strength = strength;
                    n.Volume = v;
                    n.Kind = ProfileNodeKind.Lvn;
                    _candidates[count++] = n;
                }
            }

            // Cap: keep the strongest MaxNodes. Selection sort in place is O(n * MaxNodes) over
            // a small n and allocates nothing.
            int keep = count < _maxNodes ? count : _maxNodes;
            for (int k = 0; k < keep; k++)
            {
                int best = k;
                for (int j = k + 1; j < count; j++)
                {
                    if (_candidates[j].Strength > _candidates[best].Strength
                        || (_candidates[j].Strength == _candidates[best].Strength && _candidates[j].Price < _candidates[best].Price))
                        best = j;
                }
                if (best != k)
                {
                    ProfileNode tmp = _candidates[k];
                    _candidates[k] = _candidates[best];
                    _candidates[best] = tmp;
                }
            }

            // Order the survivors by price.
            for (int a = 1; a < keep; a++)
            {
                ProfileNode n = _candidates[a];
                int b = a - 1;
                while (b >= 0 && _candidates[b].Price > n.Price)
                {
                    _candidates[b + 1] = _candidates[b];
                    b--;
                }
                _candidates[b + 1] = n;
            }

            for (int i = 0; i < keep; i++)
                _nodes[i] = _candidates[i];
            _nodeCount = keep;
        }

        private bool IsPeak(int i, long v)
        {
            for (int j = i - NodeWindow; j <= i + NodeWindow; j++)
            {
                if (j == i)
                    continue;
                long o = (j < _minIdx || j > _maxIdx) ? 0L : _volume[j];
                if (j < i ? v <= o : v < o)
                    return false;
            }
            return true;
        }

        private bool IsTrough(int i, long v, int below, int above)
        {
            int from = Math.Max(i - NodeWindow, below + 1);
            int to = Math.Min(i + NodeWindow, above - 1);
            for (int j = from; j <= to; j++)
            {
                if (j == i)
                    continue;
                long o = _volume[j];
                if (j < i ? v >= o : v > o)
                    return false;
            }
            return true;
        }

        // Developing values: freeze POC/VAH/VAL as they stand now. Called by MarketState at each
        // fixed-time checkpoint. Silently stops at MaxCheckpoints (a session longer than
        // MaxCheckpoints intervals is not a case the defaults reach).
        public void RecordCheckpoint(long atUtcTicks)
        {
            Recompute();
            if (_checkpointCount >= MaxCheckpoints)
                return;
            ProfileCheckpoint c;
            c.AtUtcTicks = atUtcTicks;
            c.Poc = Poc;
            c.Vah = Vah;
            c.Val = Val;
            _checkpoints[_checkpointCount++] = c;
        }

        // Histogram window of at most `levels` levels around the POC, clipped to the occupied
        // range. Returns the first index and sets count; count is 0 when the profile is empty.
        public int HistogramWindow(int levels, out int count)
        {
            if (_pocIdx < 0 || levels <= 0)
            {
                count = 0;
                return 0;
            }
            int start = _pocIdx - levels / 2;
            if (start < _minIdx)
                start = _minIdx;
            int end = start + levels - 1;
            if (end > _maxIdx)
            {
                end = _maxIdx;
                start = end - levels + 1;
                if (start < _minIdx)
                    start = _minIdx;
            }
            count = end - start + 1;
            return start;
        }
    }
}
