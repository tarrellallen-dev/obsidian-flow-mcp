// Obsidian Flow MCP - AddOn
// Minimal status window. Built in code, no XAML, so the whole AddOn is a flat set of .cs files
// that can be copied into bin\Custom\AddOns.
// Spec section 3.1: anything touching WPF runs on the UI thread and never blocks the data or
// publisher threads. This window only reads counters; it never calls into them.
// .NET Framework 4.8. ASCII only.

using System;
using System.Globalization;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    // Base type is fully qualified with global:: so it cannot be resolved relative to this
    // file's own namespace, which also begins with "NinjaTrader".
    public class StatusWindow : NTWindow
    {
        private readonly TextBlock _pipeName;
        private readonly TextBlock _connection;
        private readonly TextBlock _instruments;
        private readonly TextBlock _identities;
        private readonly TextBlock _rolls;
        private readonly TextBlock _eventsDrained;
        private readonly TextBlock _drops;
        private readonly TextBlock _framesSent;
        private readonly TextBlock _allocDelta;
        private readonly TextBlock _dataThreadAlloc;
        private readonly TextBlock _handlerSamples;
        private readonly TextBlock _handlers;
        private readonly TextBlock _serialize;
        private readonly TextBlock _dump;
        private readonly TextBlock _messages;
        private readonly TextBlock _diagnosis;

        private readonly DispatcherTimer _timer;

        public StatusWindow()
        {
            Caption = "Obsidian Flow MCP";
            Width = 760;
            Height = 600;

            Grid grid = new Grid();
            grid.Margin = new Thickness(12);
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(160) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            int row = 0;
            _pipeName = AddRow(grid, ref row, "Pipe");
            _connection = AddRow(grid, ref row, "Connection");
            _instruments = AddRow(grid, ref row, "Instruments");
            _identities = AddRow(grid, ref row, "Resolved as");
            _identities.TextWrapping = TextWrapping.Wrap;
            _identities.FontFamily = new System.Windows.Media.FontFamily("Consolas");
            _rolls = AddRow(grid, ref row, "Contract rolls");
            _rolls.TextWrapping = TextWrapping.Wrap;
            _eventsDrained = AddRow(grid, ref row, "Events drained");
            _diagnosis = AddRow(grid, ref row, "Why zero");
            _diagnosis.TextWrapping = TextWrapping.Wrap;
            _drops = AddRow(grid, ref row, "Drops");
            _framesSent = AddRow(grid, ref row, "Frames sent");
            _allocDelta = AddRow(grid, ref row, "Publisher alloc delta");
            _dataThreadAlloc = AddRow(grid, ref row, "Data thread alloc (thread-wide)");
            _dataThreadAlloc.TextWrapping = TextWrapping.Wrap;
            _handlerSamples = AddRow(grid, ref row, "Handler samples");
            _handlers = AddRow(grid, ref row, "Handlers (us)");
            _handlers.TextWrapping = TextWrapping.Wrap;
            _handlers.FontFamily = new System.Windows.Media.FontFamily("Consolas");
            _serialize = AddRow(grid, ref row, "Publisher serialize");
            _dump = AddRow(grid, ref row, "CSV dump");
            _messages = AddRow(grid, ref row, "Startup");
            _messages.TextWrapping = TextWrapping.Wrap;

            Content = grid;

            // this.Dispatcher: the window's own dispatcher (the NT8 UI thread), not the
            // System.Windows.Threading.Dispatcher type that the using directive brings into scope.
            _timer = new DispatcherTimer(DispatcherPriority.Background, this.Dispatcher);
            _timer.Interval = TimeSpan.FromMilliseconds(500);   // 2 Hz
            _timer.Tick += OnTick;
            _timer.Start();

            Closed += OnClosed;

            Refresh();
        }

        private static TextBlock AddRow(Grid grid, ref int row, string label)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            TextBlock left = new TextBlock();
            left.Text = label;
            left.Margin = new Thickness(0, 2, 8, 2);
            Grid.SetRow(left, row);
            Grid.SetColumn(left, 0);
            grid.Children.Add(left);

            TextBlock right = new TextBlock();
            right.Text = "-";
            right.Margin = new Thickness(0, 2, 0, 2);
            Grid.SetRow(right, row);
            Grid.SetColumn(right, 1);
            grid.Children.Add(right);

            row++;
            return right;
        }

        private void OnTick(object sender, EventArgs e)
        {
            Refresh();
        }

        private void Refresh()
        {
            try
            {
                Engine engine = Engine.Instance;
                Publisher publisher = engine.Publisher;
                InstrumentFeed[] feeds = engine.Feeds;
                UnresolvedInstrument[] unresolved = engine.Unresolved;

                _instruments.Text = feeds.Length.ToString() + " subscribed"
                    + (unresolved.Length > 0 ? ", " + unresolved.Length.ToString() + " unresolved" : "");
                _identities.Text = DescribeIdentities(feeds, unresolved);

                if (!AllocationProbe.IsAvailable)
                {
                    _dataThreadAlloc.Text = AllocationProbe.UnavailableLabel + " on this runtime";
                }
                else
                {
                    // GC.GetAllocatedBytesForCurrentThread is thread-wide. Several feeds whose
                    // handlers NT raises on one thread read the same counter, so the figure is
                    // listed once per distinct ManagedThreadId, not once per feed, and it
                    // includes everything NT itself allocates on that thread.
                    _dataThreadAlloc.Text = DescribeThreadAllocations(feeds);
                }

                if (publisher == null)
                {
                    _pipeName.Text = "-";
                    _connection.Text = engine.IsRunning ? "starting" : "stopped";
                    _eventsDrained.Text = "-";
                    _diagnosis.Text = "-";
                    _drops.Text = "-";
                    _framesSent.Text = "-";
                    _allocDelta.Text = "-";
                    _handlerSamples.Text = "-";
                    _handlers.Text = "-";
                    _serialize.Text = "-";
                    _dump.Text = "-";
                    _rolls.Text = "-";
                }
                else
                {
                    _pipeName.Text = "\\\\.\\pipe\\" + publisher.PipeName;

                    string state = publisher.IsConnected ? "connected" : "waiting for client";
                    string lastError = publisher.LastError;
                    if (!string.IsNullOrEmpty(lastError))
                        state = state + " (last error: " + lastError + ")";
                    _connection.Text = state;

                    _eventsDrained.Text = publisher.EventsDrained.ToString();
                    _diagnosis.Text = Diagnose(publisher.EventsDrained, feeds, unresolved);
                    _drops.Text = publisher.DroppedTotal.ToString();
                    _framesSent.Text = publisher.FramesSent.ToString();
                    _allocDelta.Text = AllocationProbe.IsAvailable
                        ? publisher.AllocDelta.ToString() + " bytes"
                        : "unavailable on this runtime";
                    _handlerSamples.Text = publisher.HandlerSamples.ToString();

                    // Per instrument, per handler: p50/p99/p99.9 in microseconds, bytes allocated
                    // over the last 1024 events, ring drops. Every figure is a plain volatile
                    // read of a field the publisher thread wrote at most one second ago.
                    StringBuilder sb = new StringBuilder(256);
                    int n = publisher.FeedCount;
                    for (int i = 0; i < n; i++)
                    {
                        if (i > 0)
                            sb.Append(Environment.NewLine);
                        sb.Append(publisher.FeedName(i));
                        sb.Append(Environment.NewLine).Append("  data  ");
                        AppendSummary(sb, publisher.DataSummary(i));
                        sb.Append(Environment.NewLine).Append("  depth ");
                        AppendSummary(sb, publisher.DepthSummary(i));
                    }
                    _handlers.Text = n == 0 ? "-" : sb.ToString();

                    LatencySummary ser = publisher.SerializeSummary;
                    _serialize.Text = "p99 " + FormatUs(ser.P99Ns) + " us  (p50 " + FormatUs(ser.P50Ns)
                        + " us, max " + FormatUs(ser.MaxNs) + " us, n=" + ser.Count.ToString() + ")";

                    long rolls = publisher.RollsTotal;
                    string lastRoll = publisher.LastRoll;
                    _rolls.Text = rolls == 0
                        ? "none (root entries re-checked once a minute and at session boundaries)"
                        : rolls.ToString() + "; last: " + (lastRoll ?? "-");

                    string dumpPath = publisher.DumpPath;
                    if (string.IsNullOrEmpty(dumpPath))
                        _dump.Text = "off (set dumpTo in the config file)";
                    else
                    {
                        string dumpError = publisher.DumpError;
                        _dump.Text = string.IsNullOrEmpty(dumpError)
                            ? dumpPath + " (every 10 s)"
                            : dumpPath + " (stopped: " + dumpError + ")";
                    }
                }

                string[] messages = engine.StartupMessages;
                _messages.Text = messages.Length == 0 ? "-" : string.Join(Environment.NewLine, messages);
            }
            catch (Exception ex)
            {
                _connection.Text = "status error: " + ex.Message;
            }
        }

        // "p50/p99/p99.9 12.3/45.6/78.9 us  alloc/1024 0 B  drops 0  n=123456"
        private static void AppendSummary(StringBuilder sb, LatencySummary sm)
        {
            sb.Append("p50/p99/p99.9 ");
            sb.Append(FormatUs(sm.P50Ns)).Append('/');
            sb.Append(FormatUs(sm.P99Ns)).Append('/');
            sb.Append(FormatUs(sm.P999Ns)).Append(" us");
            sb.Append("  alloc/1024 ");
            long alloc = sm.AllocBytesPer1024;
            if (alloc < 0)
                sb.Append(AllocationProbe.UnavailableLabel);
            else
                sb.Append(alloc.ToString()).Append(" B");
            sb.Append("  drops ").Append(sm.Drops.ToString());
            sb.Append("  n=").Append(sm.Count.ToString());
            if (sm.SampleOverruns > 0)
                sb.Append("  overrun ").Append(sm.SampleOverruns.ToString());
        }

        // "--" for a negative value: the histogram is empty and there is no figure.
        private static string FormatUs(long ns)
        {
            if (ns < 0)
                return "--";
            return (ns / 1000.0).ToString("0.0", CultureInfo.InvariantCulture);
        }

        // One line per config entry: what was typed, what it resolved to, type, exchange, expiry
        // and shape; then one line per entry that did not resolve, with the reason. Identity
        // records are immutable and the feed array is a snapshot, so this is all plain reads.
        private static string DescribeIdentities(InstrumentFeed[] feeds, UnresolvedInstrument[] unresolved)
        {
            StringBuilder sb = new StringBuilder(256);
            DateTime now = DateTime.Now;
            for (int i = 0; i < feeds.Length; i++)
            {
                InstrumentIdentity id = feeds[i].Identity;
                if (sb.Length > 0)
                    sb.Append(Environment.NewLine);
                if (id == null)
                {
                    sb.Append(feeds[i].InstrumentName).Append(": no identity");
                    continue;
                }
                sb.Append(id.ResolvedFrom).Append(" -> ").Append(id.FullName);
                sb.Append("  [").Append(id.InstrumentType);
                if (id.Exchange.Length > 0)
                    sb.Append(", ").Append(id.Exchange);
                if (id.Currency.Length > 0)
                    sb.Append(", ").Append(id.Currency);
                sb.Append("]  expiry ").Append(id.ExpiryText());
                if (id.IsExpiredAt(now))
                    sb.Append(" (EXPIRED)");
                sb.Append("  ").Append(ShapeLabel(id.Shape));
                if (id.RollCount > 0)
                    sb.Append("  rolled x").Append(id.RollCount.ToString());
            }
            for (int i = 0; i < unresolved.Length; i++)
            {
                if (sb.Length > 0)
                    sb.Append(Environment.NewLine);
                sb.Append(unresolved[i].Typed).Append(" -> UNRESOLVED: ").Append(unresolved[i].Reason);
            }
            return sb.Length == 0 ? "-" : sb.ToString();
        }

        // A row that stays quiet while data flows and says something useful when it does not.
        // Zero events with a green connection is the state this AddOn is most likely to be found
        // in by someone who has just installed it, and the reason is nearly always in the config
        // rather than in the code: an expired contract month, or a name that resolved to a
        // different instrument than the one meant. Both were already on screen - the expiry date
        // sat mid-line in "Resolved as" - and both were still missed, so the reason gets its own
        // row and says what to do about it.
        private static string Diagnose(long eventsDrained, InstrumentFeed[] feeds, UnresolvedInstrument[] unresolved)
        {
            if (eventsDrained > 0)
                return "-";

            if (feeds.Length == 0)
            {
                if (unresolved.Length > 0)
                    return "Nothing is subscribed: every instrument in the config was unresolved. See \"Resolved as\".";
                return "Nothing is subscribed: the config lists no instruments.";
            }

            DateTime now = DateTime.Now;
            StringBuilder sb = new StringBuilder(192);
            for (int i = 0; i < feeds.Length; i++)
            {
                InstrumentIdentity id = feeds[i].Identity;
                if (id == null || !id.IsExpiredAt(now))
                    continue;
                if (sb.Length > 0)
                    sb.Append(Environment.NewLine);
                sb.Append(id.FullName).Append(" expired on ").Append(id.ExpiryText())
                  .Append(". An expired contract never receives data, live or delayed. Put \"")
                  .Append(id.MasterName)
                  .Append(":Future\" in the config to follow the front contract, then reopen this window.");
            }
            if (sb.Length > 0)
                return sb.ToString();

            return "No market data has arrived yet. Check that a feed is connected (Control Center > Connections),"
                 + " that the connection carries these instruments, and - outside session hours - that something is"
                 + " actually trading. Market Replay and Playback also count: press play.";
        }

        private static string ShapeLabel(InstrumentShape shape)
        {
            switch (shape)
            {
                case InstrumentShape.FullyQualified: return "as typed (contract month given)";
                case InstrumentShape.Root: return "root -> front contract";
                case InstrumentShape.Direct: return "direct";
                default: return "?";
            }
        }

        // One entry per distinct handler thread: "thread 12: 4096 B (<instrument> data, <instrument> data)".
        // Feeds whose probe has not run yet are listed as "no probe yet". At most a handful of
        // threads exist, so the nested scan is fine at 2 Hz on the UI thread.
        private static string DescribeThreadAllocations(InstrumentFeed[] feeds)
        {
            StringBuilder sb = new StringBuilder(128);
            int[] seen = new int[feeds.Length * 2];
            int seenCount = 0;
            int pending = 0;

            for (int i = 0; i < feeds.Length; i++)
            {
                for (int k = 0; k < 2; k++)
                {
                    int tid = k == 0 ? feeds[i].DataAllocThreadId : feeds[i].DepthAllocThreadId;
                    long total = k == 0 ? feeds[i].DataThreadAllocDelta : feeds[i].DepthThreadAllocDelta;
                    if (tid < 0 || total < 0)
                    {
                        pending++;
                        continue;
                    }

                    bool dup = false;
                    for (int j = 0; j < seenCount; j++)
                    {
                        if (seen[j] == tid) { dup = true; break; }
                    }
                    if (dup)
                        continue;
                    seen[seenCount++] = tid;

                    if (sb.Length > 0)
                        sb.Append(Environment.NewLine);
                    sb.Append("thread ").Append(tid.ToString()).Append(": ").Append(total.ToString()).Append(" B (");
                    bool first = true;
                    for (int m = 0; m < feeds.Length; m++)
                    {
                        if (feeds[m].DataAllocThreadId == tid)
                        {
                            if (!first) sb.Append(", ");
                            sb.Append(feeds[m].InstrumentName).Append(" data");
                            first = false;
                        }
                        if (feeds[m].DepthAllocThreadId == tid)
                        {
                            if (!first) sb.Append(", ");
                            sb.Append(feeds[m].InstrumentName).Append(" depth");
                            first = false;
                        }
                    }
                    sb.Append(")");
                }
            }

            if (sb.Length == 0)
                return "no probe yet (first probe runs on the first event)";
            if (pending > 0)
                sb.Append(Environment.NewLine).Append(pending.ToString()).Append(" handler(s) not probed yet");
            sb.Append(Environment.NewLine).Append("thread-wide counter, includes NinjaTrader's own allocations on that thread; sampled every ")
              .Append(InstrumentFeed.AllocSampleInterval.ToString()).Append(" events");
            return sb.ToString();
        }

        private void OnClosed(object sender, EventArgs e)
        {
            _timer.Stop();
            _timer.Tick -= OnTick;
            Closed -= OnClosed;
        }
    }
}
