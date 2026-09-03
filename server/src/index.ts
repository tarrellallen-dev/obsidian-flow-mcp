#!/usr/bin/env node
/**
 * Obsidian Flow MCP server - build step 4.
 *
 * Transport, threading contract, instrumentation, instrument identity, and from step 3 on the
 * computed market state the AddOn publishes: price, session VWAP and the session/prior/composite
 * volume profiles. Seven tools, all answering from the in-process cache: `health`,
 * `instruments`, `latency_report`, `orderflow_snapshot`, `price_state`, `vwap_state` and
 * `volume_profile`. Nothing here recomputes market state; the cache holds what the AddOn sent.
 */

import os from "node:os";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { StateCache, profileView, type ProfileScope } from "./cache/stateCache.js";
import { loadServerConfig, type ServerConfig } from "./config.js";
import { PipeClient, resolveEndpoint, type PipeClientOptions } from "./transport/pipeClient.js";

export const SERVER_NAME = "obsidian-flow-mcp";
export const SERVER_VERSION = "0.4.0";

/** Spec section 8: every published number carries its environment. Built once per call. */
export interface EnvironmentBlock {
  nt8Build: string;
  feed: string;
  node: string;
  os: string;
  cpu: string;
  /** From the last snapshot's step-2 block (or the hello); null before either has arrived. */
  stopwatchFrequency: string | null;
  configSource: string;
}

export function environmentBlock(config: ServerConfig, stopwatchFrequency: string | null): EnvironmentBlock {
  const cpus = os.cpus();
  return {
    nt8Build: config.nt8Build,
    feed: config.feed,
    node: process.version,
    os: `${os.platform()} ${os.release()} (${os.arch()})`,
    cpu: cpus.length > 0 && cpus[0] ? cpus[0].model : "unknown",
    stopwatchFrequency,
    configSource: config.source,
  };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Wires a cache to a pipe client. Exported so the integration test can drive the same path. */
export function attach(cache: StateCache, client: PipeClient): void {
  cache.setEndpoint(client.target);
  cache.setPipeState(client.state);

  client.on("connected", () => {
    cache.setPipeState("connected");
    cache.setError(null);
    cache.onConnect();
  });

  client.on("disconnected", (reason: string) => {
    cache.onDisconnect(reason);
  });

  client.on("error", (err: Error) => {
    cache.setError(err.message);
  });

  client.on("frame", (frame) => {
    cache.applyFrame(frame);
  });
}

export function buildServer(cache: StateCache, config: ServerConfig = loadServerConfig()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "health",
    {
      title: "Health",
      description:
        "Transport health for the NinjaTrader 8 AddOn link: pipe state, whether the current " +
        "connection has sent its hello, ring-dropped event count (market events the AddOn's " +
        "rings dropped, not dropped snapshots - snapshots conflate), and events drained by the AddOn " +
        "publisher. Answers from an in-process cache, so this is the state as of the last frame " +
        "received, not a live query. Build steps 1, 2 and 2.5 expose transport counters and the " +
        "AddOn's own instrumentation (see latency_report); no market state is computed. " +
        "The `instruments` array gives one resolution state per AddOn config entry: `resolved` " +
        "(subscribed), `unresolved` with the AddOn's reason (the entry produced no subscription " +
        "and has no index), `rolled` with `rolledAt` and `previousName` (the entry was a bare " +
        "futures root and the AddOn moved it to a new front contract, either on this connection " +
        "or earlier in the AddOn process), or `identity-absent` (a pre-2.5 AddOn). A bare root " +
        "such as \"ES\" auto-resolves to the front contract and can roll mid-session; a roll " +
        "re-announces the hello and appears as a contractRolled entry in recentEvents. " +
        "Staleness is two separate numbers and they must not be silently added together. " +
        "receiveToServeMs is measured exactly, on this process's own monotonic clock, from " +
        "decoding the frame to answering this call. oneWayEstimateMs is an ESTIMATE of the " +
        "publisher-to-client hop derived from the AddOn's fixed heartbeat cadence: it is a lower " +
        "bound on transport jitter, not a measurement of one-way latency, it excludes any " +
        "constant transport delay, and it is null until two heartbeats have arrived on the " +
        "current connection. The two clocks share no epoch, so no exact end-to-end frame age " +
        "exists and none is reported.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => json({ ...cache.health(), recentEvents: cache.recentEvents(16) }),
  );

  server.registerTool(
    "instruments",
    {
      title: "Instruments",
      description:
        "Instruments announced by the AddOn in the current connection's hello frame, with the " +
        "identity record the AddOn resolved for each: `name` is the resolved NinjaTrader name " +
        "(Instrument.FullName), `resolvedFrom` is exactly what the user typed in the AddOn " +
        "config, and `identity` carries shape, resolvedBy, masterName, instrumentType (Future, " +
        "Stock, Forex, CryptoCurrency, Index, ...), exchange, currency, tradingHours, expiry " +
        "(YYYY-MM-DD, null when the instrument does not expire), tickSize, pointValue, rolledAt " +
        "and rollCount. This record is the fingerprint used to label recorded history: two " +
        "entries with the same resolvedFrom but different name are different contracts. Config " +
        "entries take three shapes: a fully qualified name with a contract month is used " +
        "as-is and never re-resolved; a bare futures root (e.g. \"ES\") auto-resolves to the " +
        "front contract by NinjaTrader's own rollover data and CAN ROLL MID-SESSION (checked " +
        "once a minute and at session boundaries; a roll re-announces this table with the same " +
        "index and a new identity, and `resolution.state` becomes `rolled`); any non-futures " +
        "symbol resolves directly. Config entries that did not resolve have no index here; the " +
        "health tool lists them with the reason. Each entry carries freshness (live | stale | " +
        "reconnecting) and a staleness block whose two numbers are described by the health " +
        "tool: receiveToServeMs is measured, oneWayEstimateMs is an estimate. `reconnecting` " +
        "means the link dropped and no hello has arrived yet: the instrument list from the " +
        "previous connection is not valid and its indices are not reused. Answers from cache; " +
        "never blocks.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Filter to one instrument by resolved name or by the config entry as typed (e.g. a bare root)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      if (name) {
        const view = cache.viewInstrumentByName(name);
        return json({
          helloReceived: cache.helloReceived,
          instruments: view ? [view] : [],
          unresolved: cache.unresolvedInstruments.filter((u) => u.typed === name),
        });
      }
      return json({
        helloReceived: cache.helloReceived,
        instruments: cache.viewInstruments(),
        unresolved: cache.unresolvedInstruments,
      });
    },
  );

  server.registerTool(
    "latency_report",
    {
      title: "Latency report",
      description:
        "The NinjaTrader 8 AddOn's OWN in-process measurements, as carried in its last " +
        "snapshot per instrument. These are not end-to-end figures. Measured: (1) MarketData " +
        "and MarketDepth handler duration on the NinjaTrader data thread, from handler entry to " +
        "just after the ring push (data/depth p50, p99, p99.9, max in nanoseconds, quantised to " +
        "two significant digits, max exact, plus sample counts); (2) bytes allocated on each " +
        "handler thread over the last 1024 events and since start, and on the publisher thread " +
        "since its first frame, from GC.GetAllocatedBytesForCurrentThread - a THREAD-WIDE " +
        "counter: it includes NinjaTrader's own allocations on that thread, and instruments " +
        "whose handlers share a thread repeat the same number, so it bounds the handler's " +
        "allocation rather than attributing it; (3) the publisher's " +
        "frame-serialize time, start of payload serialization to hand-off to the pipe. " +
        "Allocation figures carry status 'unavailable' with value -1 when the runtime does not " +
        "expose the counter or the probe has not run yet; 0 always means measured zero. " +
        "Latency fields are null while the histogram behind them is empty, never 0. " +
        "Percentiles are recomputed by the AddOn at most once per second. " +
        "NOT measured yet: time inside NinjaTrader before the handler is entered (feed adapter, " +
        "NT's own dispatch), the pipe write and transit, decoding and caching in this process, " +
        "staleness at MCP service time beyond the receiveToServeMs/oneWayEstimateMs pair the " +
        "health tool describes, coordinated-omission correction, and execution round-trip. " +
        "ringDropsTotal is producer-side ring-full drops (the frame header's per-frame count, " +
        "summed); sampleOverrunsTotal is handler " +
        "samples the publisher did not read before they were overwritten (nonzero means the " +
        "histograms undercount). The environment block names the NT8 build and feed from " +
        "server/orderflow.config.json, this process's Node, OS and CPU, and the publisher's " +
        "Stopwatch frequency. Answers from cache; never blocks.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Filter to one instrument by resolved name or by the config entry as typed."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      const instruments = name
        ? (() => {
            const view = cache.viewLatencyByName(name);
            return view ? [view] : [];
          })()
        : cache.viewLatency();
      const fromSnapshot = instruments.find((v) => v.stopwatchFrequency !== null)?.stopwatchFrequency;
      const stopwatchFrequency =
        fromSnapshot ?? (cache.stopwatchFrequency === null ? null : cache.stopwatchFrequency.toString());
      return json({
        measurementScope: "addon-in-process",
        unit: "nanoseconds",
        helloReceived: cache.helloReceived,
        environment: environmentBlock(config, stopwatchFrequency),
        instruments,
      });
    },
  );

  // ----- step-4 read tools: computed market state from the cache -----

  const CONFLATED =
    "The data is a CONFLATED SNAPSHOT: the AddOn publishes latest-wins state at its push rate " +
    "(default 100 Hz) and this process caches the last one per instrument, so consecutive calls " +
    "may return the same sequence and no intermediate state is ever queued. stalenessMs is the " +
    "measured receive-to-serve age of the cached snapshot on this process's own clock; " +
    "staleness.oneWayEstimateMs is an estimate of the publisher-to-client hop and the two are " +
    "never summed for you. Every response names the resolved instrument (identity) and the " +
    "frame sequence. `name` selects the instrument by resolved NinjaTrader name or by the AddOn " +
    "config entry as typed; it may be omitted when exactly one instrument is configured. " +
    "depth is `unavailable` in this build step because the book is not computed yet - it does " +
    "not mean the book is empty. market.status is `absent` when the AddOn build predates the " +
    "market block and `none` before the first snapshot on this connection.";

  const SPLIT =
    "The bid/ask split is LIVE-TAPE-ONLY: a print at or above the ask counts as ask volume, at " +
    "or below the bid as bid volume, inside the spread as unattributed. Volume from before the " +
    "AddOn attached comes from BarsRequest bars (coverage.historyFromWallUtc .. historyToWallUtc, " +
    "spread evenly across each 1-minute bar's range unless historyBars is \"tick\") and has no " +
    "split; per level, historyVolume = volume - tapeVolume and bidVolume/askVolume are null where " +
    "there is no tape volume. coverage.tapeFromWallUtc is where the split starts.";

  const selectError = (error: string) => json({ error, helloReceived: cache.helloReceived, health: cache.health() });

  server.registerTool(
    "orderflow_snapshot",
    {
      title: "Orderflow snapshot",
      description:
        "Obsidian Flow MCP: the compact default first call for one instrument. Returns the price " +
        "block (last, lastSize, lastAggressor, bid, ask, spreadTicks, session open/high/low, " +
        "sessionVolume, tickSize, pointValue, session bounds from the instrument's trading hours), " +
        "the session VWAP block (vwap, stdDev, 1 and 2 sigma bands, priceVsVwapTicks), the " +
        "session and prior volume-profile summaries (POC, VAH, VAL, value-area and total volume, " +
        "the latest developing checkpoint, HVN/LVN nodes with strength 0-1, prior nakedPoc) with " +
        "no histogram, plus coverage, staleness and depth availability. For the histogram or the " +
        "composite scope call volume_profile. " +
        CONFLATED +
        " " +
        SPLIT,
      inputSchema: {
        name: z.string().optional().describe("Instrument by resolved name or config entry as typed; optional when only one is configured."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      const read = cache.readMarket(name);
      if ("error" in read) return selectError(read.error);
      const block = read.block;
      return json({
        ...read.envelope,
        price: read.price,
        vwap: read.vwap,
        profile: block
          ? {
              session: profileView(block, "session"),
              prior: profileView(block, "prior"),
              compositeAvailable: block.composite.available,
            }
          : null,
        coverage: read.coverage,
      });
    },
  );

  server.registerTool(
    "price_state",
    {
      title: "Price state",
      description:
        "Obsidian Flow MCP: the price block for one instrument - last trade (price, size, " +
        "aggressor: bid = seller hit the bid, ask = buyer lifted the offer, between = inside the " +
        "spread, none = no bid/ask known when it printed), best bid and ask, spread in ticks, " +
        "session open/high/low, sessionVolume (history bars plus tape) and tapeVolume (what the " +
        "AddOn saw itself), tradeCount, tickSize and pointValue from the resolved instrument's " +
        "MasterInstrument (any asset class), and the session bounds the AddOn took from the " +
        "instrument's trading-hours template (session.known is false until the template " +
        "answered). " +
        CONFLATED,
      inputSchema: {
        name: z.string().optional().describe("Instrument by resolved name or config entry as typed; optional when only one is configured."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      const read = cache.readMarket(name);
      if ("error" in read) return selectError(read.error);
      return json({ ...read.envelope, price: read.price });
    },
  );

  server.registerTool(
    "vwap_state",
    {
      title: "VWAP state",
      description:
        "Obsidian Flow MCP: the session VWAP block for one instrument - vwap, stdDev (volume-" +
        "weighted Welford running variance over trade price), sd1Upper/sd1Lower and " +
        "sd2Upper/sd2Lower bands, priceVsVwapTicks (last minus vwap, in ticks), the volume " +
        "behind it and includesHistory (true when BarsRequest bars before attach were folded in " +
        "at typical price, (high+low+close)/3, so the figure is a bar approximation for that " +
        "portion). Resets at the session boundary from the instrument's trading hours. Anchored " +
        "VWAP is not in this build. " +
        CONFLATED,
      inputSchema: {
        name: z.string().optional().describe("Instrument by resolved name or config entry as typed; optional when only one is configured."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      const read = cache.readMarket(name);
      if ("error" in read) return selectError(read.error);
      return json({ ...read.envelope, vwap: read.vwap, coverage: read.coverage });
    },
  );

  server.registerTool(
    "volume_profile",
    {
      title: "Volume profile",
      description:
        "Obsidian Flow MCP: one volume profile for one instrument. scope=session (default) is " +
        "the current trading session from the instrument's trading hours: POC, 70 % value area " +
        "(VAH/VAL), POC and value-area volume, total volume, occupied range, HVN/LVN nodes with " +
        "relative strength 0-1 (HVN strength = volume / POC volume; LVN strength = 1 - volume / " +
        "smaller flanking HVN), and the developing POC/VAH/VAL series frozen at fixed-time " +
        "checkpoints from the session open (AddOn config checkpointMinutes, default 30). POC " +
        "ties are settled deterministically toward the session VWAP. scope=prior is the previous " +
        "session's POC/VAH/VAL/total, volume-only (no split ever), with nakedPoc = the current " +
        "session has not traded through it, and source = live (the AddOn watched that session " +
        "whole) or history (BarsRequest bars). scope=composite is prior plus current session " +
        "merged. The per-price histogram (price, volume, historyVolume, tapeVolume, " +
        "bidVolume, askVolume, unattributedVolume) is returned ONLY when includeHistogram is " +
        "true, capped to the AddOn's histogramLevels (default 64) around the POC; it costs " +
        "tokens, so ask for it only when the levels themselves matter. " +
        CONFLATED +
        " " +
        SPLIT,
      inputSchema: {
        name: z.string().optional().describe("Instrument by resolved name or config entry as typed; optional when only one is configured."),
        scope: z.enum(["session", "prior", "composite"]).default("session").describe("Which profile: session (default), prior or composite."),
        includeHistogram: z.boolean().default(false).describe("Include the per-price histogram window around the POC. Default false."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, scope, includeHistogram }) => {
      const read = cache.readMarket(name);
      if ("error" in read) return selectError(read.error);
      const block = read.block;
      const s: ProfileScope = scope ?? "session";
      return json({
        ...read.envelope,
        profile: block ? profileView(block, s, { includeHistogram: includeHistogram === true, includeSeries: true }) : null,
        coverage: read.coverage,
      });
    },
  );

  return server;
}

async function main(): Promise<void> {
  const options: PipeClientOptions = {
    pipeName: process.env.OF_PIPE_NAME ?? "obsidian-flow-mcp-v1",
  };
  const socketPath = process.env.OF_SOCKET_PATH;
  if (socketPath) options.socketPath = socketPath;

  const cache = new StateCache();
  cache.setEndpoint(resolveEndpoint(options));

  const client = new PipeClient(options);
  attach(cache, client);
  client.start();

  const server = buildServer(cache, loadServerConfig());
  await server.connect(new StdioServerTransport());

  const shutdown = () => {
    client.stop();
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run when executed directly, so tests can import buildServer/attach.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    // stderr only: stdout is the MCP transport.
    process.stderr.write(`fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
