# Latency methodology

Stub. No numbers have been measured. Nothing in this file may be filled in from an estimate, a
recollection, or a single run; each number is published together with the harness that produced
it and the environment block below.

Latency here is a measurement, not a claim. This file does not, and will not, contain the words
"lowest latency", "real-time", "institutional-grade" or "HFT", and no number appears anywhere in
the project without this page next to it.

## The four numbers

All are reported as percentiles - p50, p99, p99.9 - never averages, and always with the offered
load stated alongside.

| # | Number | Measured where | Instrument | Status |
|---|---|---|---|---|
| 1 | Handler time on the NinjaTrader data thread | AddOn, inside `OnMarketDataUpdate` / `OnMarketDepthUpdate` | `Stopwatch` ticks into an HdrHistogram | not measured |
| 2 | Allocation per event | AddOn, on both data threads and on the publisher thread | `GC.GetAllocatedBytesForCurrentThread` delta, sampled inside each handler every 1024 events into a preallocated slot; steady state is expected to be 0 | counter recorded, no number yet |
| 3 | Staleness at service time | AddOn to server | `receiveToServeMs`, measured on the server's monotonic clock, reported next to a separately labelled `oneWayEstimateMs` | not measured |
| 4 | Execution round trip | AddOn | MCP tool call -> `Account.Submit` return; only when execution is enabled | not measured, feature not built |

Build step 1 records raw handler durations into a fixed-size sample buffer per subscription and
reports only a count. The histogram arrives in build step 2; no percentile can be quoted before
then.

Number 3 is two quantities and they are never summed into one figure. `receiveToServeMs` is
measured exactly, from decoding a frame to answering a tool call, on one clock. `oneWayEstimateMs`
is an estimate of the AddOn-to-server hop taken from the publisher's fixed heartbeat cadence and
its `Stopwatch.Frequency` (carried in the hello frame); the two processes share no clock epoch, so
the constant part of the delay is unrecoverable and this estimate is a lower bound on jitter, not
a one-way latency. Any table quoting number 3 shows both terms and labels which was measured.

## Load points

The synthetic generator (seeded, committed under `bench/`) drives the same rings and calculators
at 1k / 5k / 20k / 50k events per second. The server side is driven in CI by a replayed frame
log. Correctness is checked separately against NinjaTrader Market Replay of a fixed session.

## Coordinated omission

Corrected and uncorrected figures are published side by side. A table showing only one of them is
incomplete and does not ship.

## Environment block

Every published table carries all of the following. A table missing any field does not ship.

- CPU model, core and thread count, base and boost clock
- Physical memory
- Windows edition and build number
- Bare metal or VM, and if VM, the hypervisor and the vCPU allocation
- Power plan and whether it was pinned during the run
- NinjaTrader 8 build number (Help > About)
- `Stopwatch.Frequency` and `Stopwatch.IsHighResolution` as observed in the NinjaTrader process
- .NET Framework version of the host process
- Node version for the server-side numbers
- Data feed and connection type, and whether Level 2 depth was present
- Instrument and session
- Offered load, run duration, and warm-up discarded
- Number of runs and which run the table reports

## Cross-check

NinjaTrader's own NinjaScript Utilization Monitor is run for five minutes with and without the
AddOn loaded, and both rankings are published unedited alongside the table.

## Open items before any number is published

- NinjaTrader 8 build number is not yet recorded.
- The benchmark harness (`bench/`) is a placeholder; build step 5.
- Depth availability on the development machine is unconfirmed, so number 1 has no depth-load
  variant yet.
