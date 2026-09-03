# Wire protocol v1

The hop between the NinjaTrader AddOn (publisher) and the MCP server (client). Length-prefixed
binary frames over a named pipe on Windows, or a Unix domain socket in tests and CI.

All integers are **little-endian**. All floats are IEEE-754 binary64, little-endian. Strings are
ASCII, length-prefixed, never NUL-terminated.

Schema version is **1**. This document is the source of truth; `server/src/wire/decoder.ts` mirrors
it and `schema/golden/*.bin` pin it.

## Frame

```
offset  size  type   field
0       4     u32    length        bytes following this field (header + payload)
4       2     u16    type          1 snapshot, 2 event, 3 hello, 4 heartbeat,
                                   16 exec request, 17 exec reply
6       2     u16    version       schema version, currently 1
8       4     u32    sequence      per-connection, monotonic, starts at 0, wraps at 2^32
12      4     u32    ringEventsDropped  market events the AddOn's rings dropped (ring full,
                                   drop-newest) since the last frame; NOT a count of dropped
                                   snapshots. Snapshots are conflated, never queued, so no
                                   snapshot is ever "dropped": the newest state simply replaces
                                   the previous one. Spec 3.3 calls this field "dropped"; the
                                   value it has always carried is the ring drop sum.
16      8     i64    sentTicks     Stopwatch ticks at serialize time (staleness reference)
24      8     i64    wallUtc       DateTime.UtcNow ticks
32      2     u16    instrument    index into the hello frame's instrument table,
                                   0xFFFF when the frame is not instrument-scoped
34      2     u16    reserved      always 0
36      ...          payload       type-specific, fixed layout
```

Header size after the length field is **32 bytes**. Total frame size on the wire is
`4 + length`, and `length == 32 + payloadBytes`.

`sentTicks` is in the publisher's `Stopwatch` frequency, which the hello frame supplies as
`stopwatchFrequency`; the client reads it from there and must never assume 10 MHz. Knowing the
frequency makes *differences* between `sentTicks` values convertible to seconds, and nothing
more: the two clocks share no epoch, so a single `sentTicks` value cannot be placed on the
client's clock. Measured staleness is therefore computed from the client's own receive time, and
any publisher-to-client figure is an estimate, labelled as one (see "Staleness" below).
`wallUtc` is .NET ticks (100 ns units since 0001-01-01 UTC); the Unix-epoch offset is
621355968000000000.

`maxFrameBytes` = **1048576** (1 MiB). A frame whose `length` field exceeds `maxFrameBytes - 4`
is a protocol violation, not a large frame: the client drops the connection and reconnects. The
publisher treats the same condition as a bug and throws rather than truncating.

## Frame types in build steps 1 and 2

Steps 1 and 2 emit types 3, 4 and 1 only. Types 2, 16 and 17 are reserved here and defined in a later
revision of this document.

### type 3 - hello

Sent once, immediately after a client connects, before any other frame. `instrument` is `0xFFFF`.
The instrument table is valid **only for that connection**.

```
offset  size  type   field
+0      8     u64    stopwatchFrequency  publisher Stopwatch.Frequency, ticks per second
+8      2     u16    count               number of instrument entries
```

then `count` entries, packed with no padding:

```
+0      2     u16    index             the value that appears in a frame header's instrument field
+2      1     u8     nameLen           bytes of ASCII name, 0..255
+3      n     ascii  name              instrument name, exactly nameLen bytes
+3+n    8     f64    tickSize
+11+n   8     f64    pointValue
```

Entry size is `19 + nameLen`. Payload size is `10 + sum(19 + nameLen)`.

`stopwatchFrequency` is what makes `sentTicks` interpretable. It is not assumed to be 10 MHz and
it differs between machines. A client that has it can convert a difference of two `sentTicks`
values into seconds; it still cannot convert a single `sentTicks` value into its own clock,
because the two clocks share no epoch and this hop is not clock-synchronised. See "Staleness"
below for what may and may not be reported.

## Staleness

Two different numbers, never conflated:

- **receiveToServeMs** - measured, exact. From the client's own monotonic clock at the moment the
  frame was decoded, to the moment a tool answered. This is the number spec section 2.2 calls
  staleness at service time.
- **oneWayEstimateMs** - an *estimate*, labelled as one, of the publisher-to-client hop. It is
  derived from the observed heartbeat cadence: the publisher emits heartbeats on a fixed 1000 ms
  `Stopwatch` schedule, so the difference between consecutive receive times and the corresponding
  `sentTicks` difference (scaled by `stopwatchFrequency`) exposes the variable part of the
  transport delay. It cannot recover the constant offset, so it is a lower bound on jitter, not a
  measurement of one-way latency, and it is null until at least two heartbeats have arrived.

Total age of a frame at service time is `receiveToServeMs + oneWayEstimateMs` and must be
presented with both terms visible. A single combined number that hides which half was measured
does not ship.

### type 4 - heartbeat

Empty payload (`length == 32`). `instrument` is `0xFFFF`. Sent every 1000 ms while a client is
connected. A client that has seen no frame of any type for several heartbeat intervals should
treat the connection as dead and reconnect.

### type 1 - snapshot

`instrument` is the instrument's index from the hello table. One snapshot per instrument per
push interval (`pushRateHz`, default 100).

The payload has grown additively: build step 1 defined the first 24 bytes, build step 2 appends
136 bytes of instrumentation after them without moving anything. The schema version stays 1.
A decoder accepts **either** size and reports the step-2 block as absent when the payload is
24 bytes long; any other size is a protocol violation.

#### step-1 block (offsets +0 .. +23)

```
offset  size  type   field
+0      8     u64    eventsDrained                 events drained from all rings since AddOn start
+8      8     u64    bytesAllocatedOnPublisher     GC.GetAllocatedBytesForCurrentThread delta on
                                                   the publisher thread since its first frame
                                                   (0 when the counter is unavailable; kept for
                                                   step-1 compatibility, superseded by +104)
+16     8     u64    handlerSamples                handler duration samples recorded for this
                                                   instrument since AddOn start (data + depth)
```

#### step-2 block (offsets +24 .. +159)

All latency figures are **nanoseconds**, measured by the AddOn on its own threads with
`Stopwatch` and quantised by a log-linear histogram to two significant digits (highest value
of the bucket; `max` fields are exact). They are the AddOn's own in-process measurements of
its handlers and its serializer, not end-to-end figures. Percentiles are recomputed at most
once per second on the publisher thread, so consecutive snapshots within the same second carry
identical values.

`u32` nanosecond fields reserve **0xFFFFFFFF (4294967295) for "unavailable"**: the histogram
behind the figure is empty (no events yet on that handler, no frames yet for the serializer).
A decoder reports it as null, never as 0 ns. Measured values saturate at 4294967294.

Allocation figures are `i64` and use **-1 to mean "not measured"**: the host runtime does not
expose `GC.GetAllocatedBytesForCurrentThread`, or the probe has not run on that thread yet
(totals need one probe, per-1024 figures need two). A value of 0 always means "measured, zero
bytes". Per-1024 figures are the bytes allocated over the most recent 1024 events on that
handler's thread (the probe runs once per 1024 events); totals are since the thread's first
probe. The counter is **thread-wide**: it counts every allocation on the thread NinjaTrader
raises that handler on, including NinjaTrader's own, and two instruments whose handlers share
a thread report the same number twice. It is a bound on the handler's allocation, not an
attribution to it.

```
offset  size  type   field
+24     4     u32    dataP50Ns                     MarketData handler duration, p50
+28     4     u32    dataP99Ns                     ... p99
+32     4     u32    dataP999Ns                    ... p99.9
+36     4     u32    dataMaxNs                     ... max, exact
+40     8     u64    dataSampleCount               samples in the MarketData histogram
+48     4     u32    depthP50Ns                    MarketDepth handler duration, p50
+52     4     u32    depthP99Ns                    ... p99
+56     4     u32    depthP999Ns                   ... p99.9
+60     4     u32    depthMaxNs                    ... max, exact
+64     8     u64    depthSampleCount              samples in the MarketDepth histogram
+72     8     i64    dataAllocBytesPer1024         MarketData thread, bytes over the last 1024 events
+80     8     i64    dataAllocBytesTotal           MarketData thread, bytes since first probe
+88     8     i64    depthAllocBytesPer1024        MarketDepth thread, bytes over the last 1024 events
+96     8     i64    depthAllocBytesTotal          MarketDepth thread, bytes since first probe
+104    8     i64    publisherAllocBytesTotal      publisher thread, bytes since its first frame
+112    4     u32    serializeP50Ns                publisher frame-serialize time, p50
+116    4     u32    serializeP99Ns                ... p99
+120    4     u32    serializeP999Ns               ... p99.9
+124    4     u32    serializeMaxNs                ... max, exact
+128    8     u64    serializeSampleCount          frames timed (all instruments; one histogram)
+136    8     u64    stopwatchFrequency            publisher Stopwatch.Frequency, same value as
                                                   in the hello frame, repeated so a snapshot
                                                   can be interpreted on its own in a log
+144    8     u64    ringDropsTotal                events dropped by this instrument's two rings
                                                   since AddOn start (producer-side, ring full)
+152    8     u64    sampleOverrunsTotal           handler duration samples the publisher failed
                                                   to read before the sample ring overwrote
                                                   them; nonzero means the histograms undercount
```

Step-1 payload is 24 bytes (`length` 56, frame 60). Step-2 payload is **160 bytes**
(`length` 192, frame 196).

The publisher serialize timer runs from the start of payload serialization to the moment the
bytes are handed to the pipe; the pipe write itself is not inside it. The MarketData and
MarketDepth timers run from handler entry to just after the ring push. Neither includes any
NinjaTrader-side time before the handler is entered, the pipe transit, decoding on the
server, or the MCP hop; those are not measured in build step 2.

Step 2 computes no market state either. This payload grows in later steps; the header does not.

## Framing and reconnect

- The transport is a **byte stream**, not a message stream. The client must handle a frame split
  across reads and several frames coalesced into one read. Read `length`, wait for `4 + length`
  bytes, then decode.
- On every connect and reconnect the client marks all cached instruments
  `stale: "reconnecting"` and **ignores every frame until a fresh hello arrives**. The instrument
  table from a previous connection is discarded; indices are not stable across connections.
- `sequence` restarts at 0 on each connection. A sequence that goes backwards without an
  intervening hello is a protocol violation.
- The client reconnects with jittered backoff. The publisher accepts one client at a time and
  returns to waiting when it disconnects; a pipe error never kills the publisher thread.

## Golden files

`schema/golden/` holds byte-exact frames produced by `schema/tools/gen-golden.mjs`, which
contains an independent reference encoder written from this document. The TypeScript decoder is
tested against them so a layout change cannot pass silently.

| File | Contents |
|---|---|
| `hello.bin` | hello, 2 instruments |
| `hello-empty.bin` | hello, 0 instruments |
| `heartbeat.bin` | heartbeat, empty payload |
| `snapshot.bin` | step-1 snapshot (24-byte payload) for instrument index 1; still valid, still decoded |
| `snapshot-step2.bin` | step-2 snapshot (160-byte payload) for instrument index 1 |
| `snapshot-step2-unavailable.bin` | step-2 snapshot whose allocation fields are all -1 |
| `stream.bin` | hello + heartbeat + 2 step-1 snapshots concatenated, for the splitter test |
| `stream-step2.bin` | hello + heartbeat + step-2 snapshot + step-1 snapshot, mixed sizes |
