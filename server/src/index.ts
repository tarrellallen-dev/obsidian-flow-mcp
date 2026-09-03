#!/usr/bin/env node
/**
 * NT8 Order-Flow MCP server - build step 1.
 *
 * Transport and threading contract only. Two tools, both answering from the in-process cache:
 * `health` and `instruments`. No market state is computed anywhere in this build step.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { StateCache } from "./cache/stateCache.js";
import { PipeClient, resolveEndpoint, type PipeClientOptions } from "./transport/pipeClient.js";

export const SERVER_NAME = "nt8-orderflow-mcp";
export const SERVER_VERSION = "0.1.0";

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

export function buildServer(cache: StateCache): McpServer {
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
        "connection has sent its hello, dropped-event count, and events drained by the AddOn " +
        "publisher. Answers from an in-process cache, so this is the state as of the last frame " +
        "received, not a live query. Build step 1 exposes transport counters only; no market " +
        "state is computed. " +
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

  const server = buildServer(cache);
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
