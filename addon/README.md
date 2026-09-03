# AddOn

C# source for the NinjaTrader 8 AddOn. Target framework is .NET Framework 4.8, matching the
NinjaTrader 8 process. Namespace: `NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp`.

This directory cannot be compiled here. NinjaScript compiles from inside NinjaTrader.

## Single-writer rule

`addon/` in this repository is the only place these files are edited. The copy inside
NinjaTrader is a build output, never an edit target. If you fix something in NinjaTrader,
copy it back here before committing, or the next copy overwrites it.

## Install

1. Close any running instance of the AddOn's status window.
2. Create the folder:

   ```
   Documents\NinjaTrader 8\bin\Custom\AddOns\ObsidianFlow.OrderFlowMcp\
   ```

3. Copy every `.cs` file from this directory into that folder. Do not copy `README.md`.
4. In NinjaTrader, open the NinjaScript Editor (New > NinjaScript Editor) and press **F5**
   to compile. Compile errors appear in the editor's error list.
5. On a successful compile, NinjaScript reloads the AddOn. A new item **Order-Flow MCP**
   appears under the Control Center **New** menu; it opens the status window.

Repeat steps 3 and 4 after every change made here.

## Configuration

On first start the AddOn writes `Documents\NinjaTrader 8\ObsidianFlow.OrderFlowMcp.json`
if it does not exist:

```json
{
  "instruments": [ "ES 06-26" ],
  "pushRateHz": 100,
  "ringCapacity": 65536,
  "pipeName": "obsidianflow-orderflow-v1"
}
```

- `instruments` - NinjaTrader instrument names, resolved with `Instrument.GetInstrument`.
- `pushRateHz` - snapshot frames per second per instrument.
- `ringCapacity` - per-ring slot count, rounded up to a power of two.
- `pipeName` - the server side listens on `\\.\pipe\<pipeName>`.

The file is read once at start. Change it, then recompile (F5) or restart NinjaTrader.

## Files

| File | Role |
|---|---|
| `OrderFlowMcpAddOn.cs` | `AddOnBase` subclass, Control Center menu item, start/stop |
| `Engine.cs` | Process-wide singleton owning config, feeds and the publisher |
| `Config.cs` | JSON config load/write (Newtonsoft.Json; see the comment at the top of the file) |
| `MdEvent.cs` | Blittable ring slot struct |
| `SpscRing.cs` | Single-producer/single-consumer ring, drop-newest on full |
| `InstrumentFeed.cs` | Market data and market depth subscriptions, hot-path handlers |
| `Publisher.cs` | Publisher thread, named pipe server, frame serialization |
| `AllocationProbe.cs` | Reads the per-thread allocation counter; changes no GC setting |
| `StatusWindow.cs` | `NTWindow` status display, refreshed at 2 Hz |

## What this build step does

Transport and the threading contract only. The publisher drains the rings, discards the
contents, and reports counters. Nothing about the market is computed.

The status window's "Data-thread alloc delta" row is the counter behind spec 2.1's zero-allocation
requirement: each handler reads `GC.GetAllocatedBytesForCurrentThread` once every 1024 events into
a preallocated slot, so the per-event cost is a mask and a compare. It is a counter, not a
measurement - the histogram and the published numbers arrive in build step 2. It reads
"unavailable on this runtime" when the host does not expose that method.
