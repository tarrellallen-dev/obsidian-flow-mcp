# Roadmap: companion backtester (not started)

Status: planned. Nothing here exists yet. This note records the design so it is not re-derived
later; it is deliberately sequenced after the order-flow server is proven (build steps 1-8 in the
spec), not in parallel with it.

## What it is

A separate repository, `nt8-orderflow-backtester`, that replays recorded market data through the
same calculators the live server uses, simulates fills with explicit fee and slippage models, and
exposes the run to the LLM through MCP tools (`backtest_run`, `backtest_status`, `backtest_report`,
`backtest_compare`). A person or a model can iterate on a rule set in seconds rather than through
the NinjaTrader Strategy Analyzer round-trip, then promote the survivors to a real NinjaScript
strategy for the final check inside NT8.

It is not a replacement for the Strategy Analyzer. The Analyzer is the ground truth for anything
that will trade through NinjaTrader; this is the fast inner loop in front of it.

## Why it can share code with the server

The server already has one wire format (`schema/wire-v1.md`), one set of calculators (session
profile, VWAP, DOM dynamics) that run on a drained event stream, and one benchmark replayer
(`bench/`, step 5) that feeds recorded frames through the server without NT8 attached. The
backtester is that replayer plus a fill simulator and a report. The calculators are the same
code, so a profile level the model sees live is the profile level the backtest used.

## Data the user must provide

The backtester ships with no market data. Three sources are supported, in order of fidelity:

1. **Frame logs recorded by this AddOn** (`Publisher` writes the same frames into the
   backtester's local store when `recordTo` is set in the config). This is the only source that carries Level 2 depth and the
   DOM dynamics, because NinjaTrader does not store historical depth. Record a session live or
   under Market Replay, then backtest against it as often as you like.
2. **NinjaTrader historical tick export** (Tools > Historical Data > Export, tick or minute).
   Trades only, no depth; profile and VWAP work, DOM dynamics are reported as unavailable.
3. **Third-party tick/MBO files** (for example Databento DBN or CSV) through a small importer
   interface. Depth is available if the file carries it.

The README of that repository states this in its first paragraph: you need your own data, here
is how to get it, here is what each source can and cannot answer.

## Local data store: backtests run with NinjaTrader closed

The backtester owns its data. Everything it ingests -- recorded frame logs, NT8 tick exports,
third-party files -- is normalised once into a local, append-only store keyed by instrument and
session (a directory of per-session files in the wire's own binary layout, with an index file;
no database server, no NinjaTrader dependency at read time). After that, a backtest reads the
store directly: NinjaTrader does not need to be running, connected, or asked to download
anything, and the replay path is a sequential file read into the same ring the live server
drains rather than a trip through NinjaTrader's data layer.

The AddOn side of this is the archive lane of ADR 0003 (`docs/decisions/0003-two-lanes-hot-and-archive.md`): the same drain that serves the live hot lane also writes every raw event to the store, without ever slowing the hot lane. Ingestion is the only step that ever touches NT8, and it is a one-time cost per session. Two
ways in: the AddOn's `recordTo` writes the store format directly while a session plays (live or
Market Replay), and the importer converts exports or third-party files offline. The store keeps a
provenance line per session (source, capture time, whether depth is present, AddOn and schema
versions) so a report can say exactly what it ran on. Storage cost is the user's disk; a full ES
session with depth at tick resolution runs to hundreds of megabytes, and the store says so in
its listing.

This is also where the speed comes from. The Strategy Analyzer replays through the whole
platform -- bar building, indicator recalculation, chart state -- for every run. The store feeds
a fixed-layout stream straight into the calculators, so run time is bounded by disk read and
calculator throughput, which is the number the harness publishes.

## Cost model

Fees and slippage are inputs, never defaults hidden in code: exchange and clearing fees per
side per contract, commission per side, a slippage model chosen per run (fixed ticks, a
function of displayed size at the touch from the recorded book, or a worst-of-N scenario), and
a latency model that delays the simulated order by a configurable number of microseconds or
milliseconds before it meets the book. Every report prints the cost assumptions next to the
result, and `backtest_compare` runs the same rules across a scenario grid so the model sees how
an edge behaves as costs and latency get worse. A rule set that only works at zero slippage is
reported as exactly that.

## Latency, honestly

The backtester is offline; its latency is throughput, not tick-to-decision. The relevant number
is events per second replayed through the calculators, published the same way as everything
else (percentiles, harness, environment block). The latency model above is what lets a user ask
"what if my execution path were 5 ms slower" and see the answer in the fill prices.

## Product placement

Open-source repository: the engine, the importers, the fixed-tick slippage model, the report.
Obsidian Flow Developer tier: the paid signal adapters plug in exactly as they do on the live
server, so a subscriber backtests against the same iceberg, absorption and node-strength
signals the live server exposes.

## Sequencing

Starts only after steps 1-8 of the order-flow spec are done and step 5's harness exists, because
the harness's replayer is the backtester's input path. Estimated as its own project, not a step
in this one.
