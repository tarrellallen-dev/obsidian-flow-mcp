# 0003 - Two lanes from one drain: hot (actionable) and archive (raw history)

Status: accepted 2026-09-03. Origin: owner's design direction. Hot lane exists from step 1;
archive lane lands in step 5 with the harness, because the harness replayer is its first reader.

## Decision

The AddOn keeps exactly one hot path (data-thread handlers into the SPSC rings) and exactly one
drain (the publisher thread). From that drain, events fan out into two lanes with different
contracts:

| | Hot lane | Archive lane |
|---|---|---|
| Purpose | What the model or a rule needs *right now* to act | Everything that happened, for backtesting and audit |
| Content | Conflated snapshot at the push rate, discrete events pushed immediately, `actionable` block (below) | Every raw `MdEvent` from every ring, in order, with the same timestamps, plus a copy of every hot-lane frame |
| Transport | Named pipe to the MCP server; in-process cache answers reads | Append-only local store (the backtester's store format, `docs/roadmap/backtester-companion.md`), written by a dedicated archive thread |
| Loss policy | Conflate; latest wins; drops counted in the header | Never conflates; on overflow writes an explicit gap marker (first/last sequence lost) and counts it - a silent hole in history is worse than a marked one |
| Back-pressure | Never waits on anything, including the archive lane | May fall behind; falls behind alone |
| Who reads it | MCP server, execution gate | Backtester, benchmark harness, post-mortems |

## The rule that makes it work

The archive lane can never slow the hot lane. The publisher hands raw events to the archive
thread through a second SPSC ring (publisher is the single producer, archive thread the single
consumer). If the archive ring is full because the disk is slow, the publisher drops the raw
event for the archive, increments the archive-gap counter, and carries on serving the hot
lane. Disk I/O, file rotation and fsync live only on the archive thread.

## What "already has the go-ahead" means concretely

The hot-lane snapshot carries an `actionable` block computed on the publisher thread from
state that is already in memory, so nothing has to be fetched or recomputed at decision time:

- `execution`: enabled, armed, arm expiry, remaining rate budget, and the pre-validated order
  templates built at arm time (account, instrument, quantity cap already checked). A decision
  that passes the gates is a lookup plus a submit, not a validation pass.
- `session`: in-session flag from the trading-hours template, seconds to session close.
- `depth`: live / unavailable, so a rule knows whether book-based reads are trustworthy now.
- `staleness`: the same receive-to-serve figure the reads carry, so a consumer can refuse to
  act on stale state without asking.
- `flags`: the current values of the discrete-event conditions (POC just established, value
  area broken, large pull at best, large stack at best), each with the sequence it was set at.

The paid adapter adds its own signals to this block under the `of_` prefix; the free tier ships
the fields above and the pulling/stacking reads.

## What this is not

It is not a second data subscription and not a second hot path. Both lanes see the same events
in the same order from the same drain, so a backtest replays exactly what the hot lane served
live. Filtering happens after the drain, on the publisher thread, never on the data thread.

## Consequences

- One more thread (archive) and one more ring, both owned by the publisher's lifecycle.
- Frame header gains nothing; the archive gap counter is reported through `health` and the
  store's per-session provenance line.
- Step 5's harness reads the archive lane, which is why the lane ships in step 5 and not before.
- The backtester roadmap note's "recordTo" is this lane.
