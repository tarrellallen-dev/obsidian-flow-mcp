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
  "instruments": [ "ES" ],
  "pushRateHz": 100,
  "ringCapacity": 65536,
  "pipeName": "obsidian-flow-mcp-v1"
}
```

- `instruments` - one entry per instrument, in any of the three shapes described under
  "Instrument names" below. The default is the bare root `ES`, which resolves to the front
  contract; no contract month is written anywhere by the AddOn.
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

## Instrument names

Each `instruments` entry is resolved by `InstrumentResolver.cs` at start into an **identity
record** (resolved name, master instrument, instrument type, exchange, currency, expiry, tick
size, point value, trading-hours template, how it was resolved, and roll history). That record
goes into the hello frame, is returned by the `instruments` MCP tool, and is what recorded
history is labelled with. Nothing in the AddOn assumes futures: equities, forex, crypto,
indexes and CFDs go through the same path. Three shapes are accepted:

| You type | Shape | What happens |
|---|---|---|
| `ES 12-26` (an example month) | fully qualified | Used exactly as typed via `Instrument.GetInstrument`. Never re-resolved; if the contract has expired the status window says so and no data will arrive. |
| `ES`, `NQ`, `CL` | bare futures root | Resolved to the front contract and **re-checked for rolls** once a minute and at every session boundary. |
| `MSFT`, `EURUSD`, `BTCUSD`, `^SPX` | direct (anything that is not a future) | Used exactly as typed. Never re-resolved. |

Resolution order for a bare root, in `InstrumentResolver.Resolve`:

1. `Instrument.GetInstrument(root)`. NinjaTrader itself may hand back its current default
   contract; if that contract expires strictly after now it is used (`resolvedBy: nt8Default`).
2. Otherwise the master instrument's own rollover table (`MasterInstrument.RolloverCollection`):
   the latest rollover whose date has passed names the contract NinjaTrader is on, later entries
   name the ones after it. Each candidate is looked up and must expire strictly after now
   (`resolvedBy: rolloverTable`).
3. Otherwise `MasterInstrument.GetNextExpiry(now)`, the nearest expiry strictly after now by
   NinjaTrader's calculation (`resolvedBy: nextExpiry`).
4. Otherwise the entry is **unresolved**: it is listed with the reason in the status window
   ("Resolved as" row), in the hello frame, and in the MCP `health` tool. It never throws and
   never stops the other instruments. Unresolved entries are not retried; fix the entry and
   recompile (F5) or restart NinjaTrader.

No contract month is ever derived by arithmetic on today's date. The only month strings the
AddOn forms are `MM-yy` renderings of dates that NinjaTrader's rollover table or expiry
calculation supplied.

### Rolls

Only bare-root entries roll. On the publisher thread, once a minute and at each session
boundary (from the instrument's trading-hours template), the root is re-resolved. If the front
contract changed:

1. a new feed (new rings, new counters) is subscribed for the new contract and swapped in at
   the same instrument index; the old subscriptions are unhooked;
2. contract-specific state for that index is reset (sample positions, ring drops, overruns);
   the handler latency histograms measure the code, not the contract, and are kept;
3. if a client is attached, the hello is re-announced (same indices, new identity at that
   index) followed by a `contractRolled` event carrying both identities
   (`schema/wire-v1.md`, "type 2 - event"). The event's sequence number is the boundary; a
   consumer never blends the two contracts in one series;
4. the identity carries `rolledAtUtc` and `rollCount`, so a client that connects later still
   sees that a roll happened. The status window shows the roll count and the last roll.

If the re-resolution fails or the new subscription cannot be made, the current contract stays
subscribed and the reason appears in the status window's connection row.

## Files

| File | Role |
|---|---|
| `OrderFlowMcpAddOn.cs` | `AddOnBase` subclass, Control Center menu item, start/stop |
| `Engine.cs` | Process-wide singleton owning config, feeds and the publisher |
| `Config.cs` | JSON config load/write, hand-rolled with no dependencies (see the comment at the top of the file) |
| `MdEvent.cs` | Blittable ring slot struct |
| `SpscRing.cs` | Single-producer/single-consumer ring, drop-newest on full |
| `InstrumentResolver.cs` | Three config shapes to one identity record; front-contract resolution from NinjaTrader's own roll data; never assumes futures |
| `InstrumentFeed.cs` | Market data and market depth subscriptions, hot-path handlers |
| `Publisher.cs` | Publisher thread, named pipe server, frame serialization, roll detection and re-subscription |
| `AllocationProbe.cs` | Reads the per-thread allocation counter; changes no GC setting; -1 sentinel for "unavailable" |
| `LatencyHistogram.cs` | Hand-rolled log-linear histogram (100 ns .. 1 s, two significant digits) and the once-per-second `LatencySummary` |
| `StatusWindow.cs` | `NTWindow` status display, refreshed at 2 Hz |

## What this build step does

Steps 1 and 2: transport, the threading contract, and instrumentation. Step 2.5: instrument
identity and rolls (above). The publisher drains the rings, discards the contents, and reports
counters and its own measurements. Nothing about the market is computed.

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
