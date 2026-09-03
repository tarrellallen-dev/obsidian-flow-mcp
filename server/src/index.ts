#!/usr/bin/env node
/**
 * NT8 Order-Flow MCP server - build step 2.
 *
 * Transport, threading contract and instrumentation. Three tools, all answering from the
 * in-process cache: `health`, `instruments` and `latency_report`. No market state is computed
 * anywhere in this build step.
 */

import os from "node:os";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { StateCache } from "./cache/stateCache.js";
import { loadServerConfig, type ServerConfig } from "./config.js";
import { PipeClient, resolveEndpoint, type PipeClientOptions } from "./transport/pipeClient.js";

export const SERVER_NAME = "obsidian-flow-mcp";
export const SERVER_VERSION = "0.2.0";

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
        "received, not a live query. Build steps 1 and 2 expose transport counters and the " +
        "AddOn's own instrumentation (see latency_report); no market state is computed. " +
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
        "Instruments announced by the AddOn in the current connection's hello frame, with tick " +
        "size and point value. Each entry carries freshness (live | stale | reconnecting) and a " +
        "staleness block whose two numbers are described by the health tool: receiveToServeMs is " +
        "measured, oneWayEstimateMs is an estimate. `reconnecting` means the link dropped and no " +
        "hello has arrived yet: the " +
        "instrument list from the previous connection is not valid and its indices are not " +
        "reused. Answers from cache; never blocks.",
      inputSchema: { name: z.string().optional().describe("Filter to one instrument by name.") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      if (name) {
        const view = cache.viewInstrumentByName(name);
        return json({
          helloReceived: cache.helloReceived,
          instruments: view ? [view] : [],
        });
      }
      return json({
        helloReceived: cache.helloReceived,
        instruments: cache.viewInstruments(),
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
      inputSchema: { name: z.string().optional().describe("Filter to one instrument by name.") },
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

  return server;
}

async function main(): Promise<void> {
  const options: PipeClientOptions = {
    pipeName: process.env.OF_PIPE_NAME ?? "obsidianflow-orderflow-v1",
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
