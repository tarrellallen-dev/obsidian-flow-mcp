// Obsidian Flow MCP - AddOn
// Spec sections 2.1 and 3.1: one instrument, two subscriptions, two SPSC rings.
// The handlers copy into a blittable struct, push, and return. Nothing else.
// .NET Framework 4.8. ASCII only.

using System;
using System.Diagnostics;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    // Per instrument: MarketData subscription -> data ring, MarketDepth subscription -> depth ring.
    // Two rings because NT8 documents no guarantee that the two subscription objects raise on the
    // same thread; each is therefore a true single-producer ring. The publisher thread is the
    // single consumer of both.
    public sealed class InstrumentFeed : IDisposable
    {
        // Power of two. Plain ring of the most recent handler durations in Stopwatch ticks.
        // The publisher thread drains it into a LatencyHistogram (step 2); the handler only
        // stores and increments. If the publisher falls more than SampleCapacity behind, the
        // oldest samples are overwritten and counted as overruns on the publisher side.
        public const int SampleCapacity = 65536;
        private const int SampleMask = SampleCapacity - 1;

        // Produced once by InstrumentResolver (step 2.5). Immutable; the feed's fingerprint on
        // the wire and in the archive. A roll never mutates it: a rolled root gets a new feed.
        private readonly InstrumentIdentity _identity;
        private readonly int _index;

        // Local-clock DateTime ticks of the next session boundary, 0 when unknown. Publisher
        // thread only; used to trigger a roll re-check at session end.
        public long SessionBoundaryTicks;

        private readonly SpscRing _dataRing;
        private readonly SpscRing _depthRing;

        // One sample buffer per subscription, each with a single writer thread, so the write is
        // a plain increment plus a masked store with no interlocked operation at all.
        private readonly long[] _dataSamples;
        private readonly long[] _depthSamples;
        private long _dataSampleIndex;    // written only by the MarketData handler thread
        private long _depthSampleIndex;   // written only by the MarketDepth handler thread

        // Step 3: the computed state for this contract. Publisher thread only, from the drained
        // ring; a handler never touches it. Dies with the feed at a roll.
        private readonly MarketState _state;

        private Instrument _instrument;
        private MarketData _marketData;
        private MarketDepth<MarketDepthRow> _marketDepth;

        private double _tickSize;
        private double _pointValue;

        // Data-thread allocation counters. Each handler samples
        // GC.GetAllocatedBytesForCurrentThread every AllocSampleInterval events into its own
        // preallocated slot, so the per-event cost is one mask and one compare against zero;
        // the probe itself runs once every 1024 events. Single writer each, read by the
        // publisher thread, which reports last - first as the running total and the delta over
        // the most recent window as bytes per AllocSampleInterval events, so the non-negotiable
        // in spec 2.1 is measurable rather than asserted.
        public const int AllocSampleInterval = 1024;
        private const long AllocSampleMask = AllocSampleInterval - 1;

        private long _dataAllocFirst = -1;
        private long _dataAllocLast = -1;
        private long _depthAllocFirst = -1;
        private long _depthAllocLast = -1;

        // Bytes allocated between the two most recent probes, i.e. over the last
        // AllocSampleInterval events. Computed on the handler thread and stored as one 64-bit
        // value so the publisher reads a whole window and never a torn pair. -1 until the
        // second probe has run.
        private long _dataAllocWindow = -1;
        private long _depthAllocWindow = -1;

        // ManagedThreadId of the thread that last ran each probe, -1 until the first probe. The
        // counter is thread-wide: several feeds whose handlers NT raises on one thread read the
        // same number, and it includes NT's own allocations on that thread. Readers dedupe by
        // this id before summing.
        private int _dataAllocThreadId = -1;
        private int _depthAllocThreadId = -1;

        private int _disposed;

        public InstrumentFeed(InstrumentIdentity identity, int index, Config config)
        {
            _identity = identity;
            _index = index;
            _dataRing = new SpscRing(config.RingCapacity);
            _depthRing = new SpscRing(config.RingCapacity);
            _state = new MarketState(identity, config);
            _dataSamples = new long[SampleCapacity];
            _depthSamples = new long[SampleCapacity];
            _tickSize = identity != null ? identity.TickSize : 0.0;
            _pointValue = identity != null ? identity.PointValue : 0.0;
            SessionBoundaryTicks = 0;
        }

        public InstrumentIdentity Identity { get { return _identity; } }
        public MarketState State { get { return _state; } }

        // The resolved NT8 name (Instrument.FullName), never what the user typed.
        public string InstrumentName { get { return _identity != null ? _identity.FullName : ""; } }
        public string ResolvedFrom { get { return _identity != null ? _identity.ResolvedFrom : ""; } }
        public int Index { get { return _index; } }
        public SpscRing DataRing { get { return _dataRing; } }
        public SpscRing DepthRing { get { return _depthRing; } }
        public double TickSize { get { return _tickSize; } }
        public double PointValue { get { return _pointValue; } }
        public bool IsSubscribed { get { return _marketData != null || _marketDepth != null; } }

        // Number of handler duration samples recorded since start. Wraps only at 2^63.
        public long SampleCount
        {
            get { return Volatile.Read(ref _dataSampleIndex) + Volatile.Read(ref _depthSampleIndex); }
        }

        public long[] DataSampleBuffer { get { return _dataSamples; } }
        public long[] DepthSampleBuffer { get { return _depthSamples; } }

        // Bytes allocated on the handler's thread between the first and the most recent alloc
        // probe. Returns AllocationProbe.Unavailable (-1) before the first probe has run, so an
        // idle instrument never reports "measured zero". Returns 0 when the host runtime does not
        // expose the counter, because the probe returns 0; callers pass the value through
        // AllocationProbe.Report, which turns that case into -1 as well.
        public long DataThreadAllocDelta
        {
            get
            {
                long first = Volatile.Read(ref _dataAllocFirst);
                long last = Volatile.Read(ref _dataAllocLast);
                if (first < 0)
                    return AllocationProbe.Unavailable;
                return last < first ? 0L : last - first;
            }
        }

        public long DepthThreadAllocDelta
        {
            get
            {
                long first = Volatile.Read(ref _depthAllocFirst);
                long last = Volatile.Read(ref _depthAllocLast);
                if (first < 0)
                    return AllocationProbe.Unavailable;
                return last < first ? 0L : last - first;
            }
        }

        // Thread that ran each probe last, -1 until the first probe.
        public int DataAllocThreadId { get { return Volatile.Read(ref _dataAllocThreadId); } }
        public int DepthAllocThreadId { get { return Volatile.Read(ref _depthAllocThreadId); } }

        // Bytes allocated on the data thread over the most recent AllocSampleInterval events,
        // or -1 before two probes exist. Read on the publisher thread. Callers must substitute
        // -1 when AllocationProbe.IsAvailable is false: this returns 0 in that case because the
        // probe returns 0, and 0 must never be reported as "measured zero" then.
        public long DataAllocBytesPerWindow { get { return Volatile.Read(ref _dataAllocWindow); } }
        public long DepthAllocBytesPerWindow { get { return Volatile.Read(ref _depthAllocWindow); } }

        // Samples recorded by each handler, individually. Read on the publisher thread.
        public long DataSampleIndex { get { return Volatile.Read(ref _dataSampleIndex); } }
        public long DepthSampleIndex { get { return Volatile.Read(ref _depthSampleIndex); } }

        // Called once, on the AddOn worker thread at start or on the publisher thread for a
        // roll. Never on a data thread. Returns false with a reason when the subscription cannot
        // be made; the AddOn keeps running for the other instruments. Resolution itself happened
        // earlier, in InstrumentResolver, and is carried in the identity.
        public bool Subscribe(out string error)
        {
            error = null;
            try
            {
                _instrument = _identity != null ? _identity.Instrument : null;
                if (_instrument == null)
                {
                    error = "no resolved instrument";
                    return false;
                }

                if (_instrument.MasterInstrument != null)
                {
                    _tickSize = _instrument.MasterInstrument.TickSize;
                    _pointValue = _instrument.MasterInstrument.PointValue;
                }

                SessionBoundaryTicks = InstrumentResolver.NextSessionEndTicks(_instrument, DateTime.Now);

                _marketData = new MarketData(_instrument);
                _marketData.Update += OnMarketDataUpdate;

                _marketDepth = new MarketDepth<MarketDepthRow>(_instrument);
                _marketDepth.Update += OnMarketDepthUpdate;

                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                Dispose();
                return false;
            }
        }

        // ---------------------------------------------------------------------------------
        // HOT PATH. NT data thread. Copy the args into a blittable struct, push, return.
        // No allocation, no closures, no strings, no boxing, no locks, no logging, no LINQ.
        //
        // Neither handler reads or writes any state the other handler touches. NT8 documents no
        // guarantee that the two subscription objects raise on the same thread, so sharing a
        // top-of-book cache between them would be an unsynchronized cross-thread read of a
        // double. Each event therefore carries only fields it owns; MdEvent.Bid and MdEvent.Ask
        // are left at 0 by the producer and are reconstructed on the publisher thread, which is
        // the single consumer of both rings and can order them however the spec requires.
        // ---------------------------------------------------------------------------------
        private void OnMarketDataUpdate(object sender, MarketDataEventArgs e)
        {
            long t0 = Stopwatch.GetTimestamp();

            MdEvent ev;
            ev.Kind = MdEventKind.MarketData;
            ev.Price = e.Price;
            ev.Size = e.Volume;
            ev.Bid = 0.0;                       // filled in on the publisher thread
            ev.Ask = 0.0;                       // filled in on the publisher thread
            ev.Position = -1;
            ev.Operation = 0;
            ev.Side = 0;
            ev.MarketDataType = (byte)e.MarketDataType;
            ev.StopwatchTicks = t0;
            ev.TimeTicks = e.Time.Ticks;

            _dataRing.Push(ref ev);

            long di = _dataSampleIndex;

            // The probe runs once per AllocSampleInterval events. It sits inside the timed
            // region on purpose, so its own cost shows up in the handler's p99 and max instead
            // of being hidden by the instrumentation that reports them.
            if ((di & AllocSampleMask) == 0L)
            {
                long bytes = AllocationProbe.Read();
                long last = _dataAllocLast;
                if (last >= 0)
                    Volatile.Write(ref _dataAllocWindow, bytes - last);
                else
                    Volatile.Write(ref _dataAllocFirst, bytes);
                Volatile.Write(ref _dataAllocLast, bytes);
                Volatile.Write(ref _dataAllocThreadId, Thread.CurrentThread.ManagedThreadId);
            }

            // Single-writer sample ring: store the duration, then publish the index.
            _dataSamples[(int)(di & SampleMask)] = Stopwatch.GetTimestamp() - t0;
            Volatile.Write(ref _dataSampleIndex, di + 1);
        }

        private void OnMarketDepthUpdate(object sender, MarketDepthEventArgs e)
        {
            long t0 = Stopwatch.GetTimestamp();

            MdEvent ev;
            ev.Kind = MdEventKind.MarketDepth;
            ev.Price = e.Price;
            ev.Size = e.Volume;
            ev.Bid = 0.0;                       // filled in on the publisher thread
            ev.Ask = 0.0;                       // filled in on the publisher thread
            ev.Position = e.Position;
            ev.Operation = (byte)e.Operation;
            ev.Side = (byte)e.MarketDataType;
            ev.MarketDataType = (byte)e.MarketDataType;
            ev.StopwatchTicks = t0;
            ev.TimeTicks = e.Time.Ticks;

            _depthRing.Push(ref ev);

            long si = _depthSampleIndex;

            if ((si & AllocSampleMask) == 0L)
            {
                long bytes = AllocationProbe.Read();
                long last = _depthAllocLast;
                if (last >= 0)
                    Volatile.Write(ref _depthAllocWindow, bytes - last);
                else
                    Volatile.Write(ref _depthAllocFirst, bytes);
                Volatile.Write(ref _depthAllocLast, bytes);
                Volatile.Write(ref _depthAllocThreadId, Thread.CurrentThread.ManagedThreadId);
            }

            _depthSamples[(int)(si & SampleMask)] = Stopwatch.GetTimestamp() - t0;
            Volatile.Write(ref _depthSampleIndex, si + 1);
        }

        // ---------------------------------------------------------------------------------

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
                return;

            // NT8's MarketData and MarketDepth<T> are not IDisposable. Detaching the handler is
            // the whole of the teardown: once the last reference is dropped the subscription is
            // no longer reachable and nothing of ours is left on the data thread.
            try
            {
                if (_marketData != null)
                    _marketData.Update -= OnMarketDataUpdate;
            }
            catch (Exception)
            {
                // Teardown must never throw out of State.Terminated.
            }
            finally
            {
                _marketData = null;
            }

            try
            {
                if (_marketDepth != null)
                    _marketDepth.Update -= OnMarketDepthUpdate;
            }
            catch (Exception)
            {
            }
            finally
            {
                _marketDepth = null;
            }

            // The market state holds one bootstrap BarsRequest for its session calendar; at a
            // roll this feed is replaced and that request has no further reader.
            try
            {
                if (_state != null)
                    _state.Dispose();
            }
            catch (Exception)
            {
            }

            _instrument = null;
        }
    }
}
