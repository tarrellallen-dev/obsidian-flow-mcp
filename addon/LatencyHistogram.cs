// Obsidian Flow MCP - AddOn
// Spec section 8: handler time as percentiles, never averages. This is a hand-rolled
// log-linear histogram with no dependencies (HdrHistogram is a NuGet package, and NuGet
// packages do not resolve from bin\Custom). It is owned and updated only by the publisher
// thread. Nothing here is ever called from a MarketData or MarketDepth handler.
// .NET Framework 4.8. ASCII only.
//
// Bucket layout (values in nanoseconds):
//
//   Seven decades cover 100 ns .. 1 s. Each decade [10^k, 10^(k+1)) is split into 90 linear
//   sub-buckets of width 10^(k-1), which gives two significant digits everywhere in range.
//   Bucket 0 is the underflow bucket (< 100 ns); bucket 631 is the overflow bucket (>= 1 s).
//
//   index   lower bound (ns)   width (ns)   note
//   0       -                  -            underflow, value < 100
//   1       100                10           decade 0, sub 0
//   2       110                10
//   ...
//   90      990                10           decade 0, sub 89
//   91      1000               100          decade 1, sub 0
//   92      1100               100
//   ...
//   180     9900               100          decade 1, sub 89
//   181     10000              1000         decade 2, sub 0
//   ...
//   270     99000              1000
//   271     100000             10000        decade 3, sub 0
//   ...
//   360     990000             10000
//   361     1000000            100000       decade 4, sub 0 (1 ms)
//   ...
//   450     9900000            100000
//   451     10000000           1000000      decade 5, sub 0 (10 ms)
//   ...
//   540     99000000           1000000
//   541     100000000          10000000     decade 6, sub 0 (100 ms)
//   ...
//   630     990000000          10000000     decade 6, sub 89
//   631     -                  -            overflow, value >= 1000000000
//
//   General rule for 1 <= index <= 630: decade d = (index - 1) / 90, sub s = (index - 1) % 90,
//   lower = (10 + s) * 10^(d + 1), width = 10^(d + 1).
//
//   Reference points used by the C# self-check in Verify():
//     value       index    lower       highest equivalent
//     0           0        -           99
//     99          0        -           99
//     100         1        100         109
//     109         1        100         109
//     110         2        110         119
//     999         90       990         999
//     1000        91       1000        1099
//     1234        93       1200        1299
//     9999        180      9900        9999
//     10000       181      10000       10999
//     12345       183      12000       12999
//     999999      360      990000      999999
//     1000000     361      1000000     1099999
//     999999999   630      990000000   999999999
//     1000000000  631      -           exact max recorded
//
//   ValueAtPercentile returns the highest equivalent value of the bucket the percentile lands
//   in (lower + width - 1), which is HdrHistogram's convention and is conservative for latency.
//   The overflow bucket answers with the exact maximum recorded, so a percentile can never be
//   reported below a value that was seen. Max is tracked exactly and is not quantised.

using System;
using System.Diagnostics;
using System.Threading;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public sealed class LatencyHistogram
    {
        public const int SubBucketsPerDecade = 90;
        public const int Decades = 7;
        public const int UnderflowIndex = 0;
        public const int FirstIndex = 1;
        public const int LastIndex = Decades * SubBucketsPerDecade;     // 630
        public const int OverflowIndex = LastIndex + 1;                 // 631
        public const int BucketCount = OverflowIndex + 1;               // 632

        public const long MinValueNs = 100L;
        public const long MaxValueNs = 1000000000L;                     // 1 s, exclusive

        // Widths per decade, index d -> 10^(d + 1).
        private static readonly long[] DecadeWidth =
        {
            10L, 100L, 1000L, 10000L, 100000L, 1000000L, 10000000L
        };

        private readonly long[] _counts;
        private long _count;
        private long _max;

        // Nanoseconds per Stopwatch tick as a double. One multiply per recorded sample.
        private static readonly double NsPerTick = 1000000000.0 / (double)Stopwatch.Frequency;

        public LatencyHistogram()
        {
            _counts = new long[BucketCount];
            _count = 0;
            _max = 0;
        }

        public long Count { get { return _count; } }

        // Exact, not quantised.
        public long Max { get { return _max; } }

        public void Reset()
        {
            Array.Clear(_counts, 0, _counts.Length);
            _count = 0;
            _max = 0;
        }

        // Records one handler duration in Stopwatch ticks (the unit the sample buffers carry).
        public void Record(long ticks)
        {
            if (ticks < 0)
                ticks = 0;
            RecordNanoseconds((long)(ticks * NsPerTick));
        }

        public void RecordNanoseconds(long ns)
        {
            if (ns < 0)
                ns = 0;
            _counts[IndexOf(ns)]++;
            _count++;
            if (ns > _max)
                _max = ns;
        }

        // Percentile p in [0, 100]. Returns 0 when nothing has been recorded.
        public long ValueAtPercentile(double p)
        {
            long total = _count;
            if (total <= 0)
                return 0;
            if (p < 0.0) p = 0.0;
            if (p > 100.0) p = 100.0;

            // Rank of the value asked for, 1-based, at least 1 so p = 0 answers with the lowest
            // populated bucket rather than with nothing.
            long rank = (long)Math.Ceiling((p / 100.0) * total);
            if (rank < 1)
                rank = 1;
            if (rank > total)
                rank = total;

            long cumulative = 0;
            for (int i = 0; i < BucketCount; i++)
            {
                cumulative += _counts[i];
                if (cumulative >= rank)
                    return HighestEquivalentValue(i);
            }
            return _max;
        }

        // ---------------------------------------------------------------------------------

        public static int IndexOf(long ns)
        {
            if (ns < MinValueNs)
                return UnderflowIndex;
            if (ns >= MaxValueNs)
                return OverflowIndex;

            // Decade: the largest d in 0..6 with ns >= 100 * 10^d. At most seven compares.
            int d = 0;
            long decadeStart = MinValueNs;
            while (d < Decades - 1 && ns >= decadeStart * 10L)
            {
                decadeStart *= 10L;
                d++;
            }

            long width = DecadeWidth[d];
            int sub = (int)((ns - decadeStart) / width);          // 0..89
            return FirstIndex + d * SubBucketsPerDecade + sub;
        }

        public static long LowerBound(int index)
        {
            if (index <= UnderflowIndex)
                return 0;
            if (index >= OverflowIndex)
                return MaxValueNs;
            int d = (index - FirstIndex) / SubBucketsPerDecade;
            int s = (index - FirstIndex) % SubBucketsPerDecade;
            return (10L + s) * DecadeWidth[d];
        }

        public static long Width(int index)
        {
            if (index <= UnderflowIndex || index >= OverflowIndex)
                return 0;
            int d = (index - FirstIndex) / SubBucketsPerDecade;
            return DecadeWidth[d];
        }

        private long HighestEquivalentValue(int index)
        {
            if (index <= UnderflowIndex)
                return MinValueNs - 1;
            if (index >= OverflowIndex)
                return _max;
            return LowerBound(index) + Width(index) - 1;
        }

        // Self-check against the reference table in the file header. Returns null when every
        // row agrees, otherwise the first disagreement. Never called on a hot path; the status
        // window may show its result once at startup.
        public static string Verify()
        {
            long[] values = { 0, 99, 100, 109, 110, 999, 1000, 1234, 9999, 10000, 12345, 999999, 1000000, 999999999, 1000000000 };
            int[] indices = { 0, 0, 1, 1, 2, 90, 91, 93, 180, 181, 183, 360, 361, 630, 631 };
            long[] lowers = { 0, 0, 100, 100, 110, 990, 1000, 1200, 9900, 10000, 12000, 990000, 1000000, 990000000, 1000000000 };

            for (int i = 0; i < values.Length; i++)
            {
                int idx = IndexOf(values[i]);
                if (idx != indices[i])
                    return "index of " + values[i] + " is " + idx + ", expected " + indices[i];
                if (LowerBound(idx) != lowers[i])
                    return "lower bound of bucket " + idx + " is " + LowerBound(idx) + ", expected " + lowers[i];
            }
            return null;
        }
    }

    // Percentile summary of one histogram, recomputed at most once per second on the publisher
    // thread and read by the status window and the snapshot writer. Plain fields, written with
    // Volatile.Write and read with Volatile.Read. Values are nanoseconds. Every latency field is
    // -1 (Unavailable) while the histogram is empty, so an instrument that has seen no events
    // reports "no figure" and never 0 ns. Allocation fields are -1 when not measured.
    public sealed class LatencySummary
    {
        private long _count;
        private long _p50Ns;
        private long _p99Ns;
        private long _p999Ns;
        private long _maxNs;
        private long _allocBytesPer1024;
        private long _allocBytesTotal;
        private long _sampleOverruns;
        private long _drops;

        public long Count { get { return Volatile.Read(ref _count); } }
        public long P50Ns { get { return Volatile.Read(ref _p50Ns); } }
        public long P99Ns { get { return Volatile.Read(ref _p99Ns); } }
        public long P999Ns { get { return Volatile.Read(ref _p999Ns); } }
        public long MaxNs { get { return Volatile.Read(ref _maxNs); } }
        public long AllocBytesPer1024 { get { return Volatile.Read(ref _allocBytesPer1024); } }
        public long AllocBytesTotal { get { return Volatile.Read(ref _allocBytesTotal); } }

        // Samples the publisher could not read before the handler's ring overwrote them. Nonzero
        // means the histogram undercounts; the percentiles are then of the samples that survived.
        public long SampleOverruns { get { return Volatile.Read(ref _sampleOverruns); } }

        // Events the producer dropped because the ring was full (spec 3.1), for this ring.
        public long Drops { get { return Volatile.Read(ref _drops); } }

        public const long Unavailable = -1L;

        public void Update(LatencyHistogram h, long allocPer1024, long allocTotal, long overruns, long drops)
        {
            Volatile.Write(ref _drops, drops);
            long count = h.Count;
            Volatile.Write(ref _count, count);
            if (count <= 0)
            {
                Volatile.Write(ref _p50Ns, Unavailable);
                Volatile.Write(ref _p99Ns, Unavailable);
                Volatile.Write(ref _p999Ns, Unavailable);
                Volatile.Write(ref _maxNs, Unavailable);
            }
            else
            {
                Volatile.Write(ref _p50Ns, h.ValueAtPercentile(50.0));
                Volatile.Write(ref _p99Ns, h.ValueAtPercentile(99.0));
                Volatile.Write(ref _p999Ns, h.ValueAtPercentile(99.9));
                Volatile.Write(ref _maxNs, h.Max);
            }
            Volatile.Write(ref _allocBytesPer1024, allocPer1024);
            Volatile.Write(ref _allocBytesTotal, allocTotal);
            Volatile.Write(ref _sampleOverruns, overruns);
        }
    }
}
