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
5. On a successful compile, NinjaScript reloads the AddOn. A new item **Obsidian Flow MCP**
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
- an optional `execution` object (`enabled`, `allowUnarmedKillSwitch`) is parsed if present and
  acted on by nothing in this build step. Unknown keys are ignored rather than rejected.
- `pushRateHz` - snapshot frames per second per instrument.
- `ringCapacity` - per-ring slot count, rounded up to a power of two.
- `pipeName` - the server side listens on `\\.\pipe\<pipeName>`.
- `dumpTo` - optional, absent by default. A file path; when set, the publisher thread appends
  one CSV line per instrument and handler kind, plus one for its own serializer, every 10 s:
  `timestamp,instrument,kind,count,p50,p99,p999,max,allocPer1024,allocTotal`. Latency columns
  are nanoseconds; `kind` is `data`, `depth` or `serialize` (instrument `publisher`).
  `allocPer1024` and `allocTotal` are -1 when not measured (runtime lacks the counter, the
  probe has not run yet, or the `publisher` row, where per-1024 is not defined); the latency
  columns are -1 while that histogram is empty. Allocation totals are thread-wide (see below).
  The file is
  opened and written only on the publisher thread; a write failure stops the dump and is shown
  in the status window, and never touches a handler. Build step 5's harness reads this file.

The file is read once at start. Change it, then recompile (F5) or restart NinjaTrader.

## Files

| File | Role |
|---|---|
| `OrderFlowMcpAddOn.cs` | `AddOnBase` subclass, Control Center menu item, start/stop |
| `Engine.cs` | Process-wide singleton owning config, feeds and the publisher |
| `Config.cs` | JSON config load/write, hand-rolled with no dependencies (see the comment at the top of the file) |
| `MdEvent.cs` | Blittable ring slot struct |
| `SpscRing.cs` | Single-producer/single-consumer ring, drop-newest on full |
| `InstrumentFeed.cs` | Market data and market depth subscriptions, hot-path handlers |
| `Publisher.cs` | Publisher thread, named pipe server, frame serialization |
| `AllocationProbe.cs` | Reads the per-thread allocation counter; changes no GC setting; -1 sentinel for "unavailable" |
| `LatencyHistogram.cs` | Hand-rolled log-linear histogram (100 ns .. 1 s, two significant digits) and the once-per-second `LatencySummary` |
| `StatusWindow.cs` | `NTWindow` status display, refreshed at 2 Hz |

## What this build step does

Steps 1 and 2: transport, the threading contract, and instrumentation. The publisher drains the
rings, discards the contents, and reports counters and its own measurements. Nothing about the
market is computed.

Handler timing: each handler stores `Stopwatch` ticks from entry to just after the ring push into
its own single-writer sample ring. The publisher thread drains those samples into a per-handler
`LatencyHistogram` during `DrainAll`, times its own frame serialization into a third histogram,
and once a second recomputes p50/p99/p99.9/max into plain fields. The status window reads those
fields (volatile reads at 2 Hz; the window takes no lock and calls nothing on the publisher)
and shows them in microseconds, "--" while a histogram is empty; the snapshot frame carries
them in nanoseconds (`schema/wire-v1.md`, "step-2 block"); the MCP tool `latency_report` returns
them with an environment block. These are the AddOn's own in-process measurements, not
end-to-end figures.

Allocation: each handler reads `GC.GetAllocatedBytesForCurrentThread` once every 1024 events
into a preallocated slot, and records which managed thread it ran on. The publisher reports the
delta over the most recent window as "alloc/1024" and last-minus-first as the running total, for
each handler thread and for itself. When the runtime does not expose that method, or the probe
has not run yet, the figure is -1 and labelled "unavailable"; 0 always means measured zero
bytes. The counter is thread-wide: it includes NinjaTrader's own allocations on that thread, and
feeds whose handlers NT raises on one thread see the same number, so the status window lists it
once per distinct thread and labels it "thread-wide". It bounds the handler's allocation; it does
not attribute it. The probe sits inside the timed region, so its own cost appears in the
handler's p99 and max rather than being hidden by the instrumentation.
