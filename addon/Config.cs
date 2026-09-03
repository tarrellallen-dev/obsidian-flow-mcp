// Obsidian Flow MCP - AddOn
// Configuration file: Documents\NinjaTrader 8\ObsidianFlow.OrderFlowMcp.json
// .NET Framework 4.8. ASCII only.
//
// Serializer choice: hand-rolled, no dependencies. Newtonsoft.Json is NOT resolvable from an
// AddOn compiled inside bin\Custom on NinjaTrader 8.1.8.2 (CS0246), and
// System.Web.Script.Serialization would need a System.Web.Extensions reference added to the
// NinjaScript project, which the copy-into-bin\Custom workflow cannot guarantee. The config is a
// flat object with a string array, two numbers, a string and an optional nested execution
// object, so a small reader and a hand-written pretty printer are less trouble than either
// dependency. Both run once at startup on the AddOn worker thread, never on a hot path.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    // Present only when the config file carries an "execution" object. Spec section 7 keeps
    // execution default-off; step 1 parses these keys but acts on none of them.
    public sealed class ExecutionConfig
    {
        public bool Enabled;
        public bool AllowUnarmedKillSwitch;
    }

    public sealed class Config
    {
        public const string FileName = "ObsidianFlow.OrderFlowMcp.json";

        public List<string> Instruments;
        public int PushRateHz;
        public int RingCapacity;
        public string PipeName;

        // Optional. When set, the publisher thread appends one CSV line per instrument and
        // handler kind every 10 s to this file (step 2 instrumentation, read by the step 5
        // harness). Null or empty disables the dump; nothing is opened.
        public string DumpTo;

        // Step 3 computation (spec section 4). All sized once at start; none is a hot-path knob.
        // profileLevels: capacity of each per-price volume array, in ticks (the first price of a
        //   session anchors the array at its centre). histogramLevels: levels around the POC
        //   carried on the wire. maxNodes: HVN/LVN entries carried. historyBars: "minute"
        //   (1-minute bars, volume spread over the bar's range), "tick" (1-tick bars) or "none"
        //   (no BarsRequest; the profile starts at attach). checkpointMinutes: developing
        //   POC/VAH/VAL are frozen at this interval from the session open.
        // sessionBootstrapDays: lookback, in days, of the one-off coarse BarsRequest each
        //   instrument issues so a SessionIterator can be built from its Bars (NT8 has no way to
        //   ask a trading-hours template for a session directly). It only has to be long enough
        //   to return a series - the iterator answers about sessions the bars never covered - so
        //   the default is small; raise it only for an instrument so thin that a few days hold
        //   no data at all. Clamped to 1..30.
        public int ProfileLevels;
        public int HistogramLevels;
        public int MaxNodes;
        public string HistoryBars;
        public int CheckpointMinutes;
        public int SessionBootstrapDays;

        // Null unless the file declared an "execution" object; never written by default.
        public ExecutionConfig Execution;

        public Config()
        {
            Instruments = new List<string>();
            PushRateHz = 100;
            RingCapacity = 65536;
            PipeName = "obsidian-flow-mcp-v1";
            DumpTo = null;
            ProfileLevels = 8192;
            HistogramLevels = 64;
            MaxNodes = 16;
            HistoryBars = "minute";
            CheckpointMinutes = 30;
            SessionBootstrapDays = 5;
            Execution = null;
        }

        // The default is a bare root, never a contract month: InstrumentResolver turns a root
        // into the front contract at start and re-checks it for rolls (step 2.5). Any of the
        // three accepted shapes may be listed: "<root> MM-YY" (used as typed), "<root>"
        // (front contract), or a non-futures symbol (resolved directly).
        public static Config CreateDefault()
        {
            Config c = new Config();
            c.Instruments.Add("ES");
            return c;
        }

        // Documents\NinjaTrader 8\ObsidianFlow.OrderFlowMcp.json
        public static string DefaultPath()
        {
            string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            return Path.Combine(Path.Combine(documents, "NinjaTrader 8"), FileName);
        }

        // Loads the config, writing a default file when none exists. Never throws: on any
        // failure the defaults are returned and the reason is placed in loadError.
        public static Config Load(string path, out string loadError)
        {
            loadError = null;
            try
            {
                if (!File.Exists(path))
                {
                    Config created = CreateDefault();
                    Save(path, created);
                    return created;
                }

                string text = File.ReadAllText(path);
                Config loaded = Parse(text);
                if (loaded == null)
                {
                    loadError = "config file did not contain a JSON object; using defaults";
                    return CreateDefault();
                }

                loaded.Normalize();
                return loaded;
            }
            catch (Exception ex)
            {
                loadError = ex.Message;
                return CreateDefault();
            }
        }

        public static void Save(string path, Config config)
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);
            File.WriteAllText(path, ToJson(config));
        }

        // Clamps to values the rest of the AddOn can rely on.
        public void Normalize()
        {
            if (Instruments == null)
                Instruments = new List<string>();

            if (PushRateHz < 1)
                PushRateHz = 1;
            if (PushRateHz > 1000)
                PushRateHz = 1000;

            if (RingCapacity < 1024)
                RingCapacity = 1024;
            RingCapacity = RoundUpToPowerOfTwo(RingCapacity);

            if (string.IsNullOrEmpty(PipeName))
                PipeName = "obsidian-flow-mcp-v1";

            if (ProfileLevels < 256)
                ProfileLevels = 256;
            if (ProfileLevels > 65536)
                ProfileLevels = 65536;
            if (HistogramLevels < 1)
                HistogramLevels = 1;
            if (HistogramLevels > 1024)
                HistogramLevels = 1024;
            if (MaxNodes < 1)
                MaxNodes = 1;
            if (MaxNodes > 64)
                MaxNodes = 64;
            if (CheckpointMinutes < 1)
                CheckpointMinutes = 1;
            if (CheckpointMinutes > 1440)
                CheckpointMinutes = 1440;
            if (SessionBootstrapDays < 1)
                SessionBootstrapDays = 1;
            if (SessionBootstrapDays > 30)
                SessionBootstrapDays = 30;
            if (HistoryBars == null)
                HistoryBars = "minute";
            string mode = HistoryBars.Trim().ToLowerInvariant();
            if (mode != "minute" && mode != "tick" && mode != "none")
                mode = "minute";
            HistoryBars = mode;
        }

        private static int RoundUpToPowerOfTwo(int value)
        {
            int v = value - 1;
            v |= v >> 1;
            v |= v >> 2;
            v |= v >> 4;
            v |= v >> 8;
            v |= v >> 16;
            return v + 1;
        }

        // ------------------------------------------------------------------
        // Writer. Two-space indent, ASCII output, invariant number formatting.
        // ------------------------------------------------------------------
        public static string ToJson(Config c)
        {
            StringBuilder sb = new StringBuilder(256);
            sb.Append("{\r\n");

            sb.Append("  \"instruments\": [");
            if (c.Instruments != null && c.Instruments.Count > 0)
            {
                sb.Append("\r\n");
                for (int i = 0; i < c.Instruments.Count; i++)
                {
                    sb.Append("    ");
                    AppendJsonString(sb, c.Instruments[i]);
                    if (i < c.Instruments.Count - 1)
                        sb.Append(",");
                    sb.Append("\r\n");
                }
                sb.Append("  ");
            }
            sb.Append("],\r\n");

            sb.Append("  \"pushRateHz\": ");
            sb.Append(c.PushRateHz.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\r\n");

            sb.Append("  \"ringCapacity\": ");
            sb.Append(c.RingCapacity.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\r\n");

            sb.Append("  \"pipeName\": ");
            AppendJsonString(sb, c.PipeName);
            sb.Append(",\r\n");

            sb.Append("  \"profileLevels\": ");
            sb.Append(c.ProfileLevels.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\r\n");
            sb.Append("  \"histogramLevels\": ");
            sb.Append(c.HistogramLevels.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\r\n");
            sb.Append("  \"maxNodes\": ");
            sb.Append(c.MaxNodes.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\r\n");
            sb.Append("  \"historyBars\": ");
            AppendJsonString(sb, c.HistoryBars);
            sb.Append(",\r\n");
            sb.Append("  \"checkpointMinutes\": ");
            sb.Append(c.CheckpointMinutes.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\r\n");
            sb.Append("  \"sessionBootstrapDays\": ");
            sb.Append(c.SessionBootstrapDays.ToString(CultureInfo.InvariantCulture));

            if (!string.IsNullOrEmpty(c.DumpTo))
            {
                sb.Append(",\r\n");
                sb.Append("  \"dumpTo\": ");
                AppendJsonString(sb, c.DumpTo);
            }

            if (c.Execution != null)
            {
                sb.Append(",\r\n");
                sb.Append("  \"execution\": {\r\n");
                sb.Append("    \"enabled\": ");
                sb.Append(c.Execution.Enabled ? "true" : "false");
                sb.Append(",\r\n");
                sb.Append("    \"allowUnarmedKillSwitch\": ");
                sb.Append(c.Execution.AllowUnarmedKillSwitch ? "true" : "false");
                sb.Append("\r\n  }");
            }

            sb.Append("\r\n}\r\n");
            return sb.ToString();
        }

        private static void AppendJsonString(StringBuilder sb, string s)
        {
            sb.Append('"');
            if (s != null)
            {
                for (int i = 0; i < s.Length; i++)
                {
                    char ch = s[i];
                    if (ch == '"')
                        sb.Append("\\\"");
                    else if (ch == '\\')
                        sb.Append("\\\\");
                    else if (ch == '\n')
                        sb.Append("\\n");
                    else if (ch == '\r')
                        sb.Append("\\r");
                    else if (ch == '\t')
                        sb.Append("\\t");
                    else if (ch < 0x20 || ch > 0x7E)
                        sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                    else
                        sb.Append(ch);
                }
            }
            sb.Append('"');
        }

        // ------------------------------------------------------------------
        // Reader. Enough JSON for this file: object, array, string, number, true/false/null.
        // Whitespace tolerant. Unknown keys are parsed and then ignored rather than rejected, so
        // a config written by a later build still loads here. Returns null when the text is not
        // a JSON object; throws FormatException on malformed input, which Load turns into
        // loadError.
        // ------------------------------------------------------------------
        public static Config Parse(string text)
        {
            if (text == null)
                return null;

            int i = 0;
            SkipWhitespace(text, ref i);
            if (i >= text.Length || text[i] != '{')
                return null;

            object root = ParseValue(text, ref i);

            Dictionary<string, object> map = root as Dictionary<string, object>;
            if (map == null)
                return null;

            Config c = new Config();
            object value;

            if (map.TryGetValue("instruments", out value))
            {
                List<object> items = value as List<object>;
                if (items != null)
                {
                    for (int n = 0; n < items.Count; n++)
                    {
                        string name = items[n] as string;
                        if (!string.IsNullOrEmpty(name))
                            c.Instruments.Add(name);
                    }
                }
            }

            if (map.TryGetValue("pushRateHz", out value))
                c.PushRateHz = ToInt(value, c.PushRateHz);

            if (map.TryGetValue("ringCapacity", out value))
                c.RingCapacity = ToInt(value, c.RingCapacity);

            if (map.TryGetValue("pipeName", out value))
            {
                string pipe = value as string;
                if (!string.IsNullOrEmpty(pipe))
                    c.PipeName = pipe;
            }

            if (map.TryGetValue("dumpTo", out value))
            {
                string dump = value as string;
                if (!string.IsNullOrEmpty(dump))
                    c.DumpTo = dump;
            }

            if (map.TryGetValue("profileLevels", out value))
                c.ProfileLevels = ToInt(value, c.ProfileLevels);
            if (map.TryGetValue("histogramLevels", out value))
                c.HistogramLevels = ToInt(value, c.HistogramLevels);
            if (map.TryGetValue("maxNodes", out value))
                c.MaxNodes = ToInt(value, c.MaxNodes);
            if (map.TryGetValue("historyBars", out value))
            {
                string mode = value as string;
                if (!string.IsNullOrEmpty(mode))
                    c.HistoryBars = mode;
            }
            if (map.TryGetValue("checkpointMinutes", out value))
                c.CheckpointMinutes = ToInt(value, c.CheckpointMinutes);
            if (map.TryGetValue("sessionBootstrapDays", out value))
                c.SessionBootstrapDays = ToInt(value, c.SessionBootstrapDays);

            if (map.TryGetValue("execution", out value))
            {
                Dictionary<string, object> exec = value as Dictionary<string, object>;
                if (exec != null)
                {
                    c.Execution = new ExecutionConfig();
                    object flag;
                    if (exec.TryGetValue("enabled", out flag))
                        c.Execution.Enabled = ToBool(flag, false);
                    if (exec.TryGetValue("allowUnarmedKillSwitch", out flag))
                        c.Execution.AllowUnarmedKillSwitch = ToBool(flag, false);
                }
            }

            return c;
        }

        private static int ToInt(object value, int fallback)
        {
            if (value is double)
            {
                double d = (double)value;
                if (d < int.MinValue) return int.MinValue;
                if (d > int.MaxValue) return int.MaxValue;
                return (int)d;
            }

            string s = value as string;
            if (s != null)
            {
                int parsed;
                if (int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
                    return parsed;
            }
            return fallback;
        }

        private static bool ToBool(object value, bool fallback)
        {
            if (value is bool)
                return (bool)value;

            string s = value as string;
            if (s != null)
            {
                if (string.Equals(s, "true", StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(s, "false", StringComparison.OrdinalIgnoreCase)) return false;
            }
            return fallback;
        }

        private static void SkipWhitespace(string s, ref int i)
        {
            while (i < s.Length)
            {
                char ch = s[i];
                if (ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n')
                    i++;
                else
                    break;
            }
        }

        private static object ParseValue(string s, ref int i)
        {
            SkipWhitespace(s, ref i);
            if (i >= s.Length)
                throw new FormatException("unexpected end of JSON");

            char ch = s[i];
            if (ch == '{') return ParseObject(s, ref i);
            if (ch == '[') return ParseArray(s, ref i);
            if (ch == '"') return ParseString(s, ref i);

            if (ch == 't' || ch == 'f' || ch == 'n')
            {
                if (Match(s, i, "true")) { i += 4; return true; }
                if (Match(s, i, "false")) { i += 5; return false; }
                if (Match(s, i, "null")) { i += 4; return null; }
                throw new FormatException("unexpected literal at offset " + i.ToString(CultureInfo.InvariantCulture));
            }

            return ParseNumber(s, ref i);
        }

        private static bool Match(string s, int i, string word)
        {
            if (i + word.Length > s.Length)
                return false;
            for (int k = 0; k < word.Length; k++)
            {
                if (s[i + k] != word[k])
                    return false;
            }
            return true;
        }

        private static Dictionary<string, object> ParseObject(string s, ref int i)
        {
            Dictionary<string, object> map = new Dictionary<string, object>(StringComparer.Ordinal);
            i++;                                        // consume '{'
            SkipWhitespace(s, ref i);

            if (i < s.Length && s[i] == '}')
            {
                i++;
                return map;
            }

            for (;;)
            {
                SkipWhitespace(s, ref i);
                if (i >= s.Length || s[i] != '"')
                    throw new FormatException("expected a key at offset " + i.ToString(CultureInfo.InvariantCulture));

                string key = ParseString(s, ref i);

                SkipWhitespace(s, ref i);
                if (i >= s.Length || s[i] != ':')
                    throw new FormatException("expected ':' at offset " + i.ToString(CultureInfo.InvariantCulture));
                i++;

                map[key] = ParseValue(s, ref i);

                SkipWhitespace(s, ref i);
                if (i >= s.Length)
                    throw new FormatException("unterminated object");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return map; }
                throw new FormatException("expected ',' or '}' at offset " + i.ToString(CultureInfo.InvariantCulture));
            }
        }

        private static List<object> ParseArray(string s, ref int i)
        {
            List<object> items = new List<object>();
            i++;                                        // consume '['
            SkipWhitespace(s, ref i);

            if (i < s.Length && s[i] == ']')
            {
                i++;
                return items;
            }

            for (;;)
            {
                items.Add(ParseValue(s, ref i));

                SkipWhitespace(s, ref i);
                if (i >= s.Length)
                    throw new FormatException("unterminated array");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return items; }
                throw new FormatException("expected ',' or ']' at offset " + i.ToString(CultureInfo.InvariantCulture));
            }
        }

        private static string ParseString(string s, ref int i)
        {
            i++;                                        // consume the opening quote
            StringBuilder sb = new StringBuilder();

            while (i < s.Length)
            {
                char ch = s[i];

                if (ch == '"')
                {
                    i++;
                    return sb.ToString();
                }

                if (ch != '\\')
                {
                    sb.Append(ch);
                    i++;
                    continue;
                }

                i++;
                if (i >= s.Length)
                    break;

                char esc = s[i];
                i++;
                switch (esc)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length)
                            throw new FormatException("truncated unicode escape");
                        int code = int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                        sb.Append((char)code);
                        i += 4;
                        break;
                    default:
                        throw new FormatException("unknown escape sequence in string");
                }
            }

            throw new FormatException("unterminated string");
        }

        private static object ParseNumber(string s, ref int i)
        {
            int start = i;
            if (i < s.Length && (s[i] == '-' || s[i] == '+'))
                i++;
            while (i < s.Length)
            {
                char ch = s[i];
                if ((ch >= '0' && ch <= '9') || ch == '.' || ch == 'e' || ch == 'E' || ch == '+' || ch == '-')
                    i++;
                else
                    break;
            }

            if (i == start)
                throw new FormatException("expected a number at offset " + start.ToString(CultureInfo.InvariantCulture));

            string token = s.Substring(start, i - start);
            double value;
            if (!double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out value))
                throw new FormatException("malformed number in config");
            return value;
        }
    }
}
