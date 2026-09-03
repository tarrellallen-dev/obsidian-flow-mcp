// ObsidianFlow Order-Flow MCP - AddOn
// Minimal status window. Built in code, no XAML, so the whole AddOn is a flat set of .cs files
// that can be copied into bin\Custom\AddOns.
// Spec section 3.1: anything touching WPF runs on the UI thread and never blocks the data or
// publisher threads. This window only reads counters; it never calls into them.
// .NET Framework 4.8. ASCII only.

using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using NinjaTrader.Gui;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public class StatusWindow : NTWindow
    {
        private readonly TextBlock _pipeName;
        private readonly TextBlock _connection;
        private readonly TextBlock _instruments;
        private readonly TextBlock _eventsDrained;
        private readonly TextBlock _drops;
        private readonly TextBlock _framesSent;
        private readonly TextBlock _allocDelta;
        private readonly TextBlock _dataThreadAlloc;
        private readonly TextBlock _handlerSamples;
        private readonly TextBlock _messages;

        private readonly DispatcherTimer _timer;

        public StatusWindow()
        {
            Caption = "Order-Flow MCP";
            Width = 460;
            Height = 320;

            Grid grid = new Grid();
            grid.Margin = new Thickness(12);
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(160) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            int row = 0;
            _pipeName = AddRow(grid, ref row, "Pipe");
            _connection = AddRow(grid, ref row, "Connection");
            _instruments = AddRow(grid, ref row, "Instruments");
            _eventsDrained = AddRow(grid, ref row, "Events drained");
            _drops = AddRow(grid, ref row, "Drops");
            _framesSent = AddRow(grid, ref row, "Frames sent");
            _allocDelta = AddRow(grid, ref row, "Publisher alloc delta");
            _dataThreadAlloc = AddRow(grid, ref row, "Data-thread alloc delta");
            _handlerSamples = AddRow(grid, ref row, "Handler samples");
            _messages = AddRow(grid, ref row, "Startup");
            _messages.TextWrapping = TextWrapping.Wrap;

            Content = grid;

            _timer = new DispatcherTimer(DispatcherPriority.Background, Dispatcher);
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

                _instruments.Text = feeds.Length.ToString();

                if (!AllocationProbe.IsAvailable)
                {
                    _dataThreadAlloc.Text = "unavailable on this runtime";
                }
                else
                {
                    long dataThreadBytes = 0;
                    for (int i = 0; i < feeds.Length; i++)
                        dataThreadBytes += feeds[i].DataThreadAllocDelta + feeds[i].DepthThreadAllocDelta;
                    _dataThreadAlloc.Text = dataThreadBytes.ToString() + " bytes (sampled every "
                        + InstrumentFeed.AllocSampleInterval.ToString() + " events)";
                }

                if (publisher == null)
                {
                    _pipeName.Text = "-";
                    _connection.Text = engine.IsRunning ? "starting" : "stopped";
                    _eventsDrained.Text = "-";
                    _drops.Text = "-";
                    _framesSent.Text = "-";
                    _allocDelta.Text = "-";
                    _handlerSamples.Text = "-";
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
                    _drops.Text = publisher.DroppedTotal.ToString();
                    _framesSent.Text = publisher.FramesSent.ToString();
                    _allocDelta.Text = AllocationProbe.IsAvailable
                        ? publisher.AllocDelta.ToString() + " bytes"
                        : "unavailable on this runtime";
                    _handlerSamples.Text = publisher.HandlerSamples.ToString();
                }

                string[] messages = engine.StartupMessages;
                _messages.Text = messages.Length == 0 ? "-" : string.Join(Environment.NewLine, messages);
            }
            catch (Exception ex)
            {
                _connection.Text = "status error: " + ex.Message;
            }
        }

        private void OnClosed(object sender, EventArgs e)
        {
            _timer.Stop();
            _timer.Tick -= OnTick;
            Closed -= OnClosed;
        }
    }
}
