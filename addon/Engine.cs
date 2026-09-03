// ObsidianFlow Order-Flow MCP - AddOn
// Owns config, the per-instrument feeds and the publisher thread. Start/Stop is idempotent.
// .NET Framework 4.8. ASCII only.

using System;
using System.Collections.Generic;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public sealed class Engine : IDisposable
    {
        private static readonly object StaticGate = new object();
        private static Engine _instance;

        private readonly object _gate = new object();
        private readonly List<InstrumentFeed> _feeds = new List<InstrumentFeed>();
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

        public void Start()
        {
            lock (_gate)
            {
                if (_running)
                    return;

                _startupMessages.Clear();

                string loadError;
                string path = Config.DefaultPath();
                _config = Config.Load(path, out loadError);
                if (loadError != null)
                    _startupMessages.Add("config: " + loadError);
                else
                    _startupMessages.Add("config: " + path);

                int index = 0;
                for (int i = 0; i < _config.Instruments.Count; i++)
                {
                    string name = _config.Instruments[i];
                    if (string.IsNullOrEmpty(name))
                        continue;

                    InstrumentFeed feed = new InstrumentFeed(name, index, _config.RingCapacity);
                    string error;
                    if (feed.Subscribe(out error))
                    {
                        _feeds.Add(feed);
                        index++;
                    }
                    else
                    {
                        _startupMessages.Add("subscribe failed: " + name + ": " + error);
                        feed.Dispose();
                    }
                }

                _publisher = new Publisher(_config, _feeds);
                _publisher.Start();
                _running = true;
            }
        }

        public void Stop()
        {
            lock (_gate)
            {
                if (!_running)
                    return;

                _running = false;

                if (_publisher != null)
                {
                    try { _publisher.Dispose(); } catch (Exception) { }
                    _publisher = null;
                }

                for (int i = 0; i < _feeds.Count; i++)
                {
                    try { _feeds[i].Dispose(); } catch (Exception) { }
                }
                _feeds.Clear();
            }
        }

        public InstrumentFeed[] Feeds
        {
            get { lock (_gate) { return _feeds.ToArray(); } }
        }

        public void Dispose()
        {
            Stop();
        }
    }
}
