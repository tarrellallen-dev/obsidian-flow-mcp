// Obsidian Flow MCP - AddOn
// Step 3: the seam between MarketState and NinjaTrader's chart-free history and trading-hours
// APIs. Everything NinjaTrader-specific about "what happened before the AddOn attached" and
// "where does this session begin and end" lives here, behind try/catch, so an API surface that
// differs on the target build degrades to "history unavailable" with a reason instead of a
// failed AddOn. The publisher thread never blocks on any of it: BarsRequest is asynchronous, its
// callback (a NinjaTrader thread, not ours) copies the bars into arrays it allocates itself
// (one-off, not steady state) and publishes a state flag; the publisher polls the flag once a
// second and folds the bars in on its own thread.
//
// VERIFY ON COMPILE (NT8 8.1.8.2):
//   - new BarsRequest(Instrument, DateTime from, DateTime to); BarsRequest.BarsPeriod;
//     BarsRequest.TradingHours; BarsRequest.Request(Action<BarsRequest, ErrorCode, string>);
//     BarsRequest.Bars (Bars) with Count, GetTime(int), GetOpen/GetHigh/GetLow/GetClose(int),
//     GetVolume(int) - cast to long here so either a long or a double return compiles.
//   - BarsRequest as IDisposable (checked with `as`, never assumed).
//   - TradingHours.GetNextBeginEnd(DateTime, out DateTime, out DateTime) (already used in 2.5).
// .NET Framework 4.8. ASCII only.

using System;
using NinjaTrader.Cbi;
using NinjaTrader.Data;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    // On the wire as u8 (schema/wire-v1.md, "coverage").
    public static class HistoryState
    {
        public const byte Disabled = 0;     // config historyBars = "none"
        public const byte Pending = 1;      // requested, callback not yet fired
        public const byte Loaded = 2;       // bars folded in (possibly zero bars)
        public const byte Failed = 3;       // NinjaTrader reported an error, or the API threw
        public const byte NotRequested = 4; // session boundaries unknown, nothing asked for yet
    }

    // On the wire as u8. How per-price volume was derived from history bars.
    public static class HistoryResolution
    {
        public const byte None = 0;
        public const byte MinuteSpread = 1; // 1-minute bars, volume spread evenly over the bar's range
        public const byte Tick = 2;         // 1-tick bars, one level per bar at its close
    }

    // Bars copied out of a BarsRequest callback. Allocated once per request on the callback
    // thread; read on the publisher thread after State says Loaded.
    public sealed class HistoryBars
    {
        public int Count;
        public long[] TimeTicks;
        public double[] Open;
        public double[] High;
        public double[] Low;
        public double[] Close;
        public long[] Volume;
    }

    public sealed class HistoryRequest
    {
        private int _state;                 // HistoryState, published with Volatile
        private string _error;
        private HistoryBars _bars;

        public readonly long FromLocalTicks;
        public readonly long ToLocalTicks;
        public readonly byte Resolution;

        public HistoryRequest(long fromLocalTicks, long toLocalTicks, byte resolution)
        {
            FromLocalTicks = fromLocalTicks;
            ToLocalTicks = toLocalTicks;
            Resolution = resolution;
            _state = HistoryState.Pending;
        }

        public byte State { get { return (byte)System.Threading.Volatile.Read(ref _state); } }
        public string Error { get { return System.Threading.Volatile.Read(ref _error); } }
        public HistoryBars Bars { get { return System.Threading.Volatile.Read(ref _bars); } }

        // Callback thread. Bars first, then the flag, so a reader that sees Loaded sees the bars.
        internal void Complete(HistoryBars bars)
        {
            System.Threading.Volatile.Write(ref _bars, bars);
            System.Threading.Volatile.Write(ref _state, HistoryState.Loaded);
        }

        internal void Fail(string error)
        {
            System.Threading.Volatile.Write(ref _error, error ?? "unknown error");
            System.Threading.Volatile.Write(ref _state, HistoryState.Failed);
        }
    }

    public static class SessionHistory
    {
        // Issues a chart-free BarsRequest for [fromLocal, toLocal]. Returns a request already in
        // the Failed state, with the reason, when the API is not usable; never throws, never
        // blocks. `tick` selects 1-tick bars, otherwise 1-minute bars.
        public static HistoryRequest Request(Instrument instrument, DateTime fromLocal, DateTime toLocal, bool tick)
        {
            byte resolution = tick ? HistoryResolution.Tick : HistoryResolution.MinuteSpread;
            HistoryRequest request = new HistoryRequest(fromLocal.Ticks, toLocal.Ticks, resolution);

            if (instrument == null)
            {
                request.Fail("no instrument");
                return request;
            }
            if (toLocal <= fromLocal)
            {
                // Nothing to ask for: an empty range is a loaded, empty history.
                HistoryBars empty = new HistoryBars();
                empty.Count = 0;
                request.Complete(empty);
                return request;
            }

            try
            {
                BarsRequest barsRequest = new BarsRequest(instrument, fromLocal, toLocal);
                BarsPeriod period = new BarsPeriod();
                period.BarsPeriodType = tick ? BarsPeriodType.Tick : BarsPeriodType.Minute;
                period.Value = 1;
                barsRequest.BarsPeriod = period;
                if (instrument.MasterInstrument != null && instrument.MasterInstrument.TradingHours != null)
                    barsRequest.TradingHours = instrument.MasterInstrument.TradingHours;

                barsRequest.Request(new Action<BarsRequest, ErrorCode, string>(
                    delegate (BarsRequest completed, ErrorCode errorCode, string errorMessage)
                    {
                        OnBarsRequestCompleted(request, completed, errorCode, errorMessage);
                    }));
            }
            catch (Exception ex)
            {
                request.Fail(ex.GetType().Name + ": " + ex.Message);
            }
            return request;
        }

        // NinjaTrader's thread. Copies and leaves; no calculation here, and nothing thrown out.
        private static void OnBarsRequestCompleted(HistoryRequest request, BarsRequest completed, ErrorCode errorCode, string errorMessage)
        {
            try
            {
                if (errorCode != ErrorCode.NoError)
                {
                    request.Fail(errorCode.ToString() + (string.IsNullOrEmpty(errorMessage) ? "" : ": " + errorMessage));
                    return;
                }
                Bars bars = completed != null ? completed.Bars : null;
                int n = bars != null ? bars.Count : 0;

                HistoryBars copy = new HistoryBars();
                copy.Count = n;
                copy.TimeTicks = new long[n];
                copy.Open = new double[n];
                copy.High = new double[n];
                copy.Low = new double[n];
                copy.Close = new double[n];
                copy.Volume = new long[n];
                for (int i = 0; i < n; i++)
                {
                    copy.TimeTicks[i] = bars.GetTime(i).Ticks;
                    copy.Open[i] = bars.GetOpen(i);
                    copy.High[i] = bars.GetHigh(i);
                    copy.Low[i] = bars.GetLow(i);
                    copy.Close[i] = bars.GetClose(i);
                    copy.Volume[i] = (long)bars.GetVolume(i);
                }
                request.Complete(copy);
            }
            catch (Exception ex)
            {
                request.Fail(ex.GetType().Name + ": " + ex.Message);
            }
            finally
            {
                IDisposable d = completed as IDisposable;
                if (d != null)
                {
                    try { d.Dispose(); } catch (Exception) { }
                }
            }
        }

        // Session containing `at`, or the next one when `at` falls between sessions, from the
        // instrument's trading-hours template. Local-time convention throughout. False when the
        // template is missing or the API is not usable.
        public static bool SessionBounds(Instrument instrument, DateTime at, out DateTime begin, out DateTime end)
        {
            begin = DateTime.MinValue;
            end = DateTime.MinValue;
            try
            {
                if (instrument == null || instrument.MasterInstrument == null)
                    return false;
                TradingHours hours = instrument.MasterInstrument.TradingHours;
                if (hours == null)
                    return false;
                hours.GetNextBeginEnd(at, out begin, out end);
                return end > begin && end > at;
            }
            catch (Exception)
            {
                return false;
            }
        }

        // The session that ended at or before currentBegin. Probes backwards through the
        // template in 30-minute steps (at most 7 days) until GetNextBeginEnd names a session
        // whose end does not run past currentBegin. Runs once per session on the publisher
        // thread, never per event.
        public static bool PriorSessionBounds(Instrument instrument, DateTime currentBegin, out DateTime begin, out DateTime end)
        {
            begin = DateTime.MinValue;
            end = DateTime.MinValue;
            try
            {
                if (instrument == null || instrument.MasterInstrument == null)
                    return false;
                TradingHours hours = instrument.MasterInstrument.TradingHours;
                if (hours == null)
                    return false;

                DateTime probe = currentBegin.AddMinutes(-30);
                for (int i = 0; i < 7 * 48; i++)
                {
                    DateTime b;
                    DateTime e;
                    hours.GetNextBeginEnd(probe, out b, out e);
                    if (e > b && e <= currentBegin)
                    {
                        begin = b;
                        end = e;
                        return true;
                    }
                    probe = probe.AddMinutes(-30);
                }
                return false;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }
}
