# Latency landscape

Where time is actually spent between a CME matching-engine event and a language model reading our
order-flow state, which hops we control, and which low-latency techniques apply here. Every figure
is either cited or reproducible from a harness in `bench/`.

## Where the latency lives

The chain: matching engine → CME MDP 3.0 wire → Rithmic ticker plant → Rithmic client library inside
NT8 → NT8 instrument thread → our handler → SPSC ring → publisher → named pipe → Node host →
JSON-RPC frame → model inference. Public reference points give the shape. A colocated distributor advertises a 90th percentile of
42 µs from the CME wire to the subscriber application over cross-connect, and 590 µs over the
public internet, with nanosecond PTP-synchronised timestamps [1]. A retail Rithmic connection is in
the second regime or worse: hundreds of microseconds to low single-digit milliseconds, varying with
the operator's hosting more than with anything in our code. Rithmic splits the feed by plant —
ticker, order, history, PnL — each on its own connection with its own login and heartbeat [2],
speaking a proprietary binary protocol over TCP [3].

Inside NT8, `MarketData` and `MarketDepth` events fire on instrument threads: roughly one per
logical processor, with an instrument bound to one for its lifetime, and subscribe/unsubscribe
marshalled through `Instrument.Dispatcher.InvokeAsync` or the platform deadlocks against its own
internals [4]. That thread is shared with every other consumer of the instrument, which is why the
spec forbids blocking it. A handler that only reads the update, folds it into a struct and publishes
a sequence costs single-digit microseconds; one that allocates, locks or logs produces a
millisecond tail and surfaces in NT8's NinjaScript Utilization Monitor, which ranks scripts by total
processing time in milliseconds [5].

The ring hand-off is tens of nanoseconds. The named pipe is the first hop with a real measured cost:
a ping-pong benchmark records a Windows named-pipe round trip near 28 µs against 0.19 µs for shared
memory [6], so roughly 10–15 µs one way. Node adds its own floor — a healthy process idles at 1–2 ms
of event-loop lag, and above ~30 ms is treated as a defect [15] — and JSON-RPC encode/parse of a
few-kilobyte snapshot is tens to low hundreds of microseconds. Then inference: frontier models
report p50 time-to-first-token near 0.85–1.12 s, p95 of 1.8–2.4 s, complete responses of 10–15 s,
and reasoning modes an order of magnitude beyond [16].

We control four hops: handler, ring, publisher, pipe boundary. Everything upstream belongs to CME,
Rithmic and NT8; everything downstream to the model provider. The four we own sum to well under
100 µs. The last one is measured in seconds. That ratio governs every decision below.

## The techniques, and what each buys

Busy-spin versus sleep is the first fork. Windows' default timer interrupt is 15.625 ms, so
`Sleep(1)` can return 1 to 16.6 ms later, and since Windows 10 2004 `timeBeginPeriod` raises
resolution mostly for the calling process rather than globally [9]. Spinning removes that
quantisation at the cost of a core; spin-then-yield-then-wait is the usual compromise. Core pinning
extends it: pin the hot thread, keep the scheduler off that core, disable SMT so a sibling cannot
evict your L1, set firmware to maximum performance so C-state exit and frequency ramp stay out of
the tail. Rigtorp measures 18 µs maximum jitter on an isolated core against millisecond-scale jitter
on an ordinary one [8]. Windows has no `isolcpus`; affinity masks and a high-performance power plan
are the approximations available.

The SPSC ring and the Disruptor pattern address the queue itself: a pre-allocated bounded ring with
sequence counters and memory barriers, entries reused for the process lifetime, cache-line padding
so producer and consumer cursors never share a 64-byte line. Reported figures are a 52 ns mean
hand-off and 128 ns p99, against 32.7 µs mean and 2.1 ms p99 for a lock-based `ArrayBlockingQueue`
[7]. What transfers is the cause, not the number: the tail came from contention and allocation, not
the copy. Zero-allocation hot paths are the .NET expression of the same idea — structs, `Span<T>`,
`ArrayPool`, pre-sized ring storage, no LINQ, no boxing, no string formatting in the handler.
Garbage-collection *mode* is a per-process runtime setting [10], and the process is NinjaTrader's,
shared with the user's charts; changing it is an unannounced global change to someone else's
platform, so the spec refuses. Eliminate the garbage, do not reconfigure the collector.

Kernel bypass — Onload, TCPDirect, ef_vi, DPDK — matters when your process terminates the exchange
feed and the kernel stack is the bottleneck above a million packets per second [11]. Behind a vendor
API it is unreachable: the socket belongs to Rithmic's client library inside NT8. Shared memory with
a seqlock, and the Aeron/Chronicle/SBE family built on it [14][17], is genuinely faster than a pipe
(0.19 µs against 28 µs [6]) and is deferred to v2 rather than rejected on principle. FPGA feed
handlers sit at the far end — roughly 10–100 µs for software over the kernel stack, 1–5 µs with
kernel bypass, 300 ns–1 µs for a full FPGA pipeline, 30–100 ns for pre-armed triggers — and their
product is determinism: the same clock count every time, with nothing between p50 and p99.9 [12].
PTP and hardware timestamping exist so those figures compare across venues [1]; our analogue is
humbler and still mandatory — one monotonic clock, stamped at each hop we own.

Coordinated omission, in Gil Tene's formulation, is the measurement trap: a closed-loop harness that
waits for each response before sending the next stops issuing work exactly when the system is slow,
so outliers are never recorded and the reported p99 is fiction — one worked example shows a 249 µs
p99 evaporating once load was replayed against a fixed schedule [13]. The fix is an open-loop
harness driven by intended send time, HdrHistogram for the full distribution, and p50/p99/p99.9/max
rather than a mean. Averages hide exactly the pauses this section is about.

## What NinjaTrader 8 permits, and why we stay inside it

NT8's AddOn surface gives the design what it needs: per-instrument subscription on a known thread, a
dispatcher for safe subscribe/unsubscribe [4], and the Utilization Monitor as an independent check
that our AddOn is not the script at the top of the list [5]. Going direct to Rithmic R|API+ would
delete the NT8 hop and is plausibly worth hundreds of microseconds; it also costs roughly $100/month
for API access plus market data, a conformance test, and an implementation of the plant protocol
[3]. More decisively, it would delete the product: the state this server exposes is computed by the
owner's NT8 indicators, for an audience whose charts and executions already live in NT8.

## What is worth doing, and what is theatre

Given a consumer whose reply arrives in seconds, the wins that survive protect correctness and the
platform rather than shave the transport. The zero-allocation handler earns its place by keeping
NT8's instrument thread — shared with the user's charts — free of pauses, not by saving nanoseconds.
Conflation earns its place because a latest-wins snapshot means a slow consumer never backpressures
the producer and never reads a backlog as current state. Staleness stamping earns its place because
the snapshot is already hundreds of milliseconds old by the time it is tokenised. And the execution
path *after* a decision is where microseconds still matter, because it does not wait on inference.
Theatre would be spin-waiting the publisher, pinning cores, replacing the pipe with shared memory in
v1, or tuning the GC of a process we do not own: defensible where the consumer is another machine,
irrelevant when the next hop takes a second.

## What a hiring manager reads

The signal is not the list of techniques but whether each choice is attached to a measurement and a
stated consumer. A zero-allocation handler with zero allocations shown under a profiler, an
open-loop HdrHistogram harness reporting p99.9 and max, and a plain statement that the pipe was left
alone because 28 µs sits inside a one-second round trip, together demonstrate the thing desks need:
finding the dominant term and leaving the rest alone. Listing busy-spin, core pinning, kernel bypass
and shared memory on a project that talks to a model over JSON-RPC demonstrates familiarity with a
reading list. The same technique reads as competence or cargo-culting depending on whether a number
was measured before it was applied, and on whether the candidate says unprompted which optimisations
were declined.

## Comparison

| Technique | What it buys | Applies here? | Why |
|---|---|---|---|
| Zero-allocation handler (structs, `Span`, `ArrayPool`) | No GC pressure on a thread shared with the platform | Yes | The only hop where a pause harms someone other than us |
| Conflated latest-wins snapshot | Slow consumer cannot backpressure the producer; no stale backlog | Yes | Consumer is seconds-slow by nature |
| SPSC ring with cache-line padding | ~50–130 ns hand-off, no lock contention or false sharing [7] | Yes | Cheap, and it is what keeps the handler non-blocking |
| Monotonic hop timestamps + staleness field | Model can tell how old the state is | Yes | Prevents reasoning on a moved market |
| Open-loop HdrHistogram harness, p99.9 reported | Tails that closed-loop tests omit [13] | Yes | Every number in this repo depends on it |
| Hybrid spin/yield on the publisher | Removes 15.6 ms Windows timer quantisation [9] | v2 | Measure first; a core is a real cost |
| Core pinning / affinity | Lower jitter, ~18 µs vs ms-scale [8] | v2 | Meaningful only after the pipe stops being the floor |
| Shared memory + seqlock IPC (Aeron/Chronicle style) | ~0.19 µs vs ~28 µs pipe RTT [6] | v2 | Real gain, invisible behind inference; complexity now |
| Binary encoding (SBE-style) over JSON | No parse/allocate per message [14] | v2 | JSON-RPC is the MCP contract; revisit only with a binary peer |
| Setting GC mode inside NT8 | Different pause profile [10] | No | Not our process; a global change to a user's platform |
| Kernel bypass (Onload, ef_vi, DPDK) | µs-scale network stack savings [11] | No | Rithmic's client owns the socket inside NT8 |
| FPGA feed handling | 300 ns–1 µs deterministic pipeline [12] | No | We consume a vendor API, not a wire feed |
| PTP / hardware timestamping | Sub-µs cross-venue clock accuracy [1] | No | Single host; a monotonic clock is sufficient |
| Disabling SMT / C-states on the host | Removes jitter sources [8] | No | Operator's machine, not a project deliverable |
| Bypassing NT8 for R|API+ direct | Removes one adapter hop [3] | No | Deletes the indicators and the audience the project serves |

---

[1] Databento, "CME Globex MDP 3.0 (GLBX.MDP3)" — https://databento.com/datasets/GLBX.MDP3
[2] async_rithmic documentation, plant architecture — https://async-rithmic.readthedocs.io/
[3] QuantLabsNet, "The Iron Gatekeeper: The High Cost of Low Latency in the Rithmic API Ecosystem" — https://www.quantlabsnet.com/post/the-iron-gatekeeper-the-high-cost-of-low-latency-in-the-rithmic-api-ecosystem
[4] NinjaTrader Support Forum, "How do I prevent deadlocks with MarketData, FundamentalData events?" — https://forum.ninjatrader.com/forum/ninjatrader-8/platform-technical-support-aa/1288422-how-do-i-prevent-deadlocks-with-marketdata-fundamentaldata-events
[5] QuantVPS Help Center, "How to Fix: NinjaTrader Slowness Using the NinjaScript Utilization Monitor" — https://intercom.help/quantvps/en/articles/10344673-how-to-check-the-ninjascript-output-monitor-in-ninjatrader-for-slowness-or-unresponsiveness
[6] T. Tilley, "IPC in Rust — a Ping Pong Comparison" — https://3tilley.github.io/posts/simple-ipc-ping-pong/
[7] LMAX, "Disruptor: High performance alternative to bounded queues" — https://lmax-exchange.github.io/disruptor/disruptor.html
[8] E. Rigtorp, "Low Latency Tuning Guide" — https://rigtorp.se/low-latency-guide/
[9] B. Dawson, "Windows Timer Resolution: The Great Rule Change" — https://randomascii.wordpress.com/2020/10/04/windows-timer-resolution-the-great-rule-change/
[10] Microsoft Learn, "Workstation vs. server garbage collection" — https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/workstation-server-gc
[11] Databento Microstructure Guide, "What is kernel bypass and how is it used in trading?" — https://databento.com/microstructure/kernel-bypass
[12] LibFPGA, "FPGAs in high-frequency trading: the anatomy of a nanosecond" — https://libfpga.com/blog/fpgas-for-hft
[13] ScyllaDB, "On Coordinated Omission" (Gil Tene's formulation) — https://www.scylladb.com/2021/04/22/on-coordinated-omission/
[14] Simple Binary Encoding wiki, "Why Low Latency" — https://github.com/aeron-io/simple-binary-encoding/wiki/Why-Low-Latency
[15] D. Hettler, "Monitoring Node.js: Watch Your Event Loop Lag!" — https://davidhettler.net/blog/event-loop-lag/
[16] Digital Applied, "AI Model Latency Benchmarks 2026: TTFT & TPS Data" — https://www.digitalapplied.com/blog/ai-model-latency-benchmarks-2026-ttft-throughput
[17] Aeron, efficient reliable UDP unicast, multicast and IPC transport — https://github.com/aeron-io/aeron
