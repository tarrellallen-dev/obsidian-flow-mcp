# 0004 - No shared memory for a NinjaScript strategy reader

Status: accepted 2026-09-04. Supersedes nothing; it extends ADR 0001, which rejected shared memory
for the LLM path. This one answers a different question and reaches the same answer for a different
reason.

## The question

A second consumer was proposed: a NinjaTrader strategy reading computed state on every tick. The
argument for shared memory was sound in form - ADR 0001 rejected it because 150x of a few
microseconds is a rounding error against a model round-trip, and that arithmetic genuinely does not
apply to a reader running at market-data rate. Different consumer, different budget.

The argument fails on a fact about where that reader runs.

## A NinjaScript strategy is in our own AppDomain

NinjaTrader compiles every custom script - indicators, strategies, AddOns - into one assembly,
`NinjaTrader.Custom.dll`, loaded into the NinjaTrader process. Our AddOn and any strategy the owner
writes are therefore objects in the same process and the same AppDomain, able to hold references to
each other directly.

Shared memory between two objects in one AppDomain is a memory-mapped file mapped into the process
twice. Against a reference read it is slower, not faster, and it adds a seqlock, an ABI version, an
event handle, a retry loop, and a torn-read failure mode that a reference read cannot have at all.

The right mechanism in-process is the one the owner's own framework already uses: the publisher
builds an immutable snapshot and swaps it into a field with a single `Volatile.Write`; a consumer
takes it with a single `Volatile.Read`. Reference assignment is atomic on .NET, so there is no
tearing to defend against and no sequence number to check. The consumer holds a coherent object or
it holds the previous coherent object, and never a mixture. That framework's own architecture note
says the same thing in its own words: market data is classified once by the authoritative engine,
and consumers read immutable snapshots rather than recomputing.

Cost, honestly: a pointer read versus a mapped read plus a seqlock validation and a possible retry.
The publisher allocates one snapshot object per push - roughly a hundred a second at the default
rate, which is nothing, and can be driven to zero with a two-slot buffer if a measurement ever says
it matters. No measurement says so today.

## A second reason, independent of the first

The proposed frame mixed cadences. `last_price`, `cumulative_delta` and top-of-book sizes update per
tick. `poc_price_ticks`, `value_area_high` and `value_area_low` change a few times a second at most,
because the session profile is recomputed on the publisher's push clock. Putting session-profile
values behind a cache-line-aligned seqlock invites the obvious question - why did a value that
changes twice a second need lock-free infrastructure - and there is no good answer. The addendum
that proposed the frame warns against exactly this failure mode; the layout it suggested commits it.

## What we do instead

The AddOn exposes its computed state to in-process consumers through a published immutable snapshot,
reachable from a strategy without any IPC. This is step 9 work, arriving with the adapter interface,
and it is the same seam the paid adapter uses. One publisher, one snapshot type, two ways to read it:
directly in-process, or serialised down the pipe for the MCP server.

## What would revive shared memory

A genuinely cross-process consumer: an execution engine in its own process, a second NinjaTrader
instance, or an external application. That reader cannot hold a reference, IPC becomes unavoidable,
and the arithmetic that failed above starts to hold. If that consumer appears, the discipline in the
proposal is worth keeping wholesale - compile-time layout assertions on both sides with every field
offset checked, a real seqlock rather than separate interlocked writes, a bounded retry that degrades
to a stale flag instead of spinning, allocation-free reads gated in CI, event signalling rather than
sleeping, a versioned ABI checked at attach, and no thread-priority or GC tuning inside a process we
do not own. Those are all correct. They are simply solving a problem we do not have while the reader
lives in our own AppDomain.

## For the README

Both rejections are worth stating, because they are the same judgement applied twice with different
inputs: shared memory was declined for the LLM path because the gain is a rounding error against a
model round-trip, and declined for the strategy path because the reader is in our own process and a
reference read is both faster and simpler. Neither sentence is "we used the fast thing."
