# Obsidian Flow MCP

By The Boy Prodigy (Tarrell Allen) for Obsidian Flow, obsidianflow.tech.

A Model Context Protocol server that exposes market-structure state from NinjaTrader 8 to an
MCP client, and the NinjaTrader 8 AddOn that feeds it.

Apache-2.0.

## Status

**The path this repository exists to provide is proven end to end.** On 4 September 2026, on
NinjaTrader 8.1.8.2, the AddOn published and `scripts/pipe-smoke.mjs` decoded a live session of
ES 09-26 with the same client the MCP server uses: hello, instrument identity, and a continuous
snapshot stream carrying price and a session volume profile, with no framing errors and no drops.
That is a statement about correctness, not speed; the numbers worth quoting arrive with the
harness in build step 5.

**Build step 4 of 10. Transport, instrumentation, instrument identity, and the first computed
state: price, session VWAP and volume profiles.** This repository is structured so that
data can leave the NinjaTrader process without blocking its data thread, and so that a Node
process can decode it. Whether it actually does is a measurement. The AddOn now takes that
measurement of itself - handler durations into a log-linear histogram, allocation counters
sampled every 1024 events, its own frame-serialize time - and publishes it in every snapshot,
in the status window, through the `latency_report` tool and optionally as a CSV dump. The
harness that drives it under stated load, and therefore any number worth quoting, lands in
build step 5. Step 2.5 resolves every configured instrument into an identity record (resolved
name, type, exchange, expiry, tick size, point value, trading hours, roll history) that labels
every frame, and rolls bare futures roots to the new front contract without restarting.
Steps 3 and 4 add the first market computation: on the publisher thread, from the drained ring,
the AddOn keeps a price block, a session VWAP with sigma bands, and session, prior and composite
volume profiles (POC with a deterministic tie-break, 70 % value area, developing checkpoints,
HVN/LVN nodes, a histogram window), serializes them after the instrumentation, and the server
serves them from its cache through four new tools.

What exists today:

- A NinjaTrader 8 AddOn (`addon/`) that subscribes to market data and market depth for the
  configured instruments, copies each event into a blittable struct, pushes it into a
  single-producer/single-consumer ring, and returns. A publisher thread drains the rings into
  the calculators and writes snapshot frames down a named pipe.
- A binary wire format (`schema/wire-v1.md`) with golden files.
- A TypeScript MCP server (`server/`) with seven tools, all answering from an in-process
  cache: `health`, `instruments`, `latency_report` (the AddOn's own in-process handler and
  serializer timings with an environment block from `server/orderflow.config.json`),
  `orderflow_snapshot` (the compact first call), `price_state`, `vwap_state` and
  `volume_profile` (`scope: session | prior | composite`, histogram on request only). Every
  read says it is a conflated snapshot, carries `stalenessMs`, the sequence and the resolved
  instrument identity, and states that the bid/ask split is live-tape-only.

What does not exist yet: book state, DOM dynamics, discrete market events, the benchmark
harness, adapters, and execution. Those are build steps 5 through 10.

No performance number has been measured, and none is published. See
`docs/latency-methodology.md` for how any future number will be reported.

## What is free, and what is not

This repository is the whole server, the whole AddOn, and the wire format. It is not a demo of a
paid product. The paid half is a separate adapter that the open server discovers at runtime; it
is not in this repository and nothing here is disabled without it.

| | This repository (Apache-2.0) | Obsidian Flow Developer tier |
|---|---|---|
| Price and tape state | built | same |
| VWAP with standard-deviation bands | built | same |
| Session volume profile: POC, 70% value area, developing checkpoints, HVN/LVN nodes | built | same |
| Prior-session levels and naked POC | built | same |
| Instrument resolution for any asset class, front-month roll | built | same |
| Handler latency and allocation measurement | built | same |
| Top-of-book summary; full ladder on request | build step 6 | same |
| DOM dynamics: pulling, stacking, potential absorption | build step 6 | same |
| Benchmark harness | build step 5 | same |
| Iceberg and hidden-liquidity scoring | not included | build step 9 |
| Absorption events | not included | build step 9 |
| True Aggression node strength | not included | build step 9 |
| Fixed-range and drawing-tool anchored profiles | not included | build step 9 |
| SuperDOM column values | not included | build step 9 |
| Gated order execution | build step 10 | same |

"built" means it is in this repository today and covered by tests. A build-step number means it is
specified and sequenced but not written yet; the Status section above says where the build is.

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
Node process and connects to `\\.\pipe\obsidian-flow-mcp-v1`. Frames flow one way, from the
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

## Instrument names

The AddOn config (`Documents\NinjaTrader 8\ObsidianFlow.OrderFlowMcp.json`) lists instruments
in any of four shapes, and never assumes futures:

- **fully qualified**, with a contract month, e.g. `ES 12-26` (an example month): used exactly
  as typed and never re-resolved;
- **a root plus a type hint**, e.g. `ES:Future` (the default): resolved as a bare root is
  below, with one addition - if the instrument NinjaTrader returns is not of the named type the
  entry is reported unresolved rather than subscribed to. NinjaTrader's database holds an equity
  with the ticker ES as well as the CME future, and `GetInstrument("ES")` returns the equity, so
  this is the shape to use for a futures root;
- **bare futures root**, e.g. `ES`: resolved to the front contract using
  NinjaTrader's own rollover data, re-checked once a minute and at every session boundary, and
  rolled to the new contract mid-session when it changes. A roll re-announces the instrument
  table on the same connection and emits a `contractRolled` event carrying both identities, so
  history from two contracts is never blended;
- **anything else** - equities, forex, crypto, indexes, CFDs - e.g. `MSFT`, `EURUSD`: resolved
  directly and never re-resolved.

Every resolved instrument carries an identity record (what was typed, resolved name, master
instrument, type, exchange, currency, trading-hours template, expiry, tick size, point value,
roll time and count). The `instruments` tool returns it; the `health` tool reports each config
entry as resolved, unresolved with the AddOn's reason, or rolled at a time. No contract month
is hardcoded anywhere in this repository outside test fixtures and documentation examples.
Details: `addon/README.md`, "Instrument names".

## Running it

### AddOn

See `addon/README.md`. Short version: copy the `.cs` files into
`Documents\NinjaTrader 8\bin\Custom\AddOns\ObsidianFlow.OrderFlowMcp\`, press F5 in the
NinjaScript Editor, then open **New > Obsidian Flow MCP** in the Control Center for the status
window. The AddOn cannot be compiled outside NinjaTrader.

### Server

First time on Windows, follow `docs/windows-setup.md` (installing Node, building, pointing an
MCP client at it). Short version:

```
cd server
npm install
npm run typecheck
npm test
npm run build
npm start
```

### Proving the two halves agree

```
node scripts/pipe-smoke.mjs --seconds 20
```

With NinjaTrader running and no MCP server attached, this connects to the AddOn with the same
client the server uses, prints the hello and the snapshots as they arrive, and exits `PASS` or
`FAIL` with a reason. The test suite checks the decoder against golden files this repository
generated, which says the decoder matches the specification; it says nothing about whether the
publisher does. This is the check that does, and it is the one that needs NinjaTrader.

Off Windows, `scripts/golden-replay.mjs` serves the golden frames over a Unix socket so the check
itself can be run - and is, in CI - without the platform.

The server speaks MCP over stdio. On Windows it connects to the named pipe; set `OF_PIPE_NAME`
to override the name. On Linux and macOS it connects to the Unix socket in `OF_SOCKET_PATH`,
which exists so the server can be tested and run in CI without NinjaTrader.

## Tests

The suite runs on Windows, macOS and Linux. The integration test needs a local endpoint to stand
in for the AddOn: on Windows it opens a named pipe, which is what the AddOn itself uses, and
elsewhere a Unix domain socket in a temp directory. Node cannot listen on a filesystem socket
path on Windows, so a test that hardcodes one fails there with `EACCES` - the endpoint is chosen
per platform for exactly that reason.


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
