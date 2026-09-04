# Keeping framing and envelope extractable (assessment, 2026-09-03)

A second repository is planned that needs the same wire discipline: a generic Chrome extension to
desktop bridge (MV3 extension -> Native Messaging host -> local process). It is not started, and
it does not change this project's build order. This note records where the seam currently sits, so
extraction later is a copy rather than surgery, and so nobody restructures this repo for a repo
that does not exist yet.

## What is already generic

`server/src/transport/frameSplitter.ts` contains zero domain references. It imports three
constants (`LENGTH_PREFIX_BYTES`, `MAX_FRAME_BYTES`, `WireError`) and does one thing: split a byte
stream into length-prefixed frames, draining the buffer in a loop so that two frames arriving in a
single chunk both surface immediately and a frame split across chunks is held until complete. That
loop, and its tests, are the part worth sharing. Keep it free of domain knowledge.

`server/src/transport/pipeClient.ts` couples to the domain only by calling `decodeFrame`. Passing
the decode function in would make it transport-generic; that is a small change and is not worth
making until there is a second consumer.

## What is NOT generic, deliberately

The 32-byte header is not a neutral envelope. Alongside length, type, version and sequence it
carries `instrument` (a u16 index into the hello frame's table) and `sentTicks` (a .NET
`Stopwatch` reading, meaningless without the `stopwatchFrequency` in hello). Both are there
because the publisher serialises into a preallocated buffer with no allocation, and hoisting them
out would cost a second write or a second buffer on the hot path.

A browser bridge needs neither field. Forcing one envelope across a market-data pipe and a
browser bridge would make both worse. So the sharing boundary is: **the splitter and its drain
loop are shared; the envelope is not.** Each repo keeps a header shaped for its own payloads.

## The one thing to keep doing here

C# framing (`EmitFrame`, `PutU16/PutU32/PutI64`) currently lives inside `Publisher.cs`. When that
file is next touched for real work, move those helpers into their own file. They have no publisher
state and no market knowledge; separating them costs nothing now and makes the C# side of any
future extraction a file copy.

Verdict: extraction of the shared part is an afternoon, not a weekend, and no change to this
repository is required to keep it that way.
