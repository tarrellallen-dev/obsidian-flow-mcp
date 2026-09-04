#!/usr/bin/env node
// Obsidian Flow MCP - end-to-end wire check.
//
// Answers one question the unit tests cannot: does the AddOn running inside NinjaTrader and the
// server's decoder agree on the wire? The test suite proves the decoder against golden files this
// repository generated, which is a check that the decoder matches the specification, not that the
// publisher does. Those are different claims, and only this one needs NinjaTrader.
//
// It attaches with the same PipeClient the MCP server uses, so a pass here is a pass for the
// server. Nothing is written to the pipe and nothing is subscribed to; the AddOn accepts one
// client at a time, so stop the MCP server before running this and vice versa.
//
//   node scripts/pipe-smoke.mjs                  20 seconds, default pipe name
//   node scripts/pipe-smoke.mjs --seconds 60
//   OF_PIPE_NAME=my-pipe node scripts/pipe-smoke.mjs
//
// Exit 0 on a hello plus at least one snapshot. Exit 1 otherwise, having said what was missing.
// Requires `npm run build` in server/ first: it imports the compiled client.

import { pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "server", "dist", "src", "transport", "pipeClient.js");

if (!existsSync(built)) {
  console.error("Build the server first:  cd server && npm install && npm run build");
  process.exit(1);
}

const args = process.argv.slice(2);
const secondsArg = args.indexOf("--seconds");
const seconds = secondsArg >= 0 ? Number(args[secondsArg + 1]) : 20;
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error("--seconds must be a positive number");
  process.exit(1);
}

const { PipeClient, resolveEndpoint } = await import(pathToFileURL(built).href);

const pipeName = process.env.OF_PIPE_NAME || "obsidian-flow-mcp-v1";
const options = process.platform === "win32" ? { pipeName } : {};

// Off Windows there is no NinjaTrader and no named pipe. resolveEndpoint throws there unless
// OF_SOCKET_PATH names a Unix socket, which is how this script is exercised in CI against a
// recorded publisher. Say that rather than printing a stack trace.
let endpoint;
try {
  endpoint = resolveEndpoint(options);
} catch (err) {
  console.error(String(err && err.message ? err.message : err));
  if (process.platform !== "win32") {
    console.error(
      "\nThis check talks to the NinjaTrader AddOn, which runs on Windows only. Set " +
        "OF_SOCKET_PATH to point at a Unix socket to run it against a recorded publisher instead."
    );
  }
  process.exit(1);
}
console.log(`endpoint   ${endpoint}`);
console.log(`listening  ${seconds}s\n`);

let hello = null;
let snapshots = 0;
let heartbeats = 0;
let events = 0;
let firstSnapshotAt = null;
let lastDrained = null;
let lastPrice = null;
let profilesSeen = false;
let connected = false;

const client = new PipeClient(options);

client.on("connected", () => {
  connected = true;
  console.log("connected to the AddOn");
});

client.on("disconnected", (reason) => {
  console.log(`disconnected: ${reason}`);
});

// Counted, not listed. A malformed stream produces the same decode error on every reconnect,
// and a few hundred identical lines buries the one line that matters.
const errors = new Map();
function note(message) {
  errors.set(message, (errors.get(message) || 0) + 1);
}

client.on("error", (err) => {
  note(String(err && err.message ? err.message : err));
});

client.on("frame", (frame) => {
  const p = frame.payload;
  if (p.kind === "hello") {
    hello = p;
    console.log(`\nhello`);
    console.log(`  stopwatch frequency  ${p.stopwatchFrequency} ticks/s`);
    for (const i of p.instruments) {
      const id = i.identity;
      const via = id ? `${id.shape}, via ${id.resolvedBy}` : "no identity section";
      const expiry = id && id.expiry ? `, expiry ${id.expiry}` : "";
      console.log(`  [${i.index}] ${i.name}  tick ${i.tickSize}  (${via}${expiry})`);
    }
    for (const u of p.unresolved) {
      console.log(`  UNRESOLVED ${u.typed}: ${u.reason}`);
    }
    console.log("");
    return;
  }
  if (p.kind === "heartbeat") {
    heartbeats++;
    return;
  }
  if (p.kind === "event") {
    events++;
    return;
  }
  if (p.kind === "snapshot") {
    snapshots++;
    if (firstSnapshotAt === null) firstSnapshotAt = Date.now();
    lastDrained = p.eventsDrained;
    if (p.market) {
      if (p.market.price.last !== null) lastPrice = p.market.price.last;
      if (p.market.session.available) profilesSeen = true;
    }
    if (snapshots === 1 || snapshots % 100 === 0) {
      const price = lastPrice === null ? "no trade yet" : `last ${lastPrice}`;
      const poc = p.market && p.market.session.poc !== null ? `, session POC ${p.market.session.poc}` : "";
      console.log(`  snapshot ${snapshots}  drained ${lastDrained}  ${price}${poc}`);
    }
    return;
  }
  if (p.kind === "unknown") {
    note(`unknown frame type ${p.type} (${p.bytes} bytes) - publisher is newer than this decoder`);
  }
});

client.start();

setTimeout(() => {
  client.stop();

  console.log("\n----");
  console.log(`connected     ${connected}`);
  console.log(`hello         ${hello ? "yes" : "no"}`);
  console.log(`snapshots     ${snapshots}`);
  console.log(`heartbeats    ${heartbeats}`);
  console.log(`events        ${events}`);
  console.log(`events drained (AddOn side, last snapshot): ${lastDrained === null ? "-" : lastDrained}`);

  const problems = [];
  if (!connected) {
    problems.push(
      "never connected. The AddOn creates its pipe when the engine starts: open NinjaTrader, " +
        "then New > Obsidian Flow MCP. If the MCP server is already running it holds the single " +
        "client slot - stop it and try again."
    );
  }
  if (connected && !hello) {
    problems.push("connected but no hello frame arrived, so the publisher never announced its instruments.");
  }
  if (hello && snapshots === 0) {
    problems.push("hello arrived but no snapshot did, so the publisher is not pushing state.");
  }
  for (const [message, count] of errors) {
    problems.push(count > 1 ? `${message}  (x${count})` : message);
  }

  if (problems.length > 0) {
    console.log("\nFAIL");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }

  console.log("\nPASS - the AddOn and this decoder agree on the wire.");
  if (lastPrice === null) {
    console.log(
      "  No trade price arrived in this window. The framing is proven either way; a quiet or " +
        "closed market, or an instrument the connected feed does not carry, will do this."
    );
  }
  if (!profilesSeen) {
    console.log("  No session profile yet: it needs trades, and none were seen in this window.");
  }
  process.exit(0);
}, seconds * 1000);
// Deliberately not unref'd. This timer is the only thing guaranteeing a verdict gets printed:
// if the pipe is absent the client has no open handle, and an unref'd timer would let the
// process exit silently with status 0, which is the one outcome a check like this must never
// produce.
