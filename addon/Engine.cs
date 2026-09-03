// Obsidian Flow MCP - AddOn
// Owns config, the per-instrument feeds and the publisher thread. Start/Stop is idempotent.
// Step 2.5: instruments are resolved through InstrumentResolver (any asset class, three
// accepted config shapes); entries that do not resolve are kept as a list with a reason and
// shown in the status window and the hello frame, never thrown.
// .NET Framework 4.8. ASCII only.

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public sealed class Engine : IDisposable
    {
        private static readonly object StaticGate = new object();
        private static Engine _instance;

        private readonly object _gate = new object();
        private readonly List<InstrumentFeed> _feeds = new List<InstrumentFeed>();
        private readonly List<UnresolvedInstrument> _unresolved = new List<UnresolvedInstrument>();
        private readonly List<string> _startupMessages = new List<string>();

        private Config _config;
        private Publisher _publisher;
        private bool _running;

        private Engine()
        {
        }

        // One engine per NinjaTrader process. The AddOn may be constructed more than once
        // (NinjaScript instantiates AddOnBase types freely); only the first start does work.
        public static Engine Instance
        {
            get
            {
                lock (StaticGate)
                {
                    if (_instance == null)
                        _instance = new Engine();
                    return _instance;
                }
            }
        }

        public bool IsRunning { get { lock (_gate) { return _running; } } }
        public Publisher Publisher { get { lock (_gate) { return _publisher; } } }
        public Config Config { get { lock (_gate) { return _config; } } }

        public string[] StartupMessages
        {
            get { lock (_gate) { return _startupMessages.ToArray(); } }
        }

        // Config entries that produced no subscription, with the reason. Fixed at start.
        public UnresolvedInstrument[] Unresolved
        {
            get { lock (_gate) { return _unresolved.ToArray(); } }
        }

        public void Start()
        {
            lock (_gate)
            {
                if (_running)
                    return;

                _startupMessages.Clear();
                _unresolved.Clear();

                string loadError;
                string path = Config.DefaultPath();
                _config = Config.Load(path, out loadError);
                if (loadError != null)
                    _startupMessages.Add("config: " + loadError);
                else
                    _startupMessages.Add("config: " + path);

                // AllocationProbe resolves GC.GetAllocatedBytesForCurrentThread by reflection in
                // its static initializer. Left to lazy initialization, the first Read() would run
                // that initializer (reflection, CreateDelegate, the type-init lock) on the NT data
                // thread inside a handler. Force it here, on this thread, before any handler exists.
                RuntimeHelpers.RunClassConstructor(typeof(AllocationProbe).TypeHandle);
                RuntimeHelpers.RunClassConstructor(typeof(LatencyHistogram).TypeHandle);

                DateTime now = DateTime.Now;
                int index = 0;
                for (int i = 0; i < _config.Instruments.Count; i++)
                {
                    string typed = _config.Instruments[i];
                    if (string.IsNullOrEmpty(typed))
                        continue;

                    string error;
                    InstrumentIdentity identity = InstrumentResolver.Resolve(typed, now, out error);
                    if (identity == null)
                    {
                        _unresolved.Add(new UnresolvedInstrument(typed, error));
                        _startupMessages.Add("unresolved: " + typed + ": " + error);
                        continue;
                    }

                    InstrumentFeed feed = new InstrumentFeed(identity, index, _config.RingCapacity);
                    if (feed.Subscribe(out error))
                    {
                        _feeds.Add(feed);
                        index++;
                        _startupMessages.Add("resolved: " + typed + " -> " + identity.FullName
                            + " (" + identity.InstrumentType + ", " + DescribeShape(identity.Shape) + ")");
                    }
                    else
                    {
                        _unresolved.Add(new UnresolvedInstrument(typed, "subscribe failed: " + error));
                        _startupMessages.Add("subscribe failed: " + typed + ": " + error);
                        feed.Dispose();
                    }
                }

                _publisher = new Publisher(_config, _feeds, _unresolved);
                _publisher.Start();
                _running = true;
            }
        }

        public static string DescribeShape(InstrumentShape shape)
        {
            switch (shape)
            {
                case InstrumentShape.FullyQualified: return "fully qualified, never re-resolved";
                case InstrumentShape.Root: return "root, front contract, re-checked for rolls";
                case InstrumentShape.Direct: return "direct, never re-resolved";
                default: return "unknown shape";
            }
        }

        public void Stop()
        {
            lock (_gate)
            {
                if (!_running)
                    return;

                _running = false;

                // The publisher may have swapped feeds in for rolled contracts, so the live set
                // is its array, not the list handed to it at start. Stop the publisher first
                // (it joins its thread), then take its final array and dispose every feed.
                InstrumentFeed[] live = null;
                if (_publisher != null)
                {
                    try { live = _publisher.FeedsSnapshot(); } catch (Exception) { }
                    try { _publisher.Dispose(); } catch (Exception) { }
                    try { live = _publisher.FeedsSnapshot(); } catch (Exception) { }
                    _publisher = null;
                }

                if (live == null)
                    live = _feeds.ToArray();

                for (int i = 0; i < live.Length; i++)
                {
                    try { if (live[i] != null) live[i].Dispose(); } catch (Exception) { }
                }
                for (int i = 0; i < _feeds.Count; i++)
                {
                    try { _feeds[i].Dispose(); } catch (Exception) { }
                }
                _feeds.Clear();
            }
        }

        // The live feeds. After a roll the publisher's array holds the new feed at the same
        // index; the start-up list is only the initial set.
        public InstrumentFeed[] Feeds
        {
            get
            {
                lock (_gate)
                {
                    if (_publisher != null)
                        return _publisher.FeedsSnapshot();
                    return _feeds.ToArray();
                }
            }
        }

        public void Dispose()
        {
            Stop();
        }
    }
}
