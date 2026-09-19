// Obsidian Flow MCP - AddOn UI control lane.
// A separate, low-rate named pipe for PG-13 NinjaTrader UI assistance. It is deliberately
// kept away from the market-state publisher pipe so Strategy Analyzer inspection never adds
// backpressure to the data stream.
// .NET Framework 4.8. ASCII only.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using NinjaTrader.Gui.Tools;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public sealed class UiControlServer : IDisposable
    {
        private const int MaxTreeNodes = 350;
        private const int MaxDepthDefault = 6;
        private const int MaxCommandChars = 32768;

        private readonly string _pipeName;
        private readonly Thread _thread;
        private volatile bool _stopRequested;
        private int _disposed;
        private long _requests;
        private string _lastError;

        public UiControlServer(Config config)
        {
            _pipeName = (config != null && !string.IsNullOrEmpty(config.PipeName)
                ? config.PipeName
                : "obsidian-flow-mcp-v1") + "-control";
            _thread = new Thread(Run);
            _thread.IsBackground = true;
            _thread.Name = "ObsidianFlow.Mcp.UiControl";
        }

        public string PipeName { get { return _pipeName; } }
        public long Requests { get { return Interlocked.Read(ref _requests); } }
        public string LastError { get { return Volatile.Read(ref _lastError); } }

        public void Start()
        {
            _thread.Start();
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
                return;

            _stopRequested = true;
            PokePipe();
            try { _thread.Join(2000); } catch (Exception) { }
        }

        private void PokePipe()
        {
            try
            {
                using (NamedPipeClientStream poke = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut))
                {
                    poke.Connect(100);
                }
            }
            catch (Exception)
            {
            }
        }

        private void Run()
        {
            while (!_stopRequested)
            {
                NamedPipeServerStream pipe = null;
                try
                {
                    pipe = new NamedPipeServerStream(
                        _pipeName,
                        PipeDirection.InOut,
                        1,
                        PipeTransmissionMode.Byte,
                        PipeOptions.None);

                    pipe.WaitForConnection();
                    if (_stopRequested)
                        break;

                    using (StreamReader reader = new StreamReader(pipe, Encoding.UTF8, false, 4096))
                    using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096))
                    {
                        writer.NewLine = "\n";
                        writer.AutoFlush = true;

                        while (!_stopRequested && pipe.IsConnected)
                        {
                            string line = reader.ReadLine();
                            if (line == null)
                                break;
                            if (line.Length > MaxCommandChars)
                            {
                                writer.WriteLine(Error("request-too-large", "UI control request exceeded the PG-13 command size limit."));
                                continue;
                            }

                            Interlocked.Increment(ref _requests);
                            string reply;
                            try
                            {
                                reply = Execute(line);
                                Volatile.Write(ref _lastError, null);
                            }
                            catch (Exception ex)
                            {
                                Volatile.Write(ref _lastError, ex.Message);
                                reply = Error("exception", ex.Message);
                            }
                            writer.WriteLine(reply);
                        }
                    }
                }
                catch (Exception ex)
                {
                    if (!_stopRequested)
                        Volatile.Write(ref _lastError, ex.Message);
                }
                finally
                {
                    if (pipe != null)
                    {
                        try { pipe.Dispose(); } catch (Exception) { }
                    }
                }

                if (!_stopRequested)
                    Thread.Sleep(100);
            }
        }

        private string Execute(string json)
        {
            Dictionary<string, string> request = ParseFlatJson(json);
            string command = Get(request, "command");
            string id = Get(request, "id");

            if (string.IsNullOrEmpty(command))
                return Error("missing-command", "Missing UI control command.", id);

            switch (command)
            {
                case "ui.status": return WithId(id, StatusJson());
                case "ui.windows": return WithId(id, InvokeUi(WindowsJson));
                case "ui.snapshot": return WithId(id, InvokeUi(delegate { return SnapshotJson(request); }));
                case "ui.focus": return WithId(id, InvokeUi(delegate { return FocusJson(request); }));
                case "ui.openStatus": return WithId(id, InvokeUi(OpenStatusJson));
                case "ui.invoke": return WithId(id, InvokeUi(delegate { return InvokeElementJson(request); }));
                case "ui.setText": return WithId(id, InvokeUi(delegate { return SetTextJson(request); }));
                default: return Error("unknown-command", "Unknown PG-13 UI command: " + command, id);
            }
        }

        private static string InvokeUi(Func<string> action)
        {
            Application app = Application.Current;
            if (app == null || app.Dispatcher == null)
                return Error("ui-unavailable", "NinjaTrader UI dispatcher is unavailable.");

            if (app.Dispatcher.CheckAccess())
                return action();

            string result = null;
            app.Dispatcher.Invoke(delegate { result = action(); });
            return result;
        }

        private string StatusJson()
        {
            StringBuilder sb = new StringBuilder(192);
            sb.Append("{\"ok\":true");
            sb.Append(",\"safety\":\"pg13-no-live-orders\"");
            sb.Append(",\"pipe\":");
            AppendJsonString(sb, "\\\\.\\pipe\\" + _pipeName);
            sb.Append(",\"requests\":").Append(Requests.ToString(CultureInfo.InvariantCulture));
            string err = LastError;
            if (!string.IsNullOrEmpty(err))
            {
                sb.Append(",\"lastError\":");
                AppendJsonString(sb, err);
            }
            sb.Append("}");
            return sb.ToString();
        }

        private static string WindowsJson()
        {
            StringBuilder sb = new StringBuilder(1024);
            sb.Append("{\"ok\":true,\"windows\":[");
            WindowCollection windows = Application.Current.Windows;
            for (int i = 0; i < windows.Count; i++)
            {
                if (i > 0) sb.Append(',');
                WindowJson(sb, windows[i], i);
            }
            sb.Append("]}");
            return sb.ToString();
        }

        private static void WindowJson(StringBuilder sb, Window w, int index)
        {
            sb.Append("{\"index\":").Append(index.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"title\":");
            AppendJsonString(sb, WindowTitle(w));
            sb.Append(",\"type\":");
            AppendJsonString(sb, w != null ? w.GetType().FullName : "");
            sb.Append(",\"visible\":").Append(w != null && w.IsVisible ? "true" : "false");
            sb.Append(",\"active\":").Append(w != null && w.IsActive ? "true" : "false");
            if (w != null)
            {
                sb.Append(",\"left\":").Append(w.Left.ToString("0.###", CultureInfo.InvariantCulture));
                sb.Append(",\"top\":").Append(w.Top.ToString("0.###", CultureInfo.InvariantCulture));
                sb.Append(",\"width\":").Append(w.ActualWidth.ToString("0.###", CultureInfo.InvariantCulture));
                sb.Append(",\"height\":").Append(w.ActualHeight.ToString("0.###", CultureInfo.InvariantCulture));
            }
            sb.Append("}");
        }

        private static string SnapshotJson(Dictionary<string, string> request)
        {
            Window w = FindWindow(request);
            if (w == null)
                return Error("window-not-found", "No NinjaTrader window matched the requested title/type filter.");

            int maxDepth = Clamp(ToInt(Get(request, "maxDepth"), MaxDepthDefault), 1, 12);
            int maxNodes = Clamp(ToInt(Get(request, "maxNodes"), MaxTreeNodes), 1, 1000);

            StringBuilder sb = new StringBuilder(8192);
            sb.Append("{\"ok\":true,\"window\":");
            WindowJson(sb, w, WindowIndex(w));
            sb.Append(",\"nodes\":[");

            int count = 0;
            HashSet<object> seen = new HashSet<object>();
            AppendNodeTree(sb, w, "0", 0, maxDepth, maxNodes, ref count, seen);
            sb.Append("],\"truncated\":").Append(count >= maxNodes ? "true" : "false");
            sb.Append("}");
            return sb.ToString();
        }

        private static void AppendNodeTree(StringBuilder sb, object node, string path, int depth, int maxDepth, int maxNodes, ref int count, HashSet<object> seen)
        {
            if (node == null || count >= maxNodes || depth > maxDepth || seen.Contains(node))
                return;
            seen.Add(node);

            if (count > 0) sb.Append(',');
            AppendNodeJson(sb, node, path, depth);
            count++;

            List<object> children = Children(node);
            for (int i = 0; i < children.Count; i++)
            {
                if (count >= maxNodes)
                    break;
                AppendNodeTree(sb, children[i], path + "/" + i.ToString(CultureInfo.InvariantCulture), depth + 1, maxDepth, maxNodes, ref count, seen);
            }
        }

        private static List<object> Children(object node)
        {
            List<object> children = new List<object>();
            DependencyObject d = node as DependencyObject;
            if (d != null)
            {
                int n = 0;
                try { n = VisualTreeHelper.GetChildrenCount(d); } catch (Exception) { n = 0; }
                for (int i = 0; i < n; i++)
                {
                    try { children.Add(VisualTreeHelper.GetChild(d, i)); } catch (Exception) { }
                }
            }

            if (children.Count == 0)
            {
                DependencyObject logical = node as DependencyObject;
                if (logical != null)
                {
                    foreach (object child in LogicalTreeHelper.GetChildren(logical))
                        children.Add(child);
                }
            }

            return children;
        }

        private static void AppendNodeJson(StringBuilder sb, object node, string path, int depth)
        {
            FrameworkElement fe = node as FrameworkElement;
            Control control = node as Control;
            UIElement ui = node as UIElement;

            sb.Append("{\"path\":");
            AppendJsonString(sb, path);
            sb.Append(",\"depth\":").Append(depth.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"type\":");
            AppendJsonString(sb, node.GetType().Name);

            if (fe != null && !string.IsNullOrEmpty(fe.Name))
            {
                sb.Append(",\"name\":");
                AppendJsonString(sb, fe.Name);
            }

            string automationId = fe != null ? AutomationProperties.GetAutomationId(fe) : null;
            if (!string.IsNullOrEmpty(automationId))
            {
                sb.Append(",\"automationId\":");
                AppendJsonString(sb, automationId);
            }

            string text = NodeText(node);
            if (!string.IsNullOrEmpty(text))
            {
                sb.Append(",\"text\":");
                AppendJsonString(sb, Truncate(text, 240));
            }

            if (ui != null)
            {
                sb.Append(",\"visible\":").Append(ui.IsVisible ? "true" : "false");
                sb.Append(",\"enabled\":").Append(ui.IsEnabled ? "true" : "false");
            }
            if (control != null && control.Focusable)
                sb.Append(",\"focusable\":true");
            sb.Append("}");
        }

        private static string FocusJson(Dictionary<string, string> request)
        {
            Window w = FindWindow(request);
            if (w == null)
                return Error("window-not-found", "No NinjaTrader window matched the requested title/type filter.");
            w.Show();
            bool activated = w.Activate();
            return "{\"ok\":true,\"activated\":" + (activated ? "true" : "false") + ",\"title\":" + JsonString(WindowTitle(w)) + "}";
        }

        private static string OpenStatusJson()
        {
            Window existing = FindWindowByType(typeof(StatusWindow).FullName);
            if (existing != null)
            {
                existing.Show();
                existing.Activate();
                return "{\"ok\":true,\"opened\":false,\"title\":" + JsonString(WindowTitle(existing)) + "}";
            }

            StatusWindow w = new StatusWindow();
            w.Show();
            w.Activate();
            return "{\"ok\":true,\"opened\":true,\"title\":" + JsonString(WindowTitle(w)) + "}";
        }

        private static string InvokeElementJson(Dictionary<string, string> request)
        {
            Window w = FindWindow(request);
            if (w == null)
                return Error("window-not-found", "No NinjaTrader window matched the requested title/type filter.");

            object node = FindByPath(w, Get(request, "path"));
            if (node == null)
                return Error("node-not-found", "No UI node matched that snapshot path.");
            if (LooksLikeLiveOrderSurface(w, node))
                return Error("blocked-live-order-surface", "PG-13 UI control blocked a live-order-like control/window.");

            string action = Get(request, "action");
            if (string.IsNullOrEmpty(action))
                action = "click";

            UIElement ui = node as UIElement;
            if (ui == null)
                return Error("unsupported-node", "The requested node is not a UIElement.");

            if (action == "focus")
            {
                ui.Focus();
                return "{\"ok\":true,\"action\":\"focus\"}";
            }
            if (action == "toggle")
            {
                ToggleButton toggle = node as ToggleButton;
                if (toggle == null)
                    return Error("unsupported-action", "Toggle action requires a ToggleButton.");
                toggle.IsChecked = !toggle.IsChecked.GetValueOrDefault(false);
                return "{\"ok\":true,\"action\":\"toggle\",\"checked\":" + (toggle.IsChecked.GetValueOrDefault(false) ? "true" : "false") + "}";
            }
            if (action == "click")
            {
                ButtonBase button = node as ButtonBase;
                if (button != null)
                {
                    button.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
                    return "{\"ok\":true,\"action\":\"click\"}";
                }
                MenuItem menu = node as MenuItem;
                if (menu != null)
                {
                    menu.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
                    return "{\"ok\":true,\"action\":\"click\"}";
                }
                ui.Focus();
                return Error("unsupported-action", "Click is only enabled for buttons and menu items in PG-13 mode.");
            }

            return Error("unsupported-action", "Unsupported PG-13 UI action: " + action);
        }

        private static string SetTextJson(Dictionary<string, string> request)
        {
            Window w = FindWindow(request);
            if (w == null)
                return Error("window-not-found", "No NinjaTrader window matched the requested title/type filter.");

            object node = FindByPath(w, Get(request, "path"));
            TextBox textBox = node as TextBox;
            if (textBox == null)
                return Error("unsupported-node", "Text updates are only enabled for TextBox controls in PG-13 mode.");
            if (LooksLikeLiveOrderSurface(w, node))
                return Error("blocked-live-order-surface", "PG-13 UI control blocked a live-order-like control/window.");

            string value = Get(request, "value");
            textBox.Text = value ?? "";
            System.Windows.Data.BindingExpression binding = textBox.GetBindingExpression(TextBox.TextProperty);
            if (binding != null)
                binding.UpdateSource();
            return "{\"ok\":true,\"action\":\"setText\"}";
        }

        private static object FindByPath(object root, string path)
        {
            if (string.IsNullOrEmpty(path))
                return null;

            string[] parts = path.Split('/');
            object node = root;
            int start = parts.Length > 0 && parts[0] == "0" ? 1 : 0;
            for (int i = start; i < parts.Length; i++)
            {
                int index;
                if (!int.TryParse(parts[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out index))
                    return null;
                List<object> children = Children(node);
                if (index < 0 || index >= children.Count)
                    return null;
                node = children[index];
            }
            return node;
        }

        private static bool LooksLikeLiveOrderSurface(Window w, object node)
        {
            string haystack = (WindowTitle(w) + " " + (w != null ? w.GetType().FullName : "") + " " + NodeText(node)).ToLowerInvariant();
            string[] blocked = new string[]
            {
                "superdom", "chart trader", "basic entry", "order ticket", "buy market",
                "sell market", "flatten", "reverse", "close position", "submit order"
            };
            for (int i = 0; i < blocked.Length; i++)
            {
                if (haystack.IndexOf(blocked[i], StringComparison.Ordinal) >= 0)
                    return true;
            }
            return false;
        }

        private static Window FindWindow(Dictionary<string, string> request)
        {
            string indexText = Get(request, "windowIndex");
            int index;
            if (int.TryParse(indexText, NumberStyles.Integer, CultureInfo.InvariantCulture, out index))
            {
                WindowCollection windows = Application.Current.Windows;
                if (index >= 0 && index < windows.Count)
                    return windows[index];
            }

            string titleContains = Lower(Get(request, "titleContains"));
            string typeContains = Lower(Get(request, "typeContains"));

            WindowCollection all = Application.Current.Windows;
            for (int i = 0; i < all.Count; i++)
            {
                Window w = all[i];
                string title = Lower(WindowTitle(w));
                string type = Lower(w != null ? w.GetType().FullName : "");
                bool titleOk = string.IsNullOrEmpty(titleContains) || title.IndexOf(titleContains, StringComparison.Ordinal) >= 0;
                bool typeOk = string.IsNullOrEmpty(typeContains) || type.IndexOf(typeContains, StringComparison.Ordinal) >= 0;
                if (titleOk && typeOk)
                    return w;
            }
            return null;
        }

        private static Window FindWindowByType(string typeName)
        {
            WindowCollection all = Application.Current.Windows;
            for (int i = 0; i < all.Count; i++)
            {
                Window w = all[i];
                if (w != null && string.Equals(w.GetType().FullName, typeName, StringComparison.Ordinal))
                    return w;
            }
            return null;
        }

        private static int WindowIndex(Window window)
        {
            WindowCollection all = Application.Current.Windows;
            for (int i = 0; i < all.Count; i++)
            {
                if (object.ReferenceEquals(all[i], window))
                    return i;
            }
            return -1;
        }

        private static string WindowTitle(Window w)
        {
            if (w == null)
                return "";
            NTWindow nt = w as NTWindow;
            if (nt != null && !string.IsNullOrEmpty(nt.Caption))
                return nt.Caption;
            return w.Title ?? "";
        }

        private static string NodeText(object node)
        {
            TextBlock tb = node as TextBlock;
            if (tb != null) return tb.Text;

            TextBox textBox = node as TextBox;
            if (textBox != null) return textBox.Text;

            HeaderedContentControl hcc = node as HeaderedContentControl;
            if (hcc != null && hcc.Header != null) return hcc.Header.ToString();

            HeaderedItemsControl hic = node as HeaderedItemsControl;
            if (hic != null && hic.Header != null) return hic.Header.ToString();

            ContentControl cc = node as ContentControl;
            if (cc != null && cc.Content != null) return cc.Content.ToString();

            ItemsControl ic = node as ItemsControl;
            if (ic != null) return "items=" + ic.Items.Count.ToString(CultureInfo.InvariantCulture);

            FrameworkElement fe = node as FrameworkElement;
            if (fe != null)
            {
                string name = AutomationProperties.GetName(fe);
                if (!string.IsNullOrEmpty(name)) return name;
            }

            return null;
        }

        private static Dictionary<string, string> ParseFlatJson(string text)
        {
            Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.Ordinal);
            if (text == null)
                return map;

            int i = 0;
            while (i < text.Length)
            {
                while (i < text.Length && text[i] != '"') i++;
                if (i >= text.Length) break;
                string key = ParseJsonString(text, ref i);
                while (i < text.Length && text[i] != ':') i++;
                if (i >= text.Length) break;
                i++;
                while (i < text.Length && char.IsWhiteSpace(text[i])) i++;
                string value;
                if (i < text.Length && text[i] == '"')
                    value = ParseJsonString(text, ref i);
                else
                {
                    int start = i;
                    while (i < text.Length && text[i] != ',' && text[i] != '}') i++;
                    value = text.Substring(start, i - start).Trim();
                }
                map[key] = value;
            }
            return map;
        }

        private static string ParseJsonString(string text, ref int i)
        {
            StringBuilder sb = new StringBuilder();
            i++;
            while (i < text.Length)
            {
                char ch = text[i++];
                if (ch == '"') break;
                if (ch == '\\' && i < text.Length)
                {
                    char esc = text[i++];
                    if (esc == '"' || esc == '\\' || esc == '/') sb.Append(esc);
                    else if (esc == 'n') sb.Append('\n');
                    else if (esc == 'r') sb.Append('\r');
                    else if (esc == 't') sb.Append('\t');
                    else if (esc == 'b') sb.Append('\b');
                    else if (esc == 'f') sb.Append('\f');
                    else sb.Append(esc);
                }
                else
                    sb.Append(ch);
            }
            return sb.ToString();
        }

        private static string WithId(string id, string json)
        {
            if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(json) || json.Length < 2 || json[0] != '{')
                return json;
            return "{\"id\":" + JsonString(id) + "," + json.Substring(1);
        }

        private static string Error(string code, string message)
        {
            return Error(code, message, null);
        }

        private static string Error(string code, string message, string id)
        {
            StringBuilder sb = new StringBuilder(160);
            sb.Append("{");
            if (!string.IsNullOrEmpty(id))
            {
                sb.Append("\"id\":");
                AppendJsonString(sb, id);
                sb.Append(",");
            }
            sb.Append("\"ok\":false,\"error\":");
            AppendJsonString(sb, code);
            sb.Append(",\"message\":");
            AppendJsonString(sb, message);
            sb.Append("}");
            return sb.ToString();
        }

        private static string Get(Dictionary<string, string> map, string key)
        {
            string value;
            return map != null && map.TryGetValue(key, out value) ? value : null;
        }

        private static int ToInt(string value, int fallback)
        {
            int parsed;
            return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) ? parsed : fallback;
        }

        private static int Clamp(int value, int min, int max)
        {
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }

        private static string Lower(string value)
        {
            return string.IsNullOrEmpty(value) ? "" : value.ToLowerInvariant();
        }

        private static string Truncate(string value, int max)
        {
            if (value == null || value.Length <= max)
                return value;
            return value.Substring(0, max) + "...";
        }

        private static string JsonString(string value)
        {
            StringBuilder sb = new StringBuilder();
            AppendJsonString(sb, value);
            return sb.ToString();
        }

        private static void AppendJsonString(StringBuilder sb, string value)
        {
            sb.Append('"');
            if (value != null)
            {
                for (int i = 0; i < value.Length; i++)
                {
                    char ch = value[i];
                    if (ch == '"') sb.Append("\\\"");
                    else if (ch == '\\') sb.Append("\\\\");
                    else if (ch == '\n') sb.Append("\\n");
                    else if (ch == '\r') sb.Append("\\r");
                    else if (ch == '\t') sb.Append("\\t");
                    else if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(ch);
                }
            }
            sb.Append('"');
        }
    }
}
