# 0001 - Named pipe, not shared memory, for the AddOn to server hop

- Status: accepted
- Date: 2026-09-03
- Spec reference: section 3.3

## Context

The AddOn runs inside the NinjaTrader 8 process (Windows, .NET Framework 4.8). The MCP server
runs as a separate Node process. State has to cross that boundary. Two candidates: a named pipe
carrying length-prefixed binary frames, or a shared-memory ring with a seqlock.

## Decision

v1 uses a named pipe (`\\.\pipe\obsidianflow-orderflow-v1`) carrying fixed-layout,
length-prefixed, little-endian binary frames. Off Windows the same frames run over a Unix domain
socket, used for tests and CI only.

## Why not shared memory

Shared memory would remove the pipe copy and the kernel transition. That is a design-level
expectation of a large relative difference on this hop - it has not been measured, and it is not
claimed. It does not matter here, because the number that matters is *staleness at service time*
(spec 2.2), and the dominant term in any model interaction is the model round trip. A saving on
this hop is a rounding error against that.

What shared memory costs is concrete:

- a seqlock, written correctly, with a memory model argued rather than assumed;
- an explicit ABI with its own versioning, separate from the frame schema;
- a native Node addon, which turns a `npm install` into a toolchain requirement and makes the
  server harder to run, review and audit;
- a signalling mechanism, because a spin-reading consumer is not acceptable in a process that
  shares a machine with NinjaTrader.

The pipe needs none of that, and a byte stream is trivially replayable: a recorded frame log is
both a test fixture and the input to the server-side benchmark.

## Consequences

- The wire layout is a first-class artefact (`schema/wire-v1.md`) with golden files, because it
  is now the contract rather than a struct definition shared by construction.
- The client must handle partial reads and coalesced frames. That lives in exactly one place,
  `server/src/transport/frameSplitter.ts`, and is fuzzed.
- Serialization must not allocate per frame on the publisher thread; the publisher writes
  little-endian primitives by hand into one preallocated buffer.
- Reversing this decision means changing one transport module and one AddOn class. Nothing above
  the decoder knows how the bytes arrived.
