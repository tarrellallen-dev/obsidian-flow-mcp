# 0002 - The AddOn does not touch process-wide GC settings

- Status: accepted
- Date: 2026-09-03
- Spec reference: section 2.4

## Context

The usual reflex for latency-sensitive .NET code is to reach for `GCSettings.LatencyMode`,
`GC.TryStartNoGCRegion`, or server GC. Every one of those is process-wide.

## Decision

This AddOn changes no GC setting. Specifically it never calls `GCSettings.LatencyMode`,
`GC.TryStartNoGCRegion`, `GC.EndNoGCRegion`, `GC.AddMemoryPressure`, or `GC.Collect`, and it
ships no runtime configuration that requests server or background GC.

This is a deliberate refusal, recorded here so it is not "fixed" later by someone who reads it as
an oversight.

## Why

The process belongs to NinjaTrader, not to this AddOn. It is shared with the platform's own
threads, the user's charts, indicators, strategies and any other vendor add-on installed
alongside. A process-wide GC change made by one AddOn silently changes the behaviour of all of
them, in ways their authors never tested and the user cannot see. A `TryStartNoGCRegion` that
fails to end, or a latency mode left set after an exception, degrades the platform for the rest
of the session.

The problem this would be reaching for is also the wrong problem. The requirement is that the
data-thread handlers allocate nothing in steady state (spec 2.1). Allocating nothing is solved by
not allocating: blittable structs, preallocated arrays, fixed-capacity rings, no closures, no
boxing, no string formatting, no LINQ on the hot path. That holds regardless of GC mode, and it
is verifiable - the allocation counter is part of the measurement (spec 8, number 2). Tuning the
collector instead would make the allocation invisible rather than absent.

## What is allowed

Reading counters. `GC.GetAllocatedBytesForCurrentThread` is read on the publisher thread, and on
each data thread once every 1024 events into a preallocated slot, to report allocation deltas.
Reading a counter changes nothing for anyone else in the process. It is resolved by reflection
once at startup (`addon/AllocationProbe.cs`) and reports itself as unavailable, rather than as
zero bytes, when the host runtime does not expose it.

## Consequences

- Any collection pause the host process takes, this AddOn takes too, and it will show up in the
  handler histogram's tail rather than being hidden. That is the honest result and it gets
  published with the rest (`docs/latency-methodology.md`).
- Allocation discipline has to be maintained by review and by the counter, not by configuration.
- Reviewers can confirm this decision by grepping `addon/` for `GCSettings`, `TryStartNoGCRegion`
  and `GC.Collect` and finding nothing.
