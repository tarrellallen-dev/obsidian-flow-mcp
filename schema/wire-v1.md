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

## Frame types in build steps 1, 2, 2.5 and 3

Steps 1 and 2 emit types 3, 4 and 1. Step 2.5 adds type 2 (event) with one event kind,
`contractRolled`, and extends the hello additively. Step 3 extends the snapshot additively with
the variable-length market block (price, VWAP, coverage, three volume profiles). Types 16 and 17
are reserved here and defined in a later revision of this document.

Instrument names in this document and in the golden files (for example `ES 12-26`) are
**examples**; the AddOn never hardcodes a contract month and the config default is a bare
root (see `addon/README.md`, "Instrument names").

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

Entry size is `19 + nameLen`. The base table is `10 + sum(19 + nameLen)` bytes.

`name` is the **resolved** NinjaTrader name (`Instrument.FullName`), never what the user typed.

#### identity section (step 2.5, additive)

Immediately after the last base entry. A step-1/step-2 publisher ends the payload there; a
decoder that finds the payload ending exactly after the base table reports every identity as
absent and the unresolved list as empty. Otherwise:

```
offset  size  type   field
+0      2     u16    identityCount     must equal count
```

then `identityCount` entries, in the same order as the base table:

```
+0      2     u16    index             same value as the base entry it describes
+2      ...          identity block    see "identity block" below
```

then:

```
+0      2     u16    unresolvedCount   config entries that produced no subscription
```

then `unresolvedCount` entries of two ASCII strings, each u8-length-prefixed:

```
+0      1+n   str    typed             the config entry as written
+1+n    1+m   str    reason            why it did not resolve or subscribe
```

Unresolved entries have no index and never appear in a frame header. Nothing may follow the
last unresolved entry.

#### identity block

The fingerprint of one subscription, produced once when the instrument was resolved (and once
more per roll). Identical layout in the hello identity section and in the `contractRolled`
event. Strings are ASCII with a u8 length (0..255); a string the AddOn could not fill is
present with length 0. Sizes below are for zero-length strings; each string adds its length.

```
offset  size  type   field
+0      1     u8     shape             1 fullyQualified (typed with a contract month, used as-is,
                                       never re-resolved), 2 root (bare futures root, resolved
                                       to the front contract, re-checked for rolls), 3 direct
                                       (non-futures symbol, resolved as typed, never re-resolved)
+1      1     u8     resolvedBy        1 asTyped (GetInstrument returned the instrument used),
                                       2 nt8Default (GetInstrument(root) returned a live
                                       contract chosen by NinjaTrader), 3 rolloverTable
                                       (NinjaTrader's rollover table named the current
                                       contract), 4 nextExpiry (MasterInstrument.GetNextExpiry
                                       named the nearest live contract)
+2      1+n   str    resolvedFrom      the config entry exactly as typed (trimmed)
+3      1+n   str    fullName          Instrument.FullName, the same value as the base entry's name
+4      1+n   str    masterName        MasterInstrument.Name, e.g. the root of a futures product
+5      1+n   str    instrumentType    MasterInstrument.InstrumentType as its enum name
                                       (Future, Stock, Index, Forex, CryptoCurrency, ...)
+6      1+n   str    exchange          Instrument.Exchange enum name
+7      1+n   str    currency          MasterInstrument.Currency enum name
+8      1+n   str    tradingHours      trading-hours template name
+9      8     i64    expiryTicks       .NET ticks of the expiry date (calendar date, no time
                                       zone; 00:00 of that day). 0 = the instrument does not
                                       expire (everything that is not a future or option)
+17     8     f64    tickSize          same value as the base entry
+25     8     f64    pointValue        same value as the base entry
+33     8     i64    rolledAtUtc       DateTime.UtcNow ticks of the last roll of this config
                                       entry in this AddOn process; 0 = never rolled
+41     2     u16    rollCount         rolls of this config entry in this AddOn process
```

Fixed part is 43 bytes; with seven strings the block is `43 + sum(stringLen)` bytes.

An instrument is identified unambiguously by `fullName` together with `masterName`,
`instrumentType`, `exchange` and `expiryTicks`; a consumer that stores history labels it with
the whole block, and when `rollCount` changes between two hellos for the same `resolvedFrom`
the two contracts are different series.

#### re-announcement

A hello may arrive again **on the same connection**, after a `contractRolled` event's cause.
Indices are unchanged; the identity at the rolled index is replaced. The client must
re-validate its table against the new hello: an index that is absent from the new table is
dropped, an index whose `fullName` changed starts a new series (its cached snapshot is
discarded, never merged with the previous contract's), and an unchanged index keeps its state.
The re-announced hello goes out **before** the `contractRolled` event and before any snapshot
of the new contract.

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

### type 2 - event

Discrete events (spec section 5) that bypass the snapshot rate limit. `instrument` is the
index the event concerns, or `0xFFFF` for process-wide events.

```
offset  size  type   field
+0      2     u16    eventKind         1 contractRolled; other values reserved
+2      2     u16    reserved          always 0
+4      ...          body              per eventKind
```

A decoder keeps an unknown `eventKind` as opaque rather than rejecting the frame.

#### eventKind 1 - contractRolled

Sent once per roll, right after the re-announced hello, before any snapshot of the new
contract under that index. Only instruments whose config entry was a bare root ever roll.

```
offset  size  type   field
+4      8     i64    rolledAtUtc       DateTime.UtcNow ticks of the roll; equals the new
                                       identity's rolledAtUtc
+12     ...          previous          identity block of the contract that was unsubscribed
+...    ...          next              identity block of the contract now subscribed
```

The frame header's `sequence` is the boundary: every frame for this index with a lower
sequence on this connection belongs to `previous`, every higher one to `next`. Contract-specific
state accumulated by the AddOn for that index (rings, counters, sample positions) was reset at
the roll; the handler latency histograms, which measure code and not the contract, were kept.

### type 1 - snapshot

`instrument` is the instrument's index from the hello table. One snapshot per instrument per
push interval (`pushRateHz`, default 100).

The payload has grown additively: build step 1 defined the first 24 bytes, build step 2 appends
136 bytes of instrumentation after them without moving anything, and build step 3 appends a
variable-length market block after +160. The schema version stays 1. A decoder accepts a
24-byte payload (step-2 block and market block absent), a 160-byte payload (market block
absent), or a payload of at least 164 bytes whose `marketBytes` field at +160 ends it exactly;
any other size is a protocol violation.

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

Step 2 computes no market state. Step 3 does; its block follows. The header does not grow.

#### step-3 block (offsets +160 ..; variable length)

The computed state of spec section 4: `price`, `vwap`, `coverage` and three `profile` records
(session, prior, composite). All of it is computed on the AddOn's publisher thread from the
drained ring, on the instrument's trading-hours session, and serialized into the same buffer as
the rest of the frame. Doubles that are not known are **NaN on the wire** (a decoder reports
them as null, never as 0). .NET UTC ticks use 0 for "none". Layout:

```
offset  size  type   field
+160    4     u32    marketBytes         bytes after this field; 164 + marketBytes == payload length
+164    2     u16    marketVersion       1
+166    2     u16    marketFlags         bit0 sessionKnown (trading-hours template answered),
                                         bit1 inSession (now within [sessionBegin, sessionEnd)),
                                         bit2 hasBidAsk (both sides of the book known),
                                         bit3 bidAskSplitPresent (session profile holds tape volume)
```

price block, 120 bytes:

```
+168    8     f64    last                last trade price (NaN before the first print)
+176    8     i64    lastSize
+184    1     u8     lastAggressor       0 none (no print, or bid/ask unknown when it printed),
                                         1 bid (print at or below the bid), 2 ask (print at or
                                         above the ask), 3 between (inside the spread)
+185    1     u8     reserved
+186    2     u16    reserved
+188    4     i32    spreadTicks         (ask - bid) / tickSize rounded; -1 when unknown
+192    8     f64    bid
+200    8     f64    ask
+208    8     f64    sessionOpen         first price of the session (history bar open or first print)
+216    8     f64    sessionHigh
+224    8     f64    sessionLow
+232    8     u64    sessionVolume       history bars folded in plus tape, this session
+240    8     u64    tapeVolume          prints this AddOn saw itself, this session
+248    8     u64    tradeCount          prints this session
+256    8     f64    tickSize            MasterInstrument.TickSize
+264    8     f64    pointValue          MasterInstrument.PointValue
+272    8     i64    sessionBeginUtc     .NET UTC ticks; 0 while the session is unknown
+280    8     i64    sessionEndUtc
```

vwap block, 68 bytes:

```
+288    8     f64    vwap                volume-weighted mean of print price this session
+296    8     f64    stdDev              sqrt of the volume-weighted Welford variance
+304    8     f64    sd1Upper            vwap + 1 sd
+312    8     f64    sd1Lower
+320    8     f64    sd2Upper
+328    8     f64    sd2Lower
+336    8     f64    priceVsVwapTicks    (last - vwap) / tickSize
+344    8     u64    vwapVolume          weight behind the figure
+352    1     u8     vwapIncludesHistory 1 when BarsRequest bars before attach were folded in at
                                         typical price (high + low + close) / 3, so that portion
                                         is a bar approximation
+353    1     u8     reserved
+354    2     u16    reserved
```

coverage block, 28 bytes plus one string:

```
+356    1     u8     historyState        0 disabled (config historyBars = none), 1 pending,
                                         2 loaded, 3 failed, 4 notRequested (session bounds not
                                         known yet)
+357    1     u8     historyResolution   0 none, 1 minuteSpread (1-minute bars, each bar's volume
                                         spread evenly over the ticks from its low to its high,
                                         integer remainder to the close), 2 tick (1-tick bars,
                                         one level per bar at its close)
+358    2     u16    reserved
+360    8     i64    historyFromUtc      open of the first history bar folded in; 0 = no history
+368    8     i64    historyToUtc        close of the last history bar folded in
+376    8     i64    tapeFromUtc         time of the first print this session; 0 = none yet.
                                         The bid/ask split exists from here forward and never
                                         before
+384    1+n   str    historyError        reason when historyState is 3, else empty
```

Bars whose close falls after the first print are not folded in, so history and tape never
overlap; the gap between `historyToUtc` and `tapeFromUtc` (under one bar) is uncovered and
reported as such by the two figures.

then three **profile records**, in order: `session`, `prior`, `composite`.

#### profile record

```
offset  size  type   field
+0      1     u8     available           0 = nothing here (every field below is a placeholder:
                                         NaN doubles, 0 counts)
+1      1     u8     flags               bit0 hasBidAskSplit (tape volume present; always 0 for
                                         prior), bit1 includesHistory (BarsRequest bars folded
                                         in), bit2 nakedPoc (prior only: the current session has
                                         not traded through the prior POC, i.e. it lies outside
                                         [sessionLow, sessionHigh]), bit3 outOfRange (some volume
                                         fell outside the price array and is counted in
                                         outOfRangeVolume only), bit4 priorFromLive (prior only:
                                         promoted from a session the AddOn watched whole, rather
                                         than rebuilt from bars)
+2      2     u16    reserved
+4      8     f64    poc
+12     8     f64    vah
+20     8     f64    val
+28     8     u64    totalVolume         in-range volume
+36     8     u64    pocVolume
+44     8     u64    valueAreaVolume
+52     8     u64    outOfRangeVolume
+60     8     u64    tapeVolume
+68     8     f64    rangeLow            lowest occupied level
+76     8     f64    rangeHigh
+84     2     u16    nodeCount
+86     28*n         nodes               f64 price, f64 strength (0..1), u64 volume, u8 kind
                                         (1 hvn, 2 lvn), u8 reserved, u16 reserved; ordered by price
        2     u16    checkpointCount     session record only; 0 for prior and composite
        32*n         checkpoints         i64 atUtc, f64 poc, f64 vah, f64 val: the developing
                                         POC/VAH/VAL as they stood at each fixed-time checkpoint
                                         (config checkpointMinutes from the session open,
                                         default 30; at most 48)
        2     u16    histogramCount      at most config histogramLevels (default 64) levels
                                         starting floor(levels / 2) below the POC, clipped to
                                         the occupied range; 0 for prior
        40*n         levels              f64 price, u64 volume, u64 tapeVolume, u64 bidVolume,
                                         u64 askVolume
```

Per level, `volume - tapeVolume` is the history share and has no split; `bidVolume` and
`askVolume` are tape only, and `tapeVolume - bidVolume - askVolume` is tape inside the spread.
A consumer must present bid/ask as unavailable for a level with `tapeVolume` 0.

The profile maths, identical in `addon/SessionVolumeProfile.cs` and its reference port
`server/src/profile/volumeProfile.ts` (pinned by `server/test/volumeProfile.test.ts` against
hand-computed values):

- Levels are indexed by `(price - anchor) / tickSize`; the first price of a session anchors the
  array (config `profileLevels`, default 8192) at its centre. Prices outside the array are added
  to `outOfRangeVolume` and nowhere else.
- **POC** is the level with the most volume. On a tie the level nearer the session VWAP *at the
  moment the tie arose* wins; with the VWAP unknown, or at equal distance, the lower price wins.
  Ties are settled as they happen, so the POC is a pure function of the event order.
- **Value area** is 70 % of in-range volume grown from the POC one level at a time: whichever
  neighbour (just above the current top, just below the current bottom) holds more volume is
  taken, both on equal volume, and a side with nothing left beyond the occupied range is never
  taken. `vah`/`val` are the top and bottom levels reached.
- **HVN**: volume at least 0.30 x POC volume, strictly above every lower neighbour and at or
  above every higher neighbour within 2 levels (levels outside the occupied range count as 0);
  strength = volume / POC volume.
- **LVN**: strictly between two consecutive HVNs, strictly below every lower neighbour and at or
  below every higher neighbour within 2 levels, the window confined to the levels strictly
  between those HVNs; strength = 1 - volume / min(flanking HVN volumes), kept when at least
  0.50. An empty level between two peaks is therefore an LVN of strength 1.
- The strongest `maxNodes` (default 16) survive, lower price first on equal strength, and are
  listed by price.
- Session boundaries come from the instrument's trading-hours template
  (`TradingHours.GetNextBeginEnd`) compared with each event's own time stamp, never from a
  hardcoded clock. At the boundary the session profile is promoted to `prior` when the AddOn saw
  the whole session (history loaded, or the tape started within a minute of the open) and is
  otherwise re-fetched as bars; `composite` is rebuilt as prior plus the new session and then
  grows with every print.

Step-3 payload size is `164 + marketBytes`; the golden `snapshot-step3.bin` is 1479 bytes on
the wire. The cap is the frame limit: three records at the maximum config (64 nodes, 48
checkpoints, 1024 levels) are well under 1 MiB.

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
| `hello.bin` | hello, 2 instruments, with the step-2.5 identity section (one root entry, one fully qualified entry) and one unresolved entry |
| `hello-base.bin` | hello, 2 instruments, base table only (byte-identical to the step-2 `hello.bin`); still valid, identities decode as absent |
| `hello-empty.bin` | hello, 0 instruments, base table only |
| `hello-rolled.bin` | re-announced hello after index 0 rolled: same indices, new identity, rollCount 1 |
| `event-contract-rolled.bin` | type 2, eventKind 1, for index 0, previous and next identity blocks |
| `heartbeat.bin` | heartbeat, empty payload |
| `snapshot.bin` | step-1 snapshot (24-byte payload) for instrument index 1; still valid, still decoded |
| `snapshot-step2.bin` | step-2 snapshot (160-byte payload) for instrument index 1 |
| `snapshot-step2-unavailable.bin` | step-2 snapshot whose allocation fields are all -1 |
| `stream.bin` | base hello + heartbeat + 2 step-1 snapshots concatenated, for the splitter test |
| `stream-step2.bin` | base hello + heartbeat + step-2 snapshot + step-1 snapshot, mixed sizes |
| `stream-roll.bin` | hello + snapshot(0) + re-announced hello + contractRolled(0) + snapshot(0): a roll mid-connection |
| `snapshot-step3.bin` | step-3 snapshot for index 1: the seven-print fixture of `server/test/volumeProfile.test.ts` as the session profile (POC 100.50, VAH 101.00, VAL 100.00, three nodes, one checkpoint, six levels), a volume-only prior with a naked POC, and a composite with one history bar in front |
| `snapshot-step3-unavailable.bin` | step-3 snapshot with nothing computed: NaN prices, session unknown, history failed with a reason, every profile unavailable |
| `stream-step3.bin` | base hello + heartbeat + step-3 snapshot + step-2 snapshot + step-1 snapshot, three payload sizes on one stream |

The snapshot goldens and both `stream*.bin` files from steps 1 and 2 are byte-identical to
their step-2 versions; only `hello.bin` was regenerated for step 2.5, and its previous bytes
live on as `hello-base.bin`. Step 3 added files only; every earlier golden is byte-identical.
