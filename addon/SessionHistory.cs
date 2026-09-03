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
// Session boundaries come from a SessionIterator, which needs a Bars. A Bars only ever comes
// out of a BarsRequest, so the boundaries cannot be an input to the history request that
// produces them. SessionCalendar breaks that circle: one time-based bootstrap request per
// instrument over a fixed lookback (config sessionBootstrapDays) at a coarse period, needing no
// session knowledge at all, held alive for the life of the calendar; every later question about
// where a session begins and ends is answered from the SessionIterator built on its Bars.
//
// VERIFIED IN USE (NT8 8.1.8.2), all of it exercised by this AddOn's own compiling code:
//   - new BarsRequest(Instrument, DateTime from, DateTime to); BarsRequest.BarsPeriod;
//     BarsRequest.TradingHours; BarsRequest.Request(Action<BarsRequest, ErrorCode, string>);
//     BarsRequest.Bars (Bars) with Count, GetTime(int), GetOpen/GetHigh/GetLow/GetClose(int),
//     GetVolume(int) - cast to long here so either a long or a double return compiles.
//   - BarsRequest as IDisposable (checked with `as`, never assumed).
//   - new SessionIterator(Bars); SessionIterator.GetNextSession(DateTime, bool);
//     SessionIterator.ActualSessionBegin; SessionIterator.ActualSessionEnd (local convention).
//   - Instrument.MasterInstrument.TradingHours (.Name); TradingHours.Sessions.Count, read only
//     to detect an empty template. Members of an individual Session object are NOT used: they
//     are unverified on this build.
//
// DOES NOT EXIST on 8.1.8.2 - do not reintroduce:
//   - TradingHours.GetNextBeginEnd(DateTime, out DateTime, out DateTime). Compiling against it
//     is CS1061 (observed 2026-09-03); it is why this file was rewritten onto SessionIterator.
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

        // The bootstrap request: a plain time window, no session knowledge required. Coarse
        // bars, because only the series' trading-hours template is wanted, not its prices.
        // Returns null and sets the reason when the API is not usable; never throws, never
        // blocks. Publisher thread only (SessionCalendar enforces "once per instrument").
        internal static BarsRequest RequestBootstrap(Instrument instrument, DateTime fromLocal, DateTime toLocal,
            Action<BarsRequest, ErrorCode, string> onCompleted, out string error)
        {
            error = null;
            try
            {
                BarsRequest barsRequest = new BarsRequest(instrument, fromLocal, toLocal);
                BarsPeriod period = new BarsPeriod();
                period.BarsPeriodType = BarsPeriodType.Minute;
                period.Value = BootstrapPeriodMinutes;
                barsRequest.BarsPeriod = period;
                if (instrument.MasterInstrument != null && instrument.MasterInstrument.TradingHours != null)
                    barsRequest.TradingHours = instrument.MasterInstrument.TradingHours;
                barsRequest.Request(onCompleted);
                return barsRequest;
            }
            catch (Exception ex)
            {
                error = "session bootstrap: " + ex.GetType().Name + ": " + ex.Message;
                return null;
            }
        }

        // Coarse enough that a multi-day lookback is a few hundred bars, fine enough to still be
        // an intraday series carrying the instrument's trading-hours template.
        internal const int BootstrapPeriodMinutes = 60;
    }

    // One per MarketState, so one per instrument: a roll builds a new feed, a new MarketState and
    // therefore a new calendar, and no session knowledge from the old contract survives into the
    // new one. Everything here runs on the publisher thread except the bootstrap callback, which
    // only hands a Bars over through a volatile field; the SessionIterator itself is built and
    // used on the publisher thread alone. Nothing blocks, nothing throws, nothing allocates on a
    // per-event path: the calendar is touched once a second at most, and only until a session is
    // known.
    public sealed class SessionCalendar
    {
        // Search caps for the backwards walk. A prior session is at most a few days back even
        // across a long holiday weekend; the step count bounds the loop whatever the template.
        private const int PriorMaxSteps = 32;
        private const int PriorMaxLookbackDays = 7;

        // Forward nudge when GetNextSession lands on a session that has already ended (at a
        // roll, `at` is exactly the old session's end and may be included in it).
        private const int ForwardMaxSteps = 8;

        private readonly Instrument _instrument;
        private readonly int _lookbackDays;

        private int _state;                     // HistoryState, published with Volatile
        private string _error;                  // publisher thread writes, any thread may read
        private Bars _bars;                     // callback thread -> publisher thread
        private BarsRequest _bootstrap;         // held so its Bars stays alive
        private SessionIterator _iterator;      // publisher thread only

        public SessionCalendar(Instrument instrument, int lookbackDays)
        {
            _instrument = instrument;
            _lookbackDays = lookbackDays > 0 ? lookbackDays : 1;
            _state = HistoryState.NotRequested;
        }

        public byte State { get { return (byte)System.Threading.Volatile.Read(ref _state); } }

        // Why the calendar cannot answer, or null when it can (or has not been asked yet).
        // Surfaced by MarketState through its error and coverage fields.
        public string Error { get { return System.Threading.Volatile.Read(ref _error); } }

        // Session containing `at`, or the next one when `at` falls between sessions. Local-time
        // convention throughout. False means "not known yet, or not knowable": the caller tries
        // again on its next pass. Issues the bootstrap request the first time it is called.
        public bool SessionBounds(DateTime at, out DateTime begin, out DateTime end)
        {
            begin = DateTime.MinValue;
            end = DateTime.MinValue;

            SessionIterator iterator = Iterator(at);
            if (iterator == null)
                return false;

            try
            {
                DateTime probe = at;
                for (int i = 0; i < ForwardMaxSteps; i++)
                {
                    iterator.GetNextSession(probe, true);
                    DateTime b = iterator.ActualSessionBegin;
                    DateTime e = iterator.ActualSessionEnd;
                    if (e <= b)
                        break;                              // template produced nothing usable
                    if (e > at)
                    {
                        begin = b;
                        end = e;
                        return true;
                    }
                    // The named session has already ended (`at` sat on its end stamp): step past
                    // it, never backwards, so the loop always terminates.
                    DateTime next = e.AddTicks(1);
                    if (next <= probe)
                        break;
                    probe = next;
                }
                // Not terminal: the template may simply not reach this far ahead yet.
                Note("session bounds: trading hours named no session covering the current time");
                return false;
            }
            catch (Exception ex)
            {
                Fail("session bounds: " + ex.GetType().Name + ": " + ex.Message);
                return false;
            }
        }

        // The session that ended at or before currentBegin. Walks backwards with the iterator:
        // probe just before currentBegin, ask for the session there, and if it still runs past
        // currentBegin (the probe landed inside the current session) jump to just before that
        // session's own begin. Each step moves strictly earlier - by a whole session where the
        // template gives one, by a day when it does not - and the walk is capped both by step
        // count and by a 7-day floor, so a template that never names an earlier session ends the
        // search instead of spinning. Runs once per session, never per event.
        public bool PriorSessionBounds(DateTime currentBegin, out DateTime begin, out DateTime end)
        {
            begin = DateTime.MinValue;
            end = DateTime.MinValue;

            SessionIterator iterator = Iterator(currentBegin);
            if (iterator == null)
                return false;

            try
            {
                DateTime floor = currentBegin.AddDays(-PriorMaxLookbackDays);
                DateTime probe = currentBegin.AddTicks(-1);
                for (int i = 0; i < PriorMaxSteps && probe > floor; i++)
                {
                    iterator.GetNextSession(probe, true);
                    DateTime b = iterator.ActualSessionBegin;
                    DateTime e = iterator.ActualSessionEnd;
                    if (e > b && e <= currentBegin)
                    {
                        begin = b;
                        end = e;
                        return true;
                    }

                    DateTime next = (e > b && b < probe) ? b.AddTicks(-1) : probe.AddDays(-1);
                    if (next >= probe)
                        next = probe.AddDays(-1);           // guarantee strict progress
                    probe = next;
                }
                return false;                               // no prior session inside the cap
            }
            catch (Exception ex)
            {
                Fail("prior session: " + ex.GetType().Name + ": " + ex.Message);
                return false;
            }
        }

        // Null until the bootstrap request has come back and the iterator has been built. Issues
        // the request on the first call. Publisher thread only.
        private SessionIterator Iterator(DateTime now)
        {
            if (_iterator != null)
                return _iterator;

            byte state = State;
            if (state == HistoryState.Failed)
                return null;
            if (state == HistoryState.NotRequested)
            {
                Bootstrap(now);
                return null;                                // asynchronous: answer next pass
            }
            if (state != HistoryState.Loaded)
                return null;                                // still pending

            Bars bars = System.Threading.Volatile.Read(ref _bars);
            if (bars == null)
            {
                Fail("session bootstrap: request returned no bars series");
                return null;
            }
            try
            {
                _iterator = new SessionIterator(bars);
            }
            catch (Exception ex)
            {
                Fail("session iterator: " + ex.GetType().Name + ": " + ex.Message);
                return null;
            }
            return _iterator;
        }

        // One request per calendar, asynchronous, publisher thread. A missing instrument or
        // trading-hours object is transient enough to retry (the state stays NotRequested); an
        // empty template is not, and is reported as session unknown rather than papered over
        // with an invented 24-hour session.
        private void Bootstrap(DateTime now)
        {
            try
            {
                if (_instrument == null || _instrument.MasterInstrument == null)
                {
                    Note("session bounds: instrument not resolved yet");
                    return;
                }
                TradingHours hours = _instrument.MasterInstrument.TradingHours;
                if (hours == null)
                {
                    Note("session bounds: no trading hours template on the instrument");
                    return;
                }
                if (hours.Sessions == null || hours.Sessions.Count == 0)
                {
                    Fail("session bounds: trading hours template is empty");
                    return;
                }

                System.Threading.Volatile.Write(ref _state, HistoryState.Pending);
                string error;
                BarsRequest request = SessionHistory.RequestBootstrap(_instrument, now.AddDays(-_lookbackDays), now,
                    new Action<BarsRequest, ErrorCode, string>(OnBootstrapCompleted), out error);
                if (request == null)
                {
                    Fail(error ?? "session bootstrap: request could not be issued");
                    return;
                }
                _bootstrap = request;                       // kept alive: the Bars belongs to it
            }
            catch (Exception ex)
            {
                Fail("session bootstrap: " + ex.GetType().Name + ": " + ex.Message);
            }
        }

        // NinjaTrader's thread. Publishes the Bars and a flag, nothing more; the iterator is
        // built on the publisher thread when it next asks. The request is never disposed here -
        // the Bars outlives the callback and belongs to it.
        private void OnBootstrapCompleted(BarsRequest completed, ErrorCode errorCode, string errorMessage)
        {
            try
            {
                if (errorCode != ErrorCode.NoError)
                {
                    Fail("session bootstrap: " + errorCode.ToString() +
                        (string.IsNullOrEmpty(errorMessage) ? "" : ": " + errorMessage));
                    return;
                }
                Bars bars = completed != null ? completed.Bars : null;
                if (bars == null)
                {
                    Fail("session bootstrap: request returned no bars series");
                    return;
                }
                System.Threading.Volatile.Write(ref _bars, bars);
                System.Threading.Volatile.Write(ref _state, HistoryState.Loaded);
            }
            catch (Exception ex)
            {
                Fail("session bootstrap: " + ex.GetType().Name + ": " + ex.Message);
            }
        }

        // Terminal: the calendar will not answer for this instrument. A roll builds a new one.
        private void Fail(string reason)
        {
            System.Threading.Volatile.Write(ref _error, reason);
            System.Threading.Volatile.Write(ref _state, HistoryState.Failed);
        }

        // A reason the caller may see while the calendar stays retryable. Repeating the same
        // reason keeps the same string reference, so the publisher's reference-equality dedupe
        // reports it once instead of once a second.
        private void Note(string reason)
        {
            string current = System.Threading.Volatile.Read(ref _error);
            if (current != null && string.Equals(current, reason, StringComparison.Ordinal))
                return;
            System.Threading.Volatile.Write(ref _error, reason);
        }

        // The bootstrap request is held for the life of the calendar because the SessionIterator
        // reads through its Bars. Released with the feed it belongs to.
        public void Dispose()
        {
            _iterator = null;
            System.Threading.Volatile.Write(ref _bars, null);
            BarsRequest request = _bootstrap;
            _bootstrap = null;
            IDisposable d = request as IDisposable;
            if (d != null)
            {
                try { d.Dispose(); } catch (Exception) { }
            }
        }
    }
}
