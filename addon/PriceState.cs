// Obsidian Flow MCP - AddOn
// Step 3, spec section 4 "price" block: last trade, top of book, spread, session open/high/low,
// session volume. Fed on the publisher thread from drained MarketData events; never touched by a
// handler. Session boundaries are decided by MarketState from the instrument's trading hours and
// arrive here as ResetSession; nothing in this file knows what a clock is.
// Tick size and point value come from the resolved instrument's MasterInstrument, whatever the
// asset class. No allocation after construction.
// .NET Framework 4.8. ASCII only.

using System;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    // Which side of the book the last trade hit. On the wire as u8 (schema/wire-v1.md, "price").
    public static class Aggressor
    {
        public const byte None = 0;         // no trade yet, or bid/ask unknown when it printed
        public const byte Bid = 1;          // trade at or below the bid: seller hit the bid
        public const byte Ask = 2;          // trade at or above the ask: buyer lifted the offer
        public const byte Between = 3;      // inside the spread: not attributable
    }

    public sealed class PriceState
    {
        private readonly double _tickSize;
        private readonly double _pointValue;

        // Unknown prices are NaN, on the wire as well: the decoder turns NaN into null and JSON
        // never shows a "0.0" that looks like a price.
        public double Last = double.NaN;
        public long LastSize;
        public byte LastAggressor = Aggressor.None;
        public double Bid = double.NaN;
        public double Ask = double.NaN;

        public double SessionOpen = double.NaN;
        public double SessionHigh = double.NaN;
        public double SessionLow = double.NaN;

        // History (BarsRequest bars before the AddOn attached) plus tape, for the session.
        public long SessionVolume;
        // Tape only: trades this AddOn saw itself.
        public long TapeVolume;
        public long TradeCount;

        public PriceState(double tickSize, double pointValue)
        {
            _tickSize = tickSize;
            _pointValue = pointValue;
        }

        public double TickSize { get { return _tickSize; } }
        public double PointValue { get { return _pointValue; } }
        public bool HasBidAsk { get { return !double.IsNaN(Bid) && !double.IsNaN(Ask); } }

        // Spread in ticks, -1 when either side is unknown or the tick size is.
        public int SpreadTicks
        {
            get
            {
                if (!HasBidAsk || _tickSize <= 0.0)
                    return -1;
                double ticks = (Ask - Bid) / _tickSize;
                if (ticks < 0.0)
                    return -1;
                return (int)Math.Round(ticks, MidpointRounding.AwayFromZero);
            }
        }

        // Session boundary: the open/high/low/volume start over. Last, bid and ask are facts about
        // the market that do not stop being true at a session boundary and are kept.
        public void ResetSession()
        {
            SessionOpen = double.NaN;
            SessionHigh = double.NaN;
            SessionLow = double.NaN;
            SessionVolume = 0;
            TapeVolume = 0;
            TradeCount = 0;
        }

        public void OnBid(double price)
        {
            Bid = price;
        }

        public void OnAsk(double price)
        {
            Ask = price;
        }

        // A print from the tape. Classifies the aggressor against the bid/ask known at that
        // moment (the data ring preserves the order NinjaTrader raised them in) and returns it so
        // the profile can attribute the volume. The owner's own indicators use the same rule:
        // at or above the ask is ask volume, at or below the bid is bid volume, in between is not
        // attributed.
        public byte OnLast(double price, long size)
        {
            byte side;
            if (!HasBidAsk)
                side = Aggressor.None;
            else if (price >= Ask)
                side = Aggressor.Ask;
            else if (price <= Bid)
                side = Aggressor.Bid;
            else
                side = Aggressor.Between;

            Last = price;
            LastSize = size;
            LastAggressor = side;
            TradeCount++;
            if (size > 0)
            {
                TapeVolume += size;
                SessionVolume += size;
            }
            Extend(price, price, price);
            return side;
        }

        // One history bar (BarsRequest) that closed before the AddOn attached. Folded in on the
        // publisher thread. Bars arrive oldest first, so the first bar's open is the session open
        // unless the tape already set it (it cannot have: history ends before the tape starts, and
        // MarketState folds history before it reports the session open as known).
        public void FoldHistoryBar(double open, double high, double low, long volume, bool firstBar)
        {
            if (firstBar || double.IsNaN(SessionOpen))
                SessionOpen = open;
            if (double.IsNaN(SessionHigh) || high > SessionHigh)
                SessionHigh = high;
            if (double.IsNaN(SessionLow) || low < SessionLow)
                SessionLow = low;
            if (volume > 0)
                SessionVolume += volume;
        }

        private void Extend(double open, double high, double low)
        {
            if (double.IsNaN(SessionOpen))
                SessionOpen = open;
            if (double.IsNaN(SessionHigh) || high > SessionHigh)
                SessionHigh = high;
            if (double.IsNaN(SessionLow) || low < SessionLow)
                SessionLow = low;
        }
    }
}
