// ObsidianFlow Order-Flow MCP - AddOn
// Configuration file: Documents\NinjaTrader 8\ObsidianFlow.OrderFlowMcp.json
// .NET Framework 4.8. ASCII only.
//
// Serializer choice: Newtonsoft.Json. NinjaTrader.Custom already references Newtonsoft.Json,
// so an AddOn compiled inside bin\Custom gets it with no extra reference and no extra file to
// deploy. System.Web.Script.Serialization would need an explicit System.Web.Extensions
// reference added to the NinjaScript project, which the copy-into-bin\Custom workflow cannot
// guarantee. Config load happens once at startup on the AddOn worker thread, never on a hot
// path, so Newtonsoft's allocations are irrelevant here.

using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public sealed class Config
    {
        public const string FileName = "ObsidianFlow.OrderFlowMcp.json";

        [JsonProperty("instruments")]
        public List<string> Instruments { get; set; }

        [JsonProperty("pushRateHz")]
        public int PushRateHz { get; set; }

        [JsonProperty("ringCapacity")]
        public int RingCapacity { get; set; }

        [JsonProperty("pipeName")]
        public string PipeName { get; set; }

        public Config()
        {
            Instruments = new List<string>();
            PushRateHz = 100;
            RingCapacity = 65536;
            PipeName = "obsidianflow-orderflow-v1";
        }

        public static Config CreateDefault()
        {
            Config c = new Config();
            c.Instruments.Add("ES 06-26");
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
                Config loaded = JsonConvert.DeserializeObject<Config>(text);
                if (loaded == null)
                {
                    loadError = "config file parsed to null; using defaults";
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
            File.WriteAllText(path, JsonConvert.SerializeObject(config, Formatting.Indented));
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
                PipeName = "obsidianflow-orderflow-v1";
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
    }
}
