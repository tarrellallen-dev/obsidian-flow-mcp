# Obsidian Flow MCP

By The Boy Prodigy (Tarrell Allen) for Obsidian Flow, obsidianflow.tech.

A Model Context Protocol server that exposes market-structure state from NinjaTrader 8 to an
MCP client, and the NinjaTrader 8 AddOn that feeds it.

Apache-2.0.

## Status

**Build step 2 of 10. Transport and instrumentation.** This repository is structured so that
data can leave the NinjaTrader process without blocking its data thread, and so that a Node
process can decode it. Whether it actually does is a measurement. The AddOn now takes that
measurement of itself - handler durations into a log-linear histogram, allocation counters
sampled every 1024 events, its own frame-serialize time - and publishes it in every snapshot,
in the status window, through the `latency_report` tool and optionally as a CSV dump. The
harness that drives it under stated load, and therefore any number worth quoting, lands in
build step 5. Nothing about the market is computed yet.

What exists today:

- A NinjaTrader 8 AddOn (`addon/`) that subscribes to market data and market depth for the
  configured instruments, copies each event into a blittable struct, pushes it into a
  single-producer/single-consumer ring, and returns. A publisher thread drains the rings,
  **discards the contents**, and writes counter frames down a named pipe.
- A binary wire format (`schema/wire-v1.md`) with golden files.
- A TypeScript MCP server (`server/`) with three tools, `health`, `instruments` and
  `latency_report` (build step 2; the AddOn's own in-process handler and serializer timings with
  an environment block from `server/orderflow.config.json`), all answering
  from an in-process cache.

What does not exist yet: price state, VWAP, volume profile, book state, DOM dynamics, events,
the benchmark harness, adapters, and execution. Those are build steps 3 through 10.

No performance number has been measured, and none is published. See
`docs/latency-methodology.md` for how any future number will be reported.

## Layout

```
addon/    C# source for the NinjaTrader 8 AddOn (.NET Framework 4.8)
server/   TypeScript MCP server (Node 20+, ESM, strict)
schema/   wire-v1.md, golden files, and the reference encoder that generates them
bench/    placeholder; benchmark harness lands at build step 5
docs/     decisions/ (ADRs) and the latency methodology
```

## How the pieces fit

The AddOn runs inside NinjaTrader and owns one publisher thread. The server runs as a separate
Node process and connects to `\\.\pipe\obsidianflow-orderflow-v1`. Frames flow one way, from the
AddOn to the server. The server keeps the last frame per instrument in memory; MCP tools read
that cache and never wait on I/O.

Staleness is reported as two numbers that are never added together silently: `receiveToServeMs`
is measured on the server's own monotonic clock, and `oneWayEstimateMs` is an estimate of the
AddOn-to-server hop derived from heartbeat cadence - a lower bound on jitter, null until two
heartbeats have arrived. The two processes share no clock epoch, so no exact end-to-end frame age
exists. See the "Staleness" section of `schema/wire-v1.md`.

Every cached instrument carries a freshness value:

- `live` - a frame arrived recently
- `stale` - the link is up but the last frame is older than the staleness threshold
- `reconnecting` - the link dropped and the AddOn has not yet re-announced its instruments

Instrument indices are valid only for the connection that announced them, so on every reconnect
the server discards the table and waits for a fresh hello.

## Running it

### AddOn

See `addon/README.md`. Short version: copy the `.cs` files into
`Documents\NinjaTrader 8\bin\Custom\AddOns\ObsidianFlow.OrderFlowMcp\`, press F5 in the
NinjaScript Editor, then open **New > Obsidian Flow MCP** in the Control Center for the status
window. The AddOn cannot be compiled outside NinjaTrader.

### Server

```
cd server
npm install
npm run typecheck
npm test
npm run build
npm start
```

The server speaks MCP over stdio. On Windows it connects to the named pipe; set `OF_PIPE_NAME`
to override the name. On Linux and macOS it connects to the Unix socket in `OF_SOCKET_PATH`,
which exists so the server can be tested and run in CI without NinjaTrader.

## Tests

`server/test/` covers the decoder against the golden files, the frame splitter against random
chunk boundaries, the cache's staleness and reconnect semantics, and an end-to-end run against a
fake publisher on a Unix socket.

The AddOn has no tests in this repository; it compiles and runs only inside NinjaTrader.

## Non-negotiables

Carried from the specification, and load-bearing for anything added later:

1. The NinjaTrader data-thread handlers copy the event into a struct, push it into a ring, and
   return. The handler body contains no calculation, I/O, lock statement, heap allocation,
   logging, string formatting, LINQ or closure; this describes what the code is, and what it
   costs is measured by the step-5 harness, not asserted here.
2. IPC stays out of the read path. Tools answer from memory.
3. Conflate, never queue. Latest wins; drops are counted and reported, not hidden.
4. No process-wide GC settings are changed. See `docs/decisions/0002-no-gc-tampering.md`.
5. No raw book by default, and `depth: unavailable` is reported with a reason rather than as an
   empty ladder.
6. No performance claims. Measurements ship with their harness and environment block, or they do
   not ship.

## Roadmap

A companion backtester that replays recorded frames through the same calculators, with explicit
fee, slippage and latency models, is planned as a separate repository after the server is proven.
It ships with no market data; users record frames with this AddOn or import their own history.
Design note: `docs/roadmap/backtester-companion.md`.

## Licence

Apache License 2.0. See `LICENSE`.

NinjaTrader is a trademark of NinjaTrader Group, LLC. This project is not affiliated with,
endorsed by, or supported by NinjaTrader.
