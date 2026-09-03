// ObsidianFlow Order-Flow MCP - AddOn
// Spec sections 3.1 and 3.3: one publisher thread, named pipe server, length-prefixed frames.
// Step 1 computes nothing. It drains the rings, discards the contents, counts, and publishes
// transport-level counters so the threading contract can be proved.
// .NET Framework 4.8. ASCII only.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO.Pipes;
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

        private const int HeartbeatMs = 1000;

        // How long the accept wait blocks before coming back to drain the rings.
        private const int AcceptPollMs = 10;

        private readonly Config _config;
        private readonly List<InstrumentFeed> _feeds;

        private readonly byte[] _frameBuffer;       // preallocated; reused for every frame
        private readonly Thread _thread;

        // Stop is a plain volatile flag. The event exists only to wake a blocked wait, and it is
        // never disposed while the publisher thread might still touch it (see Dispose).
        private volatile bool _stopRequested;
        private readonly ManualResetEvent _wake = new ManualResetEvent(false);
        private int _wakeClosed;

        private uint _sequence;
        private long _publisherAllocBaseline;

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

        public Publisher(Config config, List<InstrumentFeed> feeds)
        {
            _config = config;
            _feeds = feeds;
            _frameBuffer = new byte[MaxFrameBytes];
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
                for (int i = 0; i < 25 && !_stopRequested; i++)
                {
                    DrainAll();
                    Thread.Sleep(10);
                }
            }

            // Final drain so the rings are empty at shutdown.
            try { DrainAll(); } catch (Exception) { }
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
            WriteHello(server);

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

                now = Stopwatch.GetTimestamp();

                if (now >= nextSnapshot)
                {
                    for (int i = 0; i < _feeds.Count; i++)
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

        // Step 1 discards ring contents; only counts matter. Drops read out of the rings are held
        // in _pendingDropped until a frame header carries them.
        private int DrainAll()
        {
            int total = 0;
            long dropped = 0;
            long samples = 0;

            for (int i = 0; i < _feeds.Count; i++)
            {
                InstrumentFeed f = _feeds[i];
                total += f.DataRing.Drain(null);
                total += f.DepthRing.Drain(null);
                dropped += f.DataRing.ExchangeDropped();
                dropped += f.DepthRing.ExchangeDropped();
                samples += f.SampleCount;
            }

            if (total != 0)
                Interlocked.Add(ref _eventsDrained, total);
            if (dropped != 0)
            {
                _pendingDropped += dropped;
                Interlocked.Add(ref _droppedTotal, dropped);
            }
            Interlocked.Exchange(ref _handlerSamples, samples);

            return total;
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

            p = PutU16(_frameBuffer, p, (ushort)_feeds.Count);
            for (int i = 0; i < _feeds.Count; i++)
            {
                InstrumentFeed f = _feeds[i];
                p = PutU16(_frameBuffer, p, (ushort)f.Index);
                p = PutAsciiWithU8Length(_frameBuffer, p, f.InstrumentName);
                p = PutF64(_frameBuffer, p, f.TickSize);
                p = PutF64(_frameBuffer, p, f.PointValue);
            }

            EmitFrame(server, FrameTypeHello, InstrumentNone, p);
        }

        private void WriteHeartbeat(NamedPipeServerStream server)
        {
            EmitFrame(server, FrameTypeHeartbeat, InstrumentNone, 4 + HeaderBytes);
        }

        private void WriteSnapshot(NamedPipeServerStream server, InstrumentFeed feed)
        {
            long allocNow = AllocationProbe.Read();
            long delta = allocNow - _publisherAllocBaseline;
            if (delta < 0)
                delta = 0;
            Interlocked.Exchange(ref _allocDelta, delta);

            int p = 4 + HeaderBytes;
            p = PutU64(_frameBuffer, p, (ulong)Interlocked.Read(ref _eventsDrained));
            p = PutU64(_frameBuffer, p, (ulong)delta);
            p = PutU64(_frameBuffer, p, (ulong)feed.SampleCount);

            EmitFrame(server, FrameTypeSnapshot, (ushort)feed.Index, p);
        }

        // Writes the header in front of the payload already sitting in _frameBuffer and
        // pushes the whole frame down the pipe.
        private void EmitFrame(NamedPipeServerStream server, ushort type, ushort instrument, int endOffset)
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
