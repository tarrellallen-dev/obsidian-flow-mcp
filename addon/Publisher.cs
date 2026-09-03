// Obsidian Flow MCP - AddOn
// Spec sections 3.1 and 3.3: one publisher thread, named pipe server, length-prefixed frames.
// Step 1 computes nothing about the market. It drains the rings, discards the contents, counts,
// and publishes transport-level counters so the threading contract can be proved.
// Step 2 adds instrumentation (spec 2.5, 8): the publisher thread drains each feed's handler
// duration samples into per-instrument LatencyHistograms, times its own frame serialization,
// recomputes percentiles once a second, appends them to the snapshot payload, and optionally
// dumps them as CSV every 10 s. All of that runs here, never on a data thread.
// Step 2.5 adds roll detection: once a minute and at every session boundary, each feed whose
// config entry was a bare root is re-resolved on this thread; when the front contract changed,
// a new feed (new rings, new counters) is built and swapped in at the same index, the old one
// is unsubscribed, the hello is re-announced with the new identity and a contractRolled event
// carries both identities. Fully qualified and non-futures entries are never re-resolved.
// .NET Framework 4.8. ASCII only.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public sealed class Publisher : IDisposable
    {
        // ----- wire constants (schema/wire-v1.md) -----
        public const ushort SchemaVersion = 1;
        public const ushort FrameTypeSnapshot = 1;
        public const ushort FrameTypeEvent = 2;
        public const ushort FrameTypeHello = 3;
        public const ushort FrameTypeHeartbeat = 4;
        public const ushort InstrumentNone = 0xFFFF;
        public const int MaxFrameBytes = 1048576;   // 1 MiB
        public const int HeaderBytes = 32;          // bytes after the u32 length field

        // Event kinds carried by frame type 2 (schema/wire-v1.md "type 2 - event").
        public const ushort EventContractRolled = 1;

        // Roll re-check cadence for root entries (step 2.5): at most once a minute, plus the
        // session boundary trigger. The clock is probed once a second to keep DateTime.Now
        // off the per-pass drain path.
        private const int RollCheckIntervalMs = 60000;
        private const int RollProbeIntervalMs = 1000;

        private const int HeartbeatMs = 1000;

        // Percentiles are recomputed at most this often (spec: once per second).
        private const int SummaryIntervalMs = 1000;

        // CSV dump cadence when config.dumpTo is set.
        private const int DumpIntervalMs = 10000;

        private const int SampleMask = InstrumentFeed.SampleCapacity - 1;

        // How long the accept wait blocks before coming back to drain the rings.
        private const int AcceptPollMs = 10;

        private readonly Config _config;

        // The live feeds, indexed by instrument index. Written only by the publisher thread
        // (a roll swaps one element); read by the status window through FeedsSnapshot with
        // volatile reads. Never resized: the hello table's indices are fixed for the process.
        private readonly InstrumentFeed[] _feeds;
        private readonly UnresolvedInstrument[] _unresolved;

        // Rolls detected since the last hello went out on the current connection. Publisher
        // thread only. Cleared when a hello carries the new identities.
        private readonly List<RollRecord> _pendingRolls = new List<RollRecord>();
        private long _nextRollProbeTicks;
        private long _nextRollCheckTicks;
        private long _rollsTotal;
        private string _lastRoll;

        private readonly byte[] _frameBuffer;       // preallocated; reused for every frame
        private readonly Thread _thread;

        // Stop is a plain volatile flag. The event exists only to wake a blocked wait, and it is
        // never disposed while the publisher thread might still touch it (see Dispose).
        private volatile bool _stopRequested;
        private readonly ManualResetEvent _wake = new ManualResetEvent(false);
        private int _wakeClosed;

        private uint _sequence;
        private long _publisherAllocBaseline;

        // ----- instrumentation, publisher thread only (step 2) -----
        // One histogram per handler per instrument, indexed like _feeds, plus one for frame
        // serialization. Sample buffers are drained by position: _dataDrained[i] is the next
        // sample index of feed i not yet recorded.
        private readonly LatencyHistogram[] _dataHist;
        private readonly LatencyHistogram[] _depthHist;
        private readonly LatencyHistogram _serializeHist;
        private readonly long[] _dataDrained;
        private readonly long[] _depthDrained;
        private readonly long[] _dataOverruns;
        private readonly long[] _depthOverruns;
        private readonly long[] _dataDrops;
        private readonly long[] _depthDrops;

        // Once-per-second summaries. Written here, read by the status window and WriteSnapshot.
        private readonly LatencySummary[] _dataSummary;
        private readonly LatencySummary[] _depthSummary;
        private readonly LatencySummary _serializeSummary;
        private long _nextSummaryTicks;
        private long _publisherAllocTotal;          // -1 when the counter is unavailable

        // CSV dump (config.dumpTo). Owned by the publisher thread from open to close.
        private FileStream _dump;
        private long _nextDumpTicks;
        private StringBuilder _dumpText;
        private byte[] _dumpBytes;
        private volatile bool _dumpFailed;
        private string _dumpError;

        // Drops read out of the rings but not yet reported in a frame header. Touched on the
        // publisher thread only; cleared when a frame carries them.
        private long _pendingDropped;

        // ----- status counters, read by the status window on the UI thread -----
        private long _eventsDrained;
        private long _framesSent;
        private long _droppedTotal;
        private long _allocDelta;
        private long _handlerSamples;
        private int _connected;                     // 0 or 1
        private string _lastError;

        private int _disposed;

        public Publisher(Config config, List<InstrumentFeed> feeds, List<UnresolvedInstrument> unresolved)
        {
            _config = config;
            _feeds = feeds.ToArray();
            _unresolved = unresolved != null ? unresolved.ToArray() : new UnresolvedInstrument[0];
            _frameBuffer = new byte[MaxFrameBytes];

            int n = _feeds.Length;
            _dataHist = new LatencyHistogram[n];
            _depthHist = new LatencyHistogram[n];
            _dataSummary = new LatencySummary[n];
            _depthSummary = new LatencySummary[n];
            for (int i = 0; i < n; i++)
            {
                _dataHist[i] = new LatencyHistogram();
                _depthHist[i] = new LatencyHistogram();
                _dataSummary[i] = new LatencySummary();
                _depthSummary[i] = new LatencySummary();
            }
            _serializeHist = new LatencyHistogram();
            _serializeSummary = new LatencySummary();
            _dataDrained = new long[n];
            _depthDrained = new long[n];
            _dataOverruns = new long[n];
            _depthOverruns = new long[n];
            _dataDrops = new long[n];
            _depthDrops = new long[n];
            _publisherAllocTotal = AllocationProbe.Unavailable;

            _thread = new Thread(Run);
            _thread.IsBackground = true;
            _thread.Name = "ObsidianFlow.OrderFlowMcp.Publisher";
        }

        public long EventsDrained { get { return Interlocked.Read(ref _eventsDrained); } }
        public long FramesSent { get { return Interlocked.Read(ref _framesSent); } }
        public long DroppedTotal { get { return Interlocked.Read(ref _droppedTotal); } }
        public long AllocDelta { get { return Interlocked.Read(ref _allocDelta); } }
        public long HandlerSamples { get { return Interlocked.Read(ref _handlerSamples); } }
        public bool IsConnected { get { return Volatile.Read(ref _connected) != 0; } }
        public string LastError { get { return Volatile.Read(ref _lastError); } }
        public string PipeName { get { return _config.PipeName; } }

        // ----- roll status (status window, UI thread) -----
        public long RollsTotal { get { return Interlocked.Read(ref _rollsTotal); } }
        public string LastRoll { get { return Volatile.Read(ref _lastRoll); } }
        public UnresolvedInstrument[] Unresolved { get { return _unresolved; } }

        // Copy of the live feed array. Elements are read with Volatile.Read so a swap made by
        // the publisher thread is seen whole (the reference is the unit of publication and the
        // feed's identity is immutable).
        public InstrumentFeed[] FeedsSnapshot()
        {
            InstrumentFeed[] copy = new InstrumentFeed[_feeds.Length];
            for (int i = 0; i < _feeds.Length; i++)
                copy[i] = Volatile.Read(ref _feeds[i]);
            return copy;
        }

        // ----- instrumentation accessors (status window, UI thread; plain volatile reads) -----
        public int FeedCount { get { return _feeds.Length; } }
        public string FeedName(int i) { return Volatile.Read(ref _feeds[i]).InstrumentName; }
        public LatencySummary DataSummary(int i) { return _dataSummary[i]; }
        public LatencySummary DepthSummary(int i) { return _depthSummary[i]; }
        public LatencySummary SerializeSummary { get { return _serializeSummary; } }
        public long PublisherAllocBytesTotal { get { return Interlocked.Read(ref _publisherAllocTotal); } }
        public string DumpPath { get { return _config.DumpTo; } }
        public string DumpError { get { return Volatile.Read(ref _dumpError); } }

        public void Start()
        {
            _thread.Start();
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
                return;

            bool joined = false;
            try
            {
                _stopRequested = true;
                SetWake();
                // A blocked WaitForConnection is released by connecting a throwaway client.
                PokePipe();
                joined = _thread.Join(3000);
            }
            catch (Exception)
            {
            }

            // The event is closed only when the publisher thread is provably finished with it.
            // A thread that outlived the join still holds a live handle; leaking one handle at
            // shutdown is preferable to an ObjectDisposedException escaping onto a background
            // thread inside the NinjaTrader process.
            if (joined && Interlocked.Exchange(ref _wakeClosed, 1) == 0)
            {
                try { _wake.Close(); } catch (Exception) { }
            }

            // The publisher thread closes the dump on its way out of Run. If it did not come
            // back from the join, the file must not stay open for the life of the NT process:
            // take it away here and say so. The thread, if it is still running, sees null and
            // stops writing; a write racing this close fails into _dumpError, not out of the
            // thread.
            if (!joined)
            {
                Volatile.Write(ref _lastError, "publisher thread did not stop within 3 s; dump closed from Dispose");
                CloseDump();
            }
        }

        private void SetWake()
        {
            if (Volatile.Read(ref _wakeClosed) != 0)
                return;
            try { _wake.Set(); } catch (ObjectDisposedException) { }
        }

        private void PokePipe()
        {
            try
            {
                using (NamedPipeClientStream poke = new NamedPipeClientStream(".", _config.PipeName, PipeDirection.InOut))
                {
                    poke.Connect(200);
                }
            }
            catch (Exception)
            {
                // Nothing listening, or already torn down. Either is fine.
            }
        }

        // ------------------------------------------------------------------
        // Publisher thread
        // ------------------------------------------------------------------
        private void Run()
        {
            _publisherAllocBaseline = AllocationProbe.Read();
            _nextSummaryTicks = Stopwatch.GetTimestamp() + (Stopwatch.Frequency * SummaryIntervalMs) / 1000L;
            _nextDumpTicks = Stopwatch.GetTimestamp() + (Stopwatch.Frequency * DumpIntervalMs) / 1000L;
            _nextRollProbeTicks = Stopwatch.GetTimestamp() + (Stopwatch.Frequency * RollProbeIntervalMs) / 1000L;
            _nextRollCheckTicks = Stopwatch.GetTimestamp() + (Stopwatch.Frequency * RollCheckIntervalMs) / 1000L;
            OpenDump();

            while (!_stopRequested)
            {
                NamedPipeServerStream server = null;
                try
                {
                    // PipeOptions.None, not Asynchronous: every write below is a synchronous
                    // Stream.Write, and a synchronous write to an overlapped handle allocates an
                    // Overlapped plus an IAsyncResult per call on .NET Framework. The connection
                    // wait is made interruptible by an accept thread instead (see Accept).
                    server = new NamedPipeServerStream(
                        _config.PipeName,
                        PipeDirection.InOut,
                        1,
                        PipeTransmissionMode.Byte,
                        PipeOptions.None);

                    AcceptResult result = Accept(server);

                    // Only a stop request ends the publisher loop. A failed accept is transient
                    // (the pipe name momentarily held, a client racing the handshake, an ACL
                    // hiccup) and must not silently retire the transport for the life of the
                    // NinjaTrader process.
                    if (result == AcceptResult.Stop)
                        break;

                    if (result == AcceptResult.Connected)
                    {
                        Volatile.Write(ref _connected, 1);
                        Volatile.Write(ref _lastError, null);

                        _sequence = 0;
                        ServeConnection(server);
                    }
                }
                catch (Exception ex)
                {
                    // A pipe exception must never kill this thread.
                    Volatile.Write(ref _lastError, ex.Message);
                }
                finally
                {
                    Volatile.Write(ref _connected, 0);
                    if (server != null)
                    {
                        try { server.Dispose(); } catch (Exception) { }
                    }
                }

                // Keep draining while nobody is attached so the rings never wedge. This doubles
                // as the retry backoff after a failed accept: roughly 250 ms, spent working.
                // Under the same catch as the connection: nothing thrown here may end this
                // thread inside the NinjaTrader process.
                try
                {
                    for (int i = 0; i < 25 && !_stopRequested; i++)
                    {
                        DrainAll();
                        Thread.Sleep(10);
                    }
                }
                catch (Exception ex)
                {
                    Volatile.Write(ref _lastError, ex.Message);
                }
            }

            // Final drain so the rings are empty at shutdown.
            try { DrainAll(); } catch (Exception) { }
            CloseDump();
        }

        private enum AcceptResult
        {
            Connected,      // a client is attached; serve it
            Retry,          // accept failed, or the connection was abandoned; build a new server
            Stop            // the publisher is shutting down
        }

        // Blocking WaitForConnection runs on its own short-lived thread so the publisher thread
        // can keep draining the rings while no client is attached. Without this the rings fill
        // and drop for as long as the server process is down. One thread per connection cycle,
        // never per frame.
        //
        // This method does not return until the accept thread has provably finished, because the
        // caller disposes the NamedPipeServerStream as soon as it does. Returning early would
        // dispose the stream under a thread still blocked inside WaitForConnection, and that
        // thread would keep the pipe name held: with maxInstances deliberately fixed at 1, the
        // next NamedPipeServerStream for the same name would then fail forever.
        private AcceptResult Accept(NamedPipeServerStream server)
        {
            ManualResetEvent done = new ManualResetEvent(false);
            Exception acceptError = null;
            bool accepted = false;

            Thread accept = new Thread(delegate ()
            {
                try
                {
                    server.WaitForConnection();
                    accepted = true;
                }
                catch (Exception ex)
                {
                    acceptError = ex;
                }
                finally
                {
                    try { done.Set(); } catch (ObjectDisposedException) { }
                }
            });
            accept.IsBackground = true;
            accept.Name = "ObsidianFlow.OrderFlowMcp.Accept";

            // Hoisted: allocating this array inside the poll loop would allocate every 10 ms.
            WaitHandle[] handles = new WaitHandle[] { done, _wake };

            bool stopping = false;

            try
            {
                accept.Start();

                for (;;)
                {
                    int signalled = WaitHandle.WaitAny(handles, AcceptPollMs);

                    if (signalled == 0)
                        break;                              // connected, or the accept threw

                    if (signalled == 1 || _stopRequested)
                    {
                        stopping = true;
                        break;
                    }

                    // WaitHandle.WaitTimeout: nobody is attached yet. Keep the rings moving.
                    DrainAll();
                }
            }
            catch (Exception ex)
            {
                Volatile.Write(ref _lastError, ex.Message);
            }
            finally
            {
                // Unblock WaitForConnection by connecting a throwaway client, and keep doing so
                // until the accept thread signals. A single poke can be lost to a race, so this
                // retries rather than trusting one attempt; it is bounded only by the thread
                // actually exiting, which is the whole point.
                int pokes = 0;
                while (!done.WaitOne(50))
                {
                    PokePipe();
                    pokes++;
                    if (pokes == 20)
                        Volatile.Write(ref _lastError, "waiting for the accept thread to release the pipe");
                }

                // done is set in the accept thread's finally, so the thread is at its exit.
                accept.Join();
                try { done.Close(); } catch (Exception) { }
            }

            if (stopping || _stopRequested)
                return AcceptResult.Stop;

            if (acceptError != null)
            {
                Volatile.Write(ref _lastError, acceptError.Message);
                return AcceptResult.Retry;
            }

            return accepted ? AcceptResult.Connected : AcceptResult.Retry;
        }

        private void ServeConnection(NamedPipeServerStream server)
        {
            // The hello already carries rolledAt and rollCount for every feed, so rolls that
            // happened while nobody was attached need no separate event on this connection.
            WriteHello(server);
            _pendingRolls.Clear();

            long freq = Stopwatch.Frequency;
            long snapshotIntervalTicks = freq / Math.Max(1, _config.PushRateHz);
            if (snapshotIntervalTicks < 1)
                snapshotIntervalTicks = 1;
            long heartbeatIntervalTicks = (freq * HeartbeatMs) / 1000L;

            long now = Stopwatch.GetTimestamp();
            long nextSnapshot = now + snapshotIntervalTicks;
            long nextHeartbeat = now + heartbeatIntervalTicks;

            int idleSpins = 0;

            while (!_stopRequested && server.IsConnected)
            {
                int drained = DrainAll();

                // A roll swapped a feed during that drain. Re-announce the table (same indices,
                // new identity at the rolled index) and mark the boundary with a discrete event
                // before any snapshot of the new contract goes out under that index.
                if (_pendingRolls.Count > 0)
                {
                    WriteHello(server);
                    for (int r = 0; r < _pendingRolls.Count; r++)
                        WriteContractRolled(server, _pendingRolls[r]);
                    _pendingRolls.Clear();
                }

                now = Stopwatch.GetTimestamp();

                if (now >= nextSnapshot)
                {
                    for (int i = 0; i < _feeds.Length; i++)
                        WriteSnapshot(server, _feeds[i]);

                    // Fixed cadence, not now + interval, so the schedule does not drift by the
                    // cost of each pass. If a pause put us more than one interval behind, the
                    // missed slots are abandoned rather than fired back to back: this is a
                    // conflated feed, so catching up would only publish stale duplicates.
                    nextSnapshot += snapshotIntervalTicks;
                    if (nextSnapshot <= now)
                        nextSnapshot = now + snapshotIntervalTicks;
                }

                if (now >= nextHeartbeat)
                {
                    WriteHeartbeat(server);
                    nextHeartbeat += heartbeatIntervalTicks;
                    if (nextHeartbeat <= now)
                        nextHeartbeat = now + heartbeatIntervalTicks;
                }

                // Bounded spin, then yield, then sleep. Never a busy loop at full tilt.
                if (drained > 0)
                {
                    idleSpins = 0;
                }
                else
                {
                    idleSpins++;
                    if (idleSpins < 64)
                        Thread.SpinWait(32);
                    else if (idleSpins < 128)
                        Thread.Sleep(0);
                    else
                        Thread.Sleep(1);
                }
            }
        }

        // Ring contents are still discarded in step 2 (no calculators yet); only counts matter.
        // Drops read out of the rings are held in _pendingDropped until a frame header carries
        // them. Handler duration samples are drained into the histograms here, and once a
        // second the percentile summaries are refreshed.
        private int DrainAll()
        {
            int total = 0;
            long dropped = 0;
            long samples = 0;

            for (int i = 0; i < _feeds.Length; i++)
            {
                InstrumentFeed f = _feeds[i];
                total += f.DataRing.Drain(null);
                total += f.DepthRing.Drain(null);

                long dataDropped = f.DataRing.ExchangeDropped();
                long depthDropped = f.DepthRing.ExchangeDropped();
                dropped += dataDropped + depthDropped;
                _dataDrops[i] += dataDropped;
                _depthDrops[i] += depthDropped;

                long dataProduced = f.DataSampleIndex;
                long depthProduced = f.DepthSampleIndex;
                samples += dataProduced + depthProduced;

                _dataOverruns[i] += DrainSamples(f, false, dataProduced, ref _dataDrained[i], _dataHist[i]);
                _depthOverruns[i] += DrainSamples(f, true, depthProduced, ref _depthDrained[i], _depthHist[i]);
            }

            if (total != 0)
                Interlocked.Add(ref _eventsDrained, total);
            if (dropped != 0)
            {
                _pendingDropped += dropped;
                Interlocked.Add(ref _droppedTotal, dropped);
            }
            Interlocked.Exchange(ref _handlerSamples, samples);

            long now = Stopwatch.GetTimestamp();
            if (now >= _nextSummaryTicks)
            {
                RecomputeSummaries();
                _nextSummaryTicks = now + (Stopwatch.Frequency * SummaryIntervalMs) / 1000L;
            }
            if (_dump != null && !_dumpFailed && now >= _nextDumpTicks)
            {
                WriteDump();
                _nextDumpTicks = now + (Stopwatch.Frequency * DumpIntervalMs) / 1000L;
            }
            if (now >= _nextRollProbeTicks)
            {
                CheckRolls(now);
                _nextRollProbeTicks = now + (Stopwatch.Frequency * RollProbeIntervalMs) / 1000L;
            }

            return total;
        }

        // ------------------------------------------------------------------
        // Roll detection (step 2.5). Publisher thread only.
        // ------------------------------------------------------------------
        private sealed class RollRecord
        {
            public int Index;
            public InstrumentIdentity Previous;
            public InstrumentIdentity Next;
        }

        // Once a second: decide whether the minute deadline or any feed's session boundary has
        // passed, and only then touch the wall clock and the resolver. Root entries only.
        private void CheckRolls(long swNow)
        {
            bool minuteDue = swNow >= _nextRollCheckTicks;
            if (minuteDue)
                _nextRollCheckTicks = swNow + (Stopwatch.Frequency * RollCheckIntervalMs) / 1000L;

            DateTime now = DateTime.Now;

            for (int i = 0; i < _feeds.Length; i++)
            {
                InstrumentFeed feed = _feeds[i];
                if (feed == null || feed.Identity == null)
                    continue;

                bool sessionDue = feed.SessionBoundaryTicks != 0 && now.Ticks >= feed.SessionBoundaryTicks;
                if (sessionDue)
                    feed.SessionBoundaryTicks = InstrumentResolver.NextSessionEndTicks(feed.Identity.Instrument, now);

                if (feed.Identity.Shape != InstrumentShape.Root)
                    continue;
                if (!minuteDue && !sessionDue)
                    continue;

                try
                {
                    ReResolve(i, feed, now);
                }
                catch (Exception ex)
                {
                    // A resolver or subscription failure leaves the current feed in place and
                    // is reported; it never ends this thread.
                    Volatile.Write(ref _lastError, "roll check " + feed.ResolvedFrom + ": " + ex.Message);
                }
            }
        }

        private void ReResolve(int index, InstrumentFeed current, DateTime now)
        {
            InstrumentIdentity previous = current.Identity;
            string error;
            InstrumentIdentity candidate = InstrumentResolver.Resolve(
                previous.ResolvedFrom, now, previous.RolledAtUtcTicks, previous.RollCount, out error);

            if (candidate == null)
            {
                // Keep the contract we have; the reason is visible in the status window.
                Volatile.Write(ref _lastError, "roll check " + previous.ResolvedFrom + ": " + error);
                return;
            }
            if (candidate.SameContract(previous))
                return;

            InstrumentIdentity next = candidate.AsRolledFrom(previous, DateTime.UtcNow);

            // New feed, new rings, new counters: nothing accumulated under the old contract is
            // carried across, and the old MarketData/MarketDepth objects keep their own rings
            // until they are unhooked, so no ring ever has two producers.
            InstrumentFeed replacement = new InstrumentFeed(next, index, _config.RingCapacity);
            if (!replacement.Subscribe(out error))
            {
                replacement.Dispose();
                Volatile.Write(ref _lastError, "roll " + previous.FullName + " -> " + next.FullName + " subscribe failed: " + error);
                return;
            }

            Volatile.Write(ref _feeds[index], replacement);

            // Contract-specific per-index state: sample drain positions restart with the new
            // feed's counters, and ring drops and overruns belong to the old rings. The latency
            // histograms measure the handler code, not the contract, and are kept.
            _dataDrained[index] = 0;
            _depthDrained[index] = 0;
            _dataDrops[index] = 0;
            _depthDrops[index] = 0;
            _dataOverruns[index] = 0;
            _depthOverruns[index] = 0;

            try { current.Dispose(); } catch (Exception) { }

            RollRecord record = new RollRecord();
            record.Index = index;
            record.Previous = previous;
            record.Next = next;
            _pendingRolls.Add(record);

            Interlocked.Increment(ref _rollsTotal);
            Volatile.Write(ref _lastRoll, previous.ResolvedFrom + ": " + previous.FullName + " -> " + next.FullName
                + " at " + new DateTime(next.RolledAtUtcTicks, DateTimeKind.Utc).ToString("yyyy-MM-dd HH:mm:ss'Z'", CultureInfo.InvariantCulture));
        }

        // Records every sample in [drained, produced) into h and advances drained. The handler's
        // sample ring holds SampleCapacity entries and the handler keeps writing while this
        // reads, so the read window is clamped to the newest SampleCapacity / 2 samples: a
        // handler would have to produce another half ring during this loop to overwrite a slot
        // being read. Whether it did is checked afterwards by re-reading the producer index; any
        // sample the producer could have reached past the ring's capacity is charged as an
        // overrun, so the histogram is never silently fed garbage without the count saying so.
        // The handler publishes the index with a volatile write after the slot store, and this
        // reads the index with a volatile read before the slots, so a sample below the observed
        // index is fully written.
        private static long DrainSamples(InstrumentFeed f, bool depth, long produced, ref long drained, LatencyHistogram h)
        {
            long start = drained;
            long lag = produced - start;
            if (lag <= 0)
                return 0;

            const long ReadWindow = InstrumentFeed.SampleCapacity / 2;
            long[] buffer = depth ? f.DepthSampleBuffer : f.DataSampleBuffer;

            long overrun = 0;
            if (lag > ReadWindow)
            {
                overrun = lag - ReadWindow;
                start = produced - ReadWindow;
            }

            for (long i = start; i < produced; i++)
                h.Record(buffer[(int)(i & SampleMask)]);

            // Anything the producer wrote past start + SampleCapacity during the loop landed on
            // a slot this loop may have read. Count those as overruns too.
            long nowProduced = depth ? f.DepthSampleIndex : f.DataSampleIndex;
            long reach = nowProduced - start;
            if (reach > InstrumentFeed.SampleCapacity)
                overrun += reach - InstrumentFeed.SampleCapacity;

            drained = produced;
            return overrun;
        }

        private void RecomputeSummaries()
        {
            long allocNow = AllocationProbe.Read();
            long delta = allocNow - _publisherAllocBaseline;
            if (delta < 0)
                delta = 0;
            Interlocked.Exchange(ref _allocDelta, delta);
            Interlocked.Exchange(ref _publisherAllocTotal, AllocationProbe.Report(delta));

            for (int i = 0; i < _feeds.Length; i++)
            {
                InstrumentFeed f = _feeds[i];
                _dataSummary[i].Update(
                    _dataHist[i],
                    AllocationProbe.Report(f.DataAllocBytesPerWindow),
                    AllocationProbe.Report(f.DataThreadAllocDelta),
                    _dataOverruns[i],
                    _dataDrops[i]);
                _depthSummary[i].Update(
                    _depthHist[i],
                    AllocationProbe.Report(f.DepthAllocBytesPerWindow),
                    AllocationProbe.Report(f.DepthThreadAllocDelta),
                    _depthOverruns[i],
                    _depthDrops[i]);
            }

            _serializeSummary.Update(_serializeHist, AllocationProbe.Unavailable, AllocationProbe.Report(delta), 0, 0);
        }

        // ------------------------------------------------------------------
        // CSV dump. Publisher thread only. Opt-in via config.dumpTo. This is the one place the
        // publisher allocates on purpose (a timestamp string every 10 s); a handler never waits
        // on it because handlers never wait on the publisher at all. A slow disk delays ring
        // draining, which shows up as ring drops, not as handler latency.
        // ------------------------------------------------------------------
        private const string DumpHeader = "timestamp,instrument,kind,count,p50,p99,p999,max,allocPer1024,allocTotal\r\n";

        private void OpenDump()
        {
            string path = _config.DumpTo;
            if (string.IsNullOrEmpty(path))
                return;
            try
            {
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    Directory.CreateDirectory(dir);

                _dump = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
                _dumpText = new StringBuilder(1024);
                _dumpBytes = new byte[4096];
                if (_dump.Length == 0)
                {
                    int n = Encoding.ASCII.GetBytes(DumpHeader, 0, DumpHeader.Length, _dumpBytes, 0);
                    _dump.Write(_dumpBytes, 0, n);
                    _dump.Flush();
                }
            }
            catch (Exception ex)
            {
                _dumpFailed = true;
                Volatile.Write(ref _dumpError, ex.Message);
                CloseDump();
            }
        }

        private void CloseDump()
        {
            FileStream d = _dump;
            _dump = null;
            if (d == null)
                return;
            try { d.Flush(); } catch (Exception) { }
            try { d.Dispose(); } catch (Exception) { }
        }

        private void WriteDump()
        {
            try
            {
                string stamp = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
                _dumpText.Length = 0;

                for (int i = 0; i < _feeds.Length; i++)
                {
                    string name = _feeds[i].InstrumentName;
                    AppendDumpRow(stamp, name, "data", _dataSummary[i]);
                    AppendDumpRow(stamp, name, "depth", _depthSummary[i]);
                }
                AppendDumpRow(stamp, "publisher", "serialize", _serializeSummary);

                int needed = Encoding.ASCII.GetMaxByteCount(_dumpText.Length);
                if (_dumpBytes.Length < needed)
                    _dumpBytes = new byte[needed];

                string text = _dumpText.ToString();
                int n = Encoding.ASCII.GetBytes(text, 0, text.Length, _dumpBytes, 0);
                _dump.Write(_dumpBytes, 0, n);
                _dump.Flush();
            }
            catch (Exception ex)
            {
                _dumpFailed = true;
                Volatile.Write(ref _dumpError, ex.Message);
                CloseDump();
            }
        }

        // Nanoseconds throughout. allocPer1024 is -1 when not measured (runtime lacks the
        // counter, fewer than two probes yet, or the publisher row, where it is not defined).
        private void AppendDumpRow(string stamp, string instrument, string kind, LatencySummary sm)
        {
            StringBuilder sb = _dumpText;
            sb.Append(stamp).Append(',');
            AppendCsvField(sb, instrument);
            sb.Append(',').Append(kind).Append(',');
            sb.Append(sm.Count.ToString(CultureInfo.InvariantCulture)).Append(',');
            sb.Append(sm.P50Ns.ToString(CultureInfo.InvariantCulture)).Append(',');
            sb.Append(sm.P99Ns.ToString(CultureInfo.InvariantCulture)).Append(',');
            sb.Append(sm.P999Ns.ToString(CultureInfo.InvariantCulture)).Append(',');
            sb.Append(sm.MaxNs.ToString(CultureInfo.InvariantCulture)).Append(',');
            sb.Append(sm.AllocBytesPer1024.ToString(CultureInfo.InvariantCulture)).Append(',');
            sb.Append(sm.AllocBytesTotal.ToString(CultureInfo.InvariantCulture));
            sb.Append("\r\n");
        }

        private static void AppendCsvField(StringBuilder sb, string s)
        {
            bool quote = s.IndexOf(',') >= 0 || s.IndexOf('"') >= 0;
            if (!quote)
            {
                sb.Append(s);
                return;
            }
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '"')
                    sb.Append('"');
                sb.Append(c);
            }
            sb.Append('"');
        }

        // Reads and clears the drops owed to the next frame header. The field is u32 on the wire;
        // a burst larger than uint.MaxValue between two frames is not physically reachable, but
        // the remainder is carried into the next frame rather than lost if it ever were.
        private uint TakePendingDropped()
        {
            long pending = _pendingDropped;
            if (pending <= 0)
                return 0;
            if (pending > uint.MaxValue)
            {
                _pendingDropped = pending - uint.MaxValue;
                return uint.MaxValue;
            }
            _pendingDropped = 0;
            return (uint)pending;
        }

        // ------------------------------------------------------------------
        // Frame writers. All serialization goes into the preallocated buffer with
        // manual little-endian stores. No BinaryWriter, no per-frame allocation.
        // ------------------------------------------------------------------
        private void WriteHello(NamedPipeServerStream server)
        {
            int p = 4 + HeaderBytes;

            // The client needs the publisher's Stopwatch frequency to interpret sentTicks at all.
            // Without it sentTicks is an opaque monotone counter and staleness can only ever be
            // measured from receive time forward, with no way to say so honestly.
            p = PutU64(_frameBuffer, p, (ulong)Stopwatch.Frequency);

            // ----- base table (steps 1 and 2; layout unchanged) -----
            p = PutU16(_frameBuffer, p, (ushort)_feeds.Length);
            for (int i = 0; i < _feeds.Length; i++)
            {
                InstrumentFeed f = _feeds[i];
                p = PutU16(_frameBuffer, p, (ushort)f.Index);
                p = PutAsciiWithU8Length(_frameBuffer, p, f.InstrumentName);
                p = PutF64(_frameBuffer, p, f.TickSize);
                p = PutF64(_frameBuffer, p, f.PointValue);
            }

            // ----- identity section (step 2.5, additive; schema/wire-v1.md "hello") -----
            p = PutU16(_frameBuffer, p, (ushort)_feeds.Length);
            for (int i = 0; i < _feeds.Length; i++)
            {
                InstrumentFeed f = _feeds[i];
                p = PutU16(_frameBuffer, p, (ushort)f.Index);
                p = PutIdentity(_frameBuffer, p, f.Identity);
            }

            p = PutU16(_frameBuffer, p, (ushort)_unresolved.Length);
            for (int i = 0; i < _unresolved.Length; i++)
            {
                p = PutAsciiWithU8Length(_frameBuffer, p, _unresolved[i].Typed);
                p = PutAsciiWithU8Length(_frameBuffer, p, _unresolved[i].Reason);
            }

            EmitFrame(server, FrameTypeHello, InstrumentNone, p);
        }

        // Identity block, schema/wire-v1.md "identity block". Same layout in the hello and in
        // the contractRolled event. Strings are ASCII with a u8 length; missing strings are
        // written with length 0.
        private static int PutIdentity(byte[] b, int p, InstrumentIdentity id)
        {
            b[p++] = id != null ? (byte)id.Shape : (byte)0;
            b[p++] = id != null ? (byte)id.ResolvedBy : (byte)0;
            p = PutAsciiWithU8Length(b, p, id != null ? id.ResolvedFrom : null);
            p = PutAsciiWithU8Length(b, p, id != null ? id.FullName : null);
            p = PutAsciiWithU8Length(b, p, id != null ? id.MasterName : null);
            p = PutAsciiWithU8Length(b, p, id != null ? id.InstrumentType : null);
            p = PutAsciiWithU8Length(b, p, id != null ? id.Exchange : null);
            p = PutAsciiWithU8Length(b, p, id != null ? id.Currency : null);
            p = PutAsciiWithU8Length(b, p, id != null ? id.TradingHours : null);
            p = PutI64(b, p, id != null ? id.ExpiryTicks : 0L);
            p = PutF64(b, p, id != null ? id.TickSize : 0.0);
            p = PutF64(b, p, id != null ? id.PointValue : 0.0);
            p = PutI64(b, p, id != null ? id.RolledAtUtcTicks : 0L);
            p = PutU16(b, p, id != null ? id.RollCount : (ushort)0);
            return p;
        }

        // Frame type 2, eventKind 1: the roll boundary for one instrument index. Sent right
        // after the re-announced hello, before any snapshot of the new contract.
        private void WriteContractRolled(NamedPipeServerStream server, RollRecord record)
        {
            int p = 4 + HeaderBytes;
            p = PutU16(_frameBuffer, p, EventContractRolled);
            p = PutU16(_frameBuffer, p, 0);                                  // reserved
            p = PutI64(_frameBuffer, p, record.Next.RolledAtUtcTicks);
            p = PutIdentity(_frameBuffer, p, record.Previous);
            p = PutIdentity(_frameBuffer, p, record.Next);
            EmitFrame(server, FrameTypeEvent, (ushort)record.Index, p);
        }

        private void WriteHeartbeat(NamedPipeServerStream server)
        {
            EmitFrame(server, FrameTypeHeartbeat, InstrumentNone, 4 + HeaderBytes);
        }

        // Snapshot payload, schema/wire-v1.md "type 1". Step-1 fields first, step-2
        // instrumentation appended after +24. The serialize timer covers everything from here to
        // the moment the bytes are handed to the pipe, and is recorded into _serializeHist by
        // EmitFrame; the pipe write itself is outside the measurement.
        private void WriteSnapshot(NamedPipeServerStream server, InstrumentFeed feed)
        {
            long t0 = Stopwatch.GetTimestamp();

            long allocNow = AllocationProbe.Read();
            long delta = allocNow - _publisherAllocBaseline;
            if (delta < 0)
                delta = 0;
            Interlocked.Exchange(ref _allocDelta, delta);

            int i = feed.Index;
            LatencySummary data = _dataSummary[i];
            LatencySummary depth = _depthSummary[i];
            LatencySummary ser = _serializeSummary;

            int p = 4 + HeaderBytes;
            // ----- step 1 -----
            p = PutU64(_frameBuffer, p, (ulong)Interlocked.Read(ref _eventsDrained));
            p = PutU64(_frameBuffer, p, (ulong)delta);
            p = PutU64(_frameBuffer, p, (ulong)feed.SampleCount);
            // ----- step 2 (additive) -----
            p = PutNs32(_frameBuffer, p, data.P50Ns);                       // +24
            p = PutNs32(_frameBuffer, p, data.P99Ns);                       // +28
            p = PutNs32(_frameBuffer, p, data.P999Ns);                      // +32
            p = PutNs32(_frameBuffer, p, data.MaxNs);                       // +36
            p = PutU64(_frameBuffer, p, (ulong)data.Count);                 // +40
            p = PutNs32(_frameBuffer, p, depth.P50Ns);                      // +48
            p = PutNs32(_frameBuffer, p, depth.P99Ns);                      // +52
            p = PutNs32(_frameBuffer, p, depth.P999Ns);                     // +56
            p = PutNs32(_frameBuffer, p, depth.MaxNs);                      // +60
            p = PutU64(_frameBuffer, p, (ulong)depth.Count);                // +64
            p = PutI64(_frameBuffer, p, data.AllocBytesPer1024);            // +72
            p = PutI64(_frameBuffer, p, data.AllocBytesTotal);              // +80
            p = PutI64(_frameBuffer, p, depth.AllocBytesPer1024);           // +88
            p = PutI64(_frameBuffer, p, depth.AllocBytesTotal);             // +96
            p = PutI64(_frameBuffer, p, Interlocked.Read(ref _publisherAllocTotal)); // +104
            p = PutNs32(_frameBuffer, p, ser.P50Ns);                        // +112
            p = PutNs32(_frameBuffer, p, ser.P99Ns);                        // +116
            p = PutNs32(_frameBuffer, p, ser.P999Ns);                       // +120
            p = PutNs32(_frameBuffer, p, ser.MaxNs);                        // +124
            p = PutU64(_frameBuffer, p, (ulong)ser.Count);                  // +128
            p = PutU64(_frameBuffer, p, (ulong)Stopwatch.Frequency);        // +136
            p = PutU64(_frameBuffer, p, (ulong)(data.Drops + depth.Drops)); // +144
            p = PutU64(_frameBuffer, p, (ulong)(data.SampleOverruns + depth.SampleOverruns)); // +152
                                                                            // = 160 bytes

            EmitFrame(server, FrameTypeSnapshot, (ushort)feed.Index, p, t0);
        }

        // Writes the header in front of the payload already sitting in _frameBuffer and
        // pushes the whole frame down the pipe.
        private void EmitFrame(NamedPipeServerStream server, ushort type, ushort instrument, int endOffset)
        {
            EmitFrame(server, type, instrument, endOffset, -1L);
        }

        // serializeStart is a Stopwatch timestamp taken when payload serialization began, or -1
        // when this frame is not timed. The elapsed time up to (not including) the pipe write is
        // recorded into the serialize histogram.
        private void EmitFrame(NamedPipeServerStream server, ushort type, ushort instrument, int endOffset, long serializeStart)
        {
            int payloadEnd = endOffset;
            int lengthValue = payloadEnd - 4;           // everything after the u32 length field
            if (lengthValue > MaxFrameBytes)
                throw new InvalidOperationException("frame exceeds maxFrameBytes");

            int p = 0;
            p = PutU32(_frameBuffer, p, (uint)lengthValue);
            p = PutU16(_frameBuffer, p, type);
            p = PutU16(_frameBuffer, p, SchemaVersion);
            p = PutU32(_frameBuffer, p, _sequence);
            p = PutU32(_frameBuffer, p, TakePendingDropped());
            p = PutI64(_frameBuffer, p, Stopwatch.GetTimestamp());
            p = PutI64(_frameBuffer, p, DateTime.UtcNow.Ticks);
            p = PutU16(_frameBuffer, p, instrument);
            p = PutU16(_frameBuffer, p, 0);             // reserved

            unchecked { _sequence++; }

            if (serializeStart >= 0)
                _serializeHist.Record(Stopwatch.GetTimestamp() - serializeStart);

            // No Flush. On a named pipe Stream.Flush is FlushFileBuffers, which blocks until the
            // client has drained the buffer; a slow reader would stall this thread and with it
            // the ring drain. Write already hands the bytes to the kernel.
            server.Write(_frameBuffer, 0, payloadEnd);
            Interlocked.Increment(ref _framesSent);
        }

        // ------------------------------------------------------------------
        // Little-endian primitive stores.
        // ------------------------------------------------------------------
        private static int PutU16(byte[] b, int p, ushort v)
        {
            b[p] = (byte)v;
            b[p + 1] = (byte)(v >> 8);
            return p + 2;
        }

        private static int PutU32(byte[] b, int p, uint v)
        {
            b[p] = (byte)v;
            b[p + 1] = (byte)(v >> 8);
            b[p + 2] = (byte)(v >> 16);
            b[p + 3] = (byte)(v >> 24);
            return p + 4;
        }

        private static int PutU64(byte[] b, int p, ulong v)
        {
            b[p] = (byte)v;
            b[p + 1] = (byte)(v >> 8);
            b[p + 2] = (byte)(v >> 16);
            b[p + 3] = (byte)(v >> 24);
            b[p + 4] = (byte)(v >> 32);
            b[p + 5] = (byte)(v >> 40);
            b[p + 6] = (byte)(v >> 48);
            b[p + 7] = (byte)(v >> 56);
            return p + 8;
        }

        private static int PutI64(byte[] b, int p, long v)
        {
            return PutU64(b, p, (ulong)v);
        }

        // Nanoseconds as u32. 0xFFFFFFFF is reserved for "unavailable" (schema/wire-v1.md): the
        // summary carries a negative value when its histogram is empty, and that is what goes
        // out, never 0 ns. Measured values saturate one below the sentinel, at 4294967294 ns
        // (about 4.29 s); the histogram tops out at 1 s, so only an exact max can get there.
        public const uint NsUnavailable = 0xFFFFFFFF;
        public const uint NsSaturated = 0xFFFFFFFE;

        private static int PutNs32(byte[] b, int p, long ns)
        {
            if (ns < 0)
                return PutU32(b, p, NsUnavailable);
            if (ns > NsSaturated)
                ns = NsSaturated;
            return PutU32(b, p, (uint)ns);
        }

        private static int PutF64(byte[] b, int p, double v)
        {
            return PutU64(b, p, (ulong)BitConverter.DoubleToInt64Bits(v));
        }

        private static int PutAsciiWithU8Length(byte[] b, int p, string s)
        {
            int n = s == null ? 0 : s.Length;
            if (n > 255)
                n = 255;
            b[p] = (byte)n;
            p++;
            for (int i = 0; i < n; i++)
            {
                char c = s[i];
                b[p + i] = c < 128 ? (byte)c : (byte)'?';
            }
            return p + n;
        }
    }
}
