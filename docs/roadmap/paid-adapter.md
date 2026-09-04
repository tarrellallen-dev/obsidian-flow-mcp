# Roadmap: the Developer-tier adapter (build step 9, not started)

The open server computes price, VWAP and the session volume profile itself. Everything else the
owner has already built - True Aggression, the oscillator, hidden-liquidity scoring, node strength,
the profile engines - lives in a closed framework assembly. This note records how the adapter
reaches that work without any of it leaking into this repository, and what has to be verified
before the design is settled.

Nothing here is built. This repository must never reference the closed framework; `scripts/
publish-gate.mjs` fails the build if it does, deliberately.

## What the framework already provides

The closed framework publishes a written snapshot contract, and it is close to ideal for an MCP
consumer:

- **Immutable snapshots** with private setters, buildable only through an internal factory.
- **`SnapshotVersion`**, a monotonic counter that advances only when observable state changes -
  never on a cache hit.
- **Lifecycle state**: developing versus final are distinguishable, and an invalid snapshot is
  explicitly invalid rather than a neutral-looking zero. The contract says `IsValid` must be
  checked before trusting anything else.
- **Repeat reads of an unchanged version return the same cached object**, which is tested.
- **Engines are registered, not constructed ad hoc**, and duplicate registration throws.
- **Entitlements already exist** in the framework's licensing layer, so the adapter's gating is a
  question of using what is there, not inventing a second mechanism.

The architecture rule that governs the whole framework - market data is classified once by the
authoritative engine, and consumers read immutable snapshots rather than reclassifying - is the
same rule this server follows. The two designs already agree.

## What the adapter buys, beyond features

1. **One classification pass instead of two.** If the adapter reads already-classified state, the
   AddOn does not re-derive aggression from the same ticks. That is real work removed from the
   publisher thread, and more importantly it makes it impossible for the MCP and the owner's own
   indicators to disagree about the same bar. Two engines that classify independently will
   eventually diverge; one engine cannot.
2. **Version-gated serialisation.** The publisher can hold the last `SnapshotVersion` it emitted
   per engine and, when the version has not moved, write a short "unchanged" marker instead of the
   whole block. On a quiet tick this removes almost all of the serialise cost and shrinks the
   frame. This is a throughput and bandwidth win, not a tick-to-decision win, and it should be
   described that way - the harness will show the difference or it will not be claimed.
3. **Reads become pointer comparisons.** Because an unchanged version returns the same cached
   object, the publisher's read on a quiet tick is a version check, not a rebuild.

## The three risks that decide whether this is easy or hard

1. **Lifecycle mismatch — the one to verify first.** The framework's documented consumption
   patterns require `AddDataSeries(BarsPeriodType.Tick, 1)` and `Calculate.OnEachTick`, and the
   engines read individual trade volume from a hidden one-tick series. That is indicator and
   strategy infrastructure. This AddOn has no `Bars`, no `OnBarUpdate` and no chart. So the open
   question is whether the framework exposes an entry point that accepts raw market-data events,
   or whether the adapter must host a hidden indicator instance backed by a `BarsRequest` series.
   The answer changes the adapter from an afternoon to a redesign. **Read `Api/` and `Developer/`
   before designing anything.**
2. **Not every snapshot is immutable.** The profile domain's snapshot still uses public setters,
   unlike the oscillator domain's. Handing that object across to the publisher thread without
   copying it first is a data race. The adapter copies into its own immutable structure at the
   boundary; it does not pass framework objects through.
3. **UI-assembly isolation is not enforced by a test.** The framework's own limitations document
   says there is no automated check that engines never reference NinjaTrader UI assemblies. An
   engine that touches WPF cannot be driven from the publisher thread. The adapter must verify
   this per engine it consumes rather than assuming it.

Two further facts from the framework's own limitations document, both relevant: automatic
session-boundary detection is not complete in one domain (this server resolves sessions itself, so
the adapter should not depend on the framework for that), and no live NinjaTrader validation had
been performed as of the last hardening pass, so anything the adapter relies on gets validated by
this project rather than assumed.

## The boundary that keeps the open repository open

The open AddOn defines a narrow interface and discovers implementations at runtime from config.
The closed adapter, shipped only to Developer-tier subscribers, implements it against the
framework. Consequences, all intentional:

- This repository compiles and runs standalone, for anyone, with no closed assembly present.
- A subscriber adds one entry to the config and gains the paid signals with no rebuild.
- No paid symbol appears in public source, and the publish gate proves it on every push.
- The adapter's own entitlement check uses the framework's licensing layer, not a second one.

## Sequencing

After the benchmark harness (step 5) and the DOM work (step 6). The harness matters first because
the version-gated serialisation idea above is a performance claim, and this project does not make
performance claims without a harness that a reader can re-run.
