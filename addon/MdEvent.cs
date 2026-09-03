// Obsidian Flow MCP - AddOn
// Spec section 3.1: blittable ring slot struct.
// .NET Framework 4.8. ASCII only.

using System.Runtime.InteropServices;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    // Event kind discriminator for MdEvent.Kind.
    public static class MdEventKind
    {
        public const byte None = 0;
        public const byte MarketData = 1;
        public const byte MarketDepth = 2;
    }

    // Blittable, no reference fields, explicit sequential layout so the struct can live
    // inside a preallocated MdEvent[] with no per-event allocation and no GC scanning cost.
    // Field order is chosen to keep 8-byte members naturally aligned.
    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    public struct MdEvent
    {
        public double Price;            // MarketDataEventArgs.Price / MarketDepthEventArgs.Price
        public long Size;               // MarketDataEventArgs.Volume / MarketDepthEventArgs.Volume
        public double Bid;              // last known bid at event time (0 when unknown)
        public double Ask;              // last known ask at event time (0 when unknown)
        public long StopwatchTicks;     // Stopwatch.GetTimestamp() captured at handler entry
        public long TimeTicks;          // e.Time.Ticks, NinjaTrader's local-time convention. Session
                                        // bucketing on the publisher thread compares this with the
                                        // trading-hours boundaries, never the publisher's own clock.
        public int Position;            // MarketDepthEventArgs.Position, -1 for market data events
        public byte Kind;               // MdEventKind
        public byte Operation;          // (byte)Operation for depth events, 0 otherwise
        public byte Side;               // (byte)MarketDataType side for depth events, 0 otherwise
        public byte MarketDataType;     // (byte)MarketDataType for market data events, 0 otherwise
    }
}
