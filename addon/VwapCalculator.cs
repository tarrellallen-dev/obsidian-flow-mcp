// Obsidian Flow MCP - AddOn
// Step 3, spec section 4 "vwap" block: session VWAP with 1 and 2 sigma bands from a volume-
// weighted Welford running variance over price. Publisher thread only. No allocation.
// .NET Framework 4.8. ASCII only.

using System;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public sealed class VwapCalculator
    {
        private readonly double _tickSize;

        // Welford with frequency weights: W is the total weight (volume), _mean the weighted
        // mean (the VWAP itself), _m2 the weighted sum of squared deviations.
        private double _weight;
        private double _mean;
        private double _m2;
        private bool _includesHistory;

        public VwapCalculator(double tickSize)
        {
            _tickSize = tickSize;
        }

        public void Reset()
        {
            _weight = 0.0;
            _mean = 0.0;
            _m2 = 0.0;
            _includesHistory = false;
        }

        // One print (tape) or one history bar at its typical price. Zero or negative volume adds
        // nothing: a zero-size print carries no weight and must not disturb the mean.
        public void Add(double price, double volume, bool fromHistory)
        {
            if (volume <= 0.0 || double.IsNaN(price))
                return;
            if (fromHistory)
                _includesHistory = true;

            double w = _weight + volume;
            double delta = price - _mean;
            _mean += delta * (volume / w);
            _m2 += volume * delta * (price - _mean);
            _weight = w;
        }

        public bool HasValue { get { return _weight > 0.0; } }
        public double Weight { get { return _weight; } }
        public bool IncludesHistory { get { return _includesHistory; } }

        public double Vwap { get { return _weight > 0.0 ? _mean : double.NaN; } }

        public double StdDev
        {
            get
            {
                if (_weight <= 0.0)
                    return double.NaN;
                double v = _m2 / _weight;
                return v > 0.0 ? Math.Sqrt(v) : 0.0;
            }
        }

        public double Band(int sigmas)
        {
            double sd = StdDev;
            if (double.IsNaN(sd))
                return double.NaN;
            return _mean + sigmas * sd;
        }

        // Signed distance of price from the VWAP in ticks; NaN when either is unknown.
        public double PriceVsVwapTicks(double price)
        {
            if (_weight <= 0.0 || double.IsNaN(price) || _tickSize <= 0.0)
                return double.NaN;
            return (price - _mean) / _tickSize;
        }
    }
}
