// Obsidian Flow MCP - AddOn
// Step 3: per-instrument computed state (spec section 4 price, vwap and profile blocks) and its
// serializer (schema/wire-v1.md, "step-3 block"). One instance per InstrumentFeed, created with
// the feed and thrown away with it at a roll, so nothing from one contract leaks into the next.
//
// Threading: Apply, Tick and Serialize run on the publisher thread only, fed from the drained
// ring. The BarsRequest callback runs on a NinjaTrader thread and only hands over arrays through
// HistoryRequest; the fold happens here. Nothing in this file runs on a data thread.
//
// Session boundaries come from this state's own SessionCalendar (SessionHistory.cs), in
// NinjaTrader's local-time convention, and are compared with each event's own time stamp. The
// calendar owns one bootstrap BarsRequest for this instrument and the SessionIterator built on
// it; because a roll builds a new MarketState, it also builds a new calendar, and no session
// knowledge crosses a contract. Until that request returns, the calendar answers "not known"
// and every session question is simply retried on the next per-second pass - nothing here ever
// blocks or waits on it. UTC values for the wire are converted once per transition, never per
// event or per frame.
//
// Steady state allocates nothing: every array is sized at construction, history requests are
// one-off per session, and the serializer writes into the publisher's buffer.
// .NET Framework 4.8. ASCII only.

using System;
using NinjaTrader.Cbi;
using NinjaTrader.Data;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public sealed class MarketState
    {
        public const ushort MarketVersion = 1;

        // marketFlags (u16)
        public const ushort FlagSessionKnown = 1;
        public const ushort FlagInSession = 2;
        public const ushort FlagHasBidAsk = 4;
        public const ushort FlagBidAskSplitPresent = 8;

        // profile record flags (u8)
        public const byte ProfileFlagHasBidAskSplit = 1;
        public const byte ProfileFlagIncludesHistory = 2;
        public const byte ProfileFlagNakedPoc = 4;
        public const byte ProfileFlagOutOfRange = 8;
        public const byte ProfileFlagPriorFromLive = 16;

        // MarketDataType values as the handler stored them ((byte)e.MarketDataType). Taken from
        // the enum, never assumed numerically.
        private static readonly byte MdLast = (byte)MarketDataType.Last;
        private static readonly byte MdBid = (byte)MarketDataType.Bid;
        private static readonly byte MdAsk = (byte)MarketDataType.Ask;

        private const long TicksPerMinute = 600000000L;

        private readonly Instrument _instrument;
        private readonly Config _config;
        private readonly double _tickSize;

        public readonly PriceState Price;
        public readonly VwapCalculator Vwap;

        // Session boundaries for this instrument. Publisher thread only (its own bootstrap
        // callback aside, which the calendar keeps to itself).
        private readonly SessionCalendar _calendar;

        private SessionVolumeProfile _session;
        private SessionVolumeProfile _prior;
        private readonly SessionVolumeProfile _composite;
        private readonly VwapCalculator _priorVwap;

        // Session bounds, local-time ticks, plus their UTC copies for the wire.
        private bool _sessionKnown;
        private bool _inSession;                // refreshed once a second and by every event
        private long _beginLocal;
        private long _endLocal;
        private long _beginUtc;
        private long _endUtc;
        private long _nextCheckpointLocal;

        private bool _priorAvailable;
        private bool _priorFromLive;

        // History coverage (spec: coverage { historyFromWallUtc, tapeFromWallUtc }).
        private HistoryRequest _sessionHistory;
        private HistoryRequest _priorHistory;
        private byte _historyState = HistoryState.NotRequested;
        private byte _historyResolution = HistoryResolution.None;
        private long _historyFromUtc;
        private long _historyToUtc;
        private string _historyError = "";
        private long _tapeFromLocal;
        private long _tapeFromUtc;

        private string _lastError;

        public MarketState(InstrumentIdentity identity, Config config)
        {
            _instrument = identity != null ? identity.Instrument : null;
            _config = config;
            _tickSize = identity != null ? identity.TickSize : 0.0;
            double pointValue = identity != null ? identity.PointValue : 0.0;

            // Constructed only; the request itself is issued from the publisher thread on the
            // first per-second pass that asks for a session.
            _calendar = new SessionCalendar(_instrument, config != null ? config.SessionBootstrapDays : 5);

            Price = new PriceState(_tickSize, pointValue);
            Vwap = new VwapCalculator(_tickSize);
            _priorVwap = new VwapCalculator(_tickSize);
            _session = new SessionVolumeProfile(config.ProfileLevels, config.MaxNodes, _tickSize);
            _prior = new SessionVolumeProfile(config.ProfileLevels, config.MaxNodes, _tickSize);
            _composite = new SessionVolumeProfile(config.ProfileLevels, config.MaxNodes, _tickSize);

            if (string.Equals(config.HistoryBars, "none", StringComparison.OrdinalIgnoreCase))
                _historyState = HistoryState.Disabled;
        }

        public string LastError { get { return _lastError; } }
        public bool SessionKnown { get { return _sessionKnown; } }
        public SessionVolumeProfile Session { get { return _session; } }
        public SessionVolumeProfile Prior { get { return _prior; } }
        public SessionVolumeProfile Composite { get { return _composite; } }
        public byte HistoryStateValue { get { return _historyState; } }

        private bool HistoryEnabled { get { return _historyState != HistoryState.Disabled; } }
        private bool HistoryTick { get { return string.Equals(_config.HistoryBars, "tick", StringComparison.OrdinalIgnoreCase); } }

        // ------------------------------------------------------------------
        // Event path (publisher thread, per drained event)
        // ------------------------------------------------------------------
        public void Apply(ref MdEvent ev)
        {
            if (ev.Kind != MdEventKind.MarketData)
                return;                                 // depth is step 6

            if (_sessionKnown && ev.TimeTicks >= _endLocal)
                RollSession(ev.TimeTicks);
            if (_sessionKnown && !_inSession && ev.TimeTicks >= _beginLocal)
                _inSession = true;

            byte t = ev.MarketDataType;
            if (t == MdBid)
            {
                Price.OnBid(ev.Price);
                return;
            }
            if (t == MdAsk)
            {
                Price.OnAsk(ev.Price);
                return;
            }
            if (t != MdLast)
                return;

            if (_tapeFromLocal == 0)
            {
                _tapeFromLocal = ev.TimeTicks;
                _tapeFromUtc = ToUtcTicks(ev.TimeTicks);
            }

            byte side = Price.OnLast(ev.Price, ev.Size);
            Vwap.Add(ev.Price, ev.Size, false);
            double vwap = Vwap.Vwap;
            _session.AddTrade(ev.Price, ev.Size, side, vwap);
            _composite.AddTrade(ev.Price, ev.Size, side, vwap);

            if (_sessionKnown && _nextCheckpointLocal != 0 && ev.TimeTicks >= _nextCheckpointLocal)
                Checkpoint(ev.TimeTicks);
        }

        // ------------------------------------------------------------------
        // Once a second (publisher thread)
        // ------------------------------------------------------------------
        public void Tick(DateTime now)
        {
            try
            {
                if (!_sessionKnown)
                    ProbeSession(now);
                else if (now.Ticks >= _endLocal)
                    RollSession(now.Ticks);

                if (_sessionKnown && _nextCheckpointLocal != 0 && now.Ticks >= _nextCheckpointLocal)
                    Checkpoint(now.Ticks);

                _inSession = _sessionKnown && now.Ticks >= _beginLocal && now.Ticks < _endLocal;

                PollHistory();
            }
            catch (Exception ex)
            {
                _lastError = ex.GetType().Name + ": " + ex.Message;
            }
        }

        private void ProbeSession(DateTime now)
        {
            DateTime begin;
            DateTime end;
            if (!_calendar.SessionBounds(now, out begin, out end))
            {
                // Bootstrap still in flight, or the calendar cannot answer at all. Either way
                // the session stays unknown and this is retried next second; the reason, if
                // there is one, goes out on the error and coverage fields.
                NoteSessionReason();
                return;
            }
            _historyError = "";

            SetSession(begin.Ticks, end.Ticks, now.Ticks);

            if (!HistoryEnabled)
                return;

            // Session so far, up to now. Bars that close after the first tape print are dropped
            // at fold time, so the request may overshoot.
            if (now.Ticks > _beginLocal)
            {
                _sessionHistory = SessionHistory.Request(_instrument, begin, now, HistoryTick);
                _historyState = HistoryState.Pending;
            }
            else
            {
                _historyState = HistoryState.Loaded;    // attached before the open: nothing to fetch
            }

            DateTime pb;
            DateTime pe;
            if (_calendar.PriorSessionBounds(begin, out pb, out pe))
                _priorHistory = SessionHistory.Request(_instrument, pb, pe, false);
        }

        // The calendar's reason for "session unknown", if it has one, onto the fields that
        // already carry failures: LastError (the publisher dedupes by reference and reports it
        // once) and coverage.historyError while nothing has been requested. Never throws.
        private void NoteSessionReason()
        {
            string reason = _calendar.Error;
            if (reason == null)
                return;
            _lastError = reason;
            if (_historyState == HistoryState.NotRequested)
                _historyError = reason;
        }

        // Checkpoints that fell before nowLocal (the AddOn attached mid-session) cannot be known
        // and are skipped rather than recorded empty; the developing series starts at the first
        // checkpoint after attach.
        private void SetSession(long beginLocal, long endLocal, long nowLocal)
        {
            _sessionKnown = true;
            _beginLocal = beginLocal;
            _endLocal = endLocal;
            _beginUtc = ToUtcTicks(beginLocal);
            _endUtc = ToUtcTicks(endLocal);
            long interval = Math.Max(1, _config.CheckpointMinutes) * TicksPerMinute;
            _nextCheckpointLocal = beginLocal + interval;
            while (_nextCheckpointLocal <= nowLocal)
                _nextCheckpointLocal += interval;
        }

        // Session boundary crossed. The finished session becomes the prior when it was seen
        // whole (history loaded, or the tape started within a minute of the open); otherwise the
        // prior is re-fetched as bars. Everything session-scoped starts over.
        private void RollSession(long atLocalTicks)
        {
            _session.Recompute();

            // Seen whole: the tape started within a minute of the open, or history bars covered
            // the part before the tape. A Loaded state with no bars folded proves nothing.
            bool tapeFromOpen = _tapeFromLocal != 0 && _tapeFromLocal <= _beginLocal + TicksPerMinute;
            bool historyCovered = _historyState == HistoryState.Loaded && _historyFromUtc != 0;
            bool sawWholeSession = tapeFromOpen || historyCovered;

            long finishedBegin = _beginLocal;
            long finishedEnd = _endLocal;

            if (sawWholeSession && !_session.IsEmpty)
            {
                SessionVolumeProfile finished = _session;
                _session = _prior;
                _prior = finished;
                _priorAvailable = true;
                _priorFromLive = true;
                _priorHistory = null;
            }
            else
            {
                _priorAvailable = false;
                _priorFromLive = false;
                if (HistoryEnabled)
                    _priorHistory = SessionHistory.Request(_instrument, new DateTime(finishedBegin), new DateTime(finishedEnd), false);
            }

            _session.Reset(_tickSize);
            Price.ResetSession();
            Vwap.Reset();

            // Watching from the open: no history portion for the new session.
            _sessionHistory = null;
            _historyState = HistoryEnabled ? HistoryState.Loaded : HistoryState.Disabled;
            _historyResolution = HistoryResolution.None;
            _historyFromUtc = 0;
            _historyToUtc = 0;
            _historyError = "";
            _tapeFromLocal = 0;
            _tapeFromUtc = 0;

            DateTime begin;
            DateTime end;
            if (_calendar.SessionBounds(new DateTime(atLocalTicks), out begin, out end))
            {
                SetSession(begin.Ticks, end.Ticks, atLocalTicks);
            }
            else
            {
                NoteSessionReason();
                _sessionKnown = false;                  // re-probed on the next Tick
                _inSession = false;
                _nextCheckpointLocal = 0;
            }

            RebuildComposite();
        }

        private void Checkpoint(long nowLocalTicks)
        {
            long interval = Math.Max(1, _config.CheckpointMinutes) * TicksPerMinute;
            // Record at the nominal checkpoint time, then skip any that were missed while idle.
            _session.RecordCheckpoint(ToUtcTicks(_nextCheckpointLocal));
            while (_nextCheckpointLocal <= nowLocalTicks)
                _nextCheckpointLocal += interval;
        }

        private void PollHistory()
        {
            if (_sessionHistory != null && _sessionHistory.State != HistoryState.Pending)
            {
                HistoryRequest r = _sessionHistory;
                _sessionHistory = null;
                if (r.State == HistoryState.Loaded)
                    FoldSessionHistory(r);
                else
                {
                    _historyState = HistoryState.Failed;
                    _historyError = r.Error ?? "";
                }
            }

            if (_priorHistory != null && _priorHistory.State != HistoryState.Pending)
            {
                HistoryRequest r = _priorHistory;
                _priorHistory = null;
                if (r.State == HistoryState.Loaded)
                    FoldPriorHistory(r);
                else
                {
                    _priorAvailable = false;
                    if (string.IsNullOrEmpty(_historyError))
                        _historyError = "prior: " + (r.Error ?? "");
                }
            }
        }

        private void FoldSessionHistory(HistoryRequest r)
        {
            HistoryBars bars = r.Bars;
            bool tick = r.Resolution == HistoryResolution.Tick;
            long cutoff = _tapeFromLocal != 0 ? _tapeFromLocal : r.ToLocalTicks;

            bool first = true;
            long firstTime = 0;
            long lastTime = 0;
            int n = bars != null ? bars.Count : 0;
            for (int i = 0; i < n; i++)
            {
                long t = bars.TimeTicks[i];
                if (tick ? t >= cutoff : t > cutoff)
                    continue;
                double o = bars.Open[i];
                double h = bars.High[i];
                double l = bars.Low[i];
                double c = bars.Close[i];
                long v = bars.Volume[i];

                Price.FoldHistoryBar(o, h, l, v, first);
                double typical = tick ? c : (h + l + c) / 3.0;
                Vwap.Add(typical, v, true);
                if (tick)
                    _session.AddHistory(c, v, Vwap.Vwap);
                else
                    _session.AddHistoryBar(l, h, c, v, Vwap.Vwap);

                if (first)
                    firstTime = tick ? t : t - TicksPerMinute;
                lastTime = t;
                first = false;
            }

            _historyState = HistoryState.Loaded;
            _historyResolution = first ? HistoryResolution.None : r.Resolution;
            _historyFromUtc = first ? 0 : ToUtcTicks(firstTime);
            _historyToUtc = first ? 0 : ToUtcTicks(lastTime);
            RebuildComposite();
        }

        private void FoldPriorHistory(HistoryRequest r)
        {
            HistoryBars bars = r.Bars;
            _prior.Reset(_tickSize);
            _priorVwap.Reset();
            int n = bars != null ? bars.Count : 0;
            for (int i = 0; i < n; i++)
            {
                double h = bars.High[i];
                double l = bars.Low[i];
                double c = bars.Close[i];
                long v = bars.Volume[i];
                _priorVwap.Add((h + l + c) / 3.0, v, true);
                _prior.AddHistoryBar(l, h, c, v, _priorVwap.Vwap);
            }
            _prior.Recompute();
            _priorAvailable = !_prior.IsEmpty;
            _priorFromLive = false;
            RebuildComposite();
        }

        // Composite = prior session + current session, rebuilt at the few moments its inputs
        // change wholesale (a fold, a roll); live prints are added to it incrementally.
        private void RebuildComposite()
        {
            _composite.Reset(_tickSize);
            if (_priorAvailable)
                _composite.Merge(_prior, double.NaN);
            _composite.Merge(_session, Vwap.Vwap);
        }

        private bool NakedPoc()
        {
            if (!_priorAvailable)
                return false;
            double poc = _prior.Poc;
            if (double.IsNaN(poc))
                return false;
            double low = Price.SessionLow;
            double high = Price.SessionHigh;
            if (double.IsNaN(low) || double.IsNaN(high))
                return true;
            return poc < low || poc > high;
        }

        // NinjaTrader's local-time convention to UTC ticks. Called at transitions only.
        private static long ToUtcTicks(long localTicks)
        {
            if (localTicks <= 0)
                return 0;
            try
            {
                return new DateTime(localTicks, DateTimeKind.Local).ToUniversalTime().Ticks;
            }
            catch (Exception)
            {
                return 0;
            }
        }

        // Called from InstrumentFeed.Dispose (publisher thread) when this state is retired at a
        // roll or at shutdown: releases the calendar's bootstrap BarsRequest. Never throws.
        public void Dispose()
        {
            try
            {
                if (_calendar != null)
                    _calendar.Dispose();
            }
            catch (Exception ex)
            {
                _lastError = ex.GetType().Name + ": " + ex.Message;
            }
        }

        // ------------------------------------------------------------------
        // Serializer: schema/wire-v1.md "step-3 block". Returns the new offset.
        // ------------------------------------------------------------------
        public int Serialize(byte[] b, int p)
        {
            _session.Recompute();
            _composite.Recompute();

            int lengthAt = p;
            p += 4;                                                        // marketBytes, patched below
            p = Publisher.PutU16(b, p, MarketVersion);

            ushort flags = 0;
            if (_sessionKnown) flags |= FlagSessionKnown;
            if (_inSession) flags |= FlagInSession;
            if (Price.HasBidAsk) flags |= FlagHasBidAsk;
            if (_session.HasBidAskSplit) flags |= FlagBidAskSplitPresent;
            p = Publisher.PutU16(b, p, flags);

            // ----- price -----
            p = Publisher.PutF64(b, p, Price.Last);
            p = Publisher.PutI64(b, p, Price.LastSize);
            b[p++] = Price.LastAggressor;
            b[p++] = 0;
            p = Publisher.PutU16(b, p, 0);
            p = Publisher.PutI32(b, p, Price.SpreadTicks);
            p = Publisher.PutF64(b, p, Price.Bid);
            p = Publisher.PutF64(b, p, Price.Ask);
            p = Publisher.PutF64(b, p, Price.SessionOpen);
            p = Publisher.PutF64(b, p, Price.SessionHigh);
            p = Publisher.PutF64(b, p, Price.SessionLow);
            p = Publisher.PutU64(b, p, (ulong)Price.SessionVolume);
            p = Publisher.PutU64(b, p, (ulong)Price.TapeVolume);
            p = Publisher.PutU64(b, p, (ulong)Price.TradeCount);
            p = Publisher.PutF64(b, p, Price.TickSize);
            p = Publisher.PutF64(b, p, Price.PointValue);
            p = Publisher.PutI64(b, p, _sessionKnown ? _beginUtc : 0L);
            p = Publisher.PutI64(b, p, _sessionKnown ? _endUtc : 0L);

            // ----- vwap -----
            p = Publisher.PutF64(b, p, Vwap.Vwap);
            p = Publisher.PutF64(b, p, Vwap.StdDev);
            p = Publisher.PutF64(b, p, Vwap.Band(1));
            p = Publisher.PutF64(b, p, Vwap.Band(-1));
            p = Publisher.PutF64(b, p, Vwap.Band(2));
            p = Publisher.PutF64(b, p, Vwap.Band(-2));
            p = Publisher.PutF64(b, p, Vwap.PriceVsVwapTicks(Price.Last));
            p = Publisher.PutU64(b, p, (ulong)Vwap.Weight);
            b[p++] = Vwap.IncludesHistory ? (byte)1 : (byte)0;
            b[p++] = 0;
            p = Publisher.PutU16(b, p, 0);

            // ----- coverage -----
            b[p++] = _historyState;
            b[p++] = _historyResolution;
            p = Publisher.PutU16(b, p, 0);
            p = Publisher.PutI64(b, p, _historyFromUtc);
            p = Publisher.PutI64(b, p, _historyToUtc);
            p = Publisher.PutI64(b, p, _tapeFromUtc);
            p = Publisher.PutAsciiWithU8Length(b, p, _historyError);

            // ----- profiles: session, prior, composite -----
            p = PutProfile(b, p, _session, _session.IsUsable, ProfileFlags(_session, false), _config.HistogramLevels, true);
            byte priorFlags = ProfileFlags(_prior, true);
            if (NakedPoc()) priorFlags |= ProfileFlagNakedPoc;
            if (_priorFromLive) priorFlags |= ProfileFlagPriorFromLive;
            p = PutProfile(b, p, _prior, _priorAvailable, priorFlags, 0, false);
            p = PutProfile(b, p, _composite, _composite.IsUsable && !_composite.IsEmpty, ProfileFlags(_composite, false), _config.HistogramLevels, false);

            Publisher.PutU32(b, lengthAt, (uint)(p - lengthAt - 4));
            return p;
        }

        private static byte ProfileFlags(SessionVolumeProfile profile, bool prior)
        {
            byte f = 0;
            // The prior never advertises a split (spec section 4): its histogram is not on the
            // wire and its summary is volume-only whichever way it was built.
            if (!prior && profile.HasBidAskSplit) f |= ProfileFlagHasBidAskSplit;
            if (profile.IncludesHistory) f |= ProfileFlagIncludesHistory;
            if (profile.OutOfRangeVolume > 0) f |= ProfileFlagOutOfRange;
            return f;
        }

        private static int PutProfile(byte[] b, int p, SessionVolumeProfile profile, bool available, byte flags, int histogramLevels, bool checkpoints)
        {
            b[p++] = available ? (byte)1 : (byte)0;
            b[p++] = flags;
            p = Publisher.PutU16(b, p, 0);
            if (!available)
            {
                p = Publisher.PutF64(b, p, double.NaN);
                p = Publisher.PutF64(b, p, double.NaN);
                p = Publisher.PutF64(b, p, double.NaN);
                p = Publisher.PutU64(b, p, 0UL);
                p = Publisher.PutU64(b, p, 0UL);
                p = Publisher.PutU64(b, p, 0UL);
                p = Publisher.PutU64(b, p, 0UL);
                p = Publisher.PutU64(b, p, 0UL);
                p = Publisher.PutF64(b, p, double.NaN);
                p = Publisher.PutF64(b, p, double.NaN);
                p = Publisher.PutU16(b, p, 0);              // nodes
                p = Publisher.PutU16(b, p, 0);              // checkpoints
                p = Publisher.PutU16(b, p, 0);              // histogram
                return p;
            }

            p = Publisher.PutF64(b, p, profile.Poc);
            p = Publisher.PutF64(b, p, profile.Vah);
            p = Publisher.PutF64(b, p, profile.Val);
            p = Publisher.PutU64(b, p, (ulong)profile.TotalVolume);
            p = Publisher.PutU64(b, p, (ulong)profile.PocVolume);
            p = Publisher.PutU64(b, p, (ulong)profile.ValueAreaVolume);
            p = Publisher.PutU64(b, p, (ulong)profile.OutOfRangeVolume);
            p = Publisher.PutU64(b, p, (ulong)profile.TapeVolume);
            p = Publisher.PutF64(b, p, profile.RangeLow);
            p = Publisher.PutF64(b, p, profile.RangeHigh);

            int nodeCount = profile.NodeCount;
            ProfileNode[] nodes = profile.Nodes;
            p = Publisher.PutU16(b, p, (ushort)nodeCount);
            for (int i = 0; i < nodeCount; i++)
            {
                p = Publisher.PutF64(b, p, nodes[i].Price);
                p = Publisher.PutF64(b, p, nodes[i].Strength);
                p = Publisher.PutU64(b, p, (ulong)nodes[i].Volume);
                b[p++] = nodes[i].Kind;
                b[p++] = 0;
                p = Publisher.PutU16(b, p, 0);
            }

            int checkpointCount = checkpoints ? profile.CheckpointCount : 0;
            ProfileCheckpoint[] cps = profile.Checkpoints;
            p = Publisher.PutU16(b, p, (ushort)checkpointCount);
            for (int i = 0; i < checkpointCount; i++)
            {
                p = Publisher.PutI64(b, p, cps[i].AtUtcTicks);
                p = Publisher.PutF64(b, p, cps[i].Poc);
                p = Publisher.PutF64(b, p, cps[i].Vah);
                p = Publisher.PutF64(b, p, cps[i].Val);
            }

            int count;
            int start = profile.HistogramWindow(histogramLevels, out count);
            p = Publisher.PutU16(b, p, (ushort)count);
            for (int i = 0; i < count; i++)
            {
                int idx = start + i;
                p = Publisher.PutF64(b, p, profile.PriceAt(idx));
                p = Publisher.PutU64(b, p, (ulong)profile.VolumeAt(idx));
                p = Publisher.PutU64(b, p, (ulong)profile.TapeAt(idx));
                p = Publisher.PutU64(b, p, (ulong)profile.BidAt(idx));
                p = Publisher.PutU64(b, p, (ulong)profile.AskAt(idx));
            }
            return p;
        }
    }
}
