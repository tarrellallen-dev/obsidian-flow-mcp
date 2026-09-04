#!/usr/bin/env node
// Serves this repository's golden frames over a Unix socket, so `pipe-smoke.mjs` can be run
// without NinjaTrader. That is what makes the smoke check itself testable: a check that has only
// ever been run against a broken stream, or never run at all, is not evidence of anything.
//
// Linux and macOS only, and used by CI. On Windows the smoke check talks to the real AddOn.
//
//   node scripts/golden-replay.mjs /tmp/of.sock &
//   OF_SOCKET_PATH=/tmp/of.sock node scripts/pipe-smoke.mjs --seconds 3
//
// Frames are replayed, not generated: they are the same bytes the decoder's golden tests assert
// on, so this cannot drift away from the wire specification without those tests failing first.

import net from "node:net";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goldenDir = join(root, "schema", "golden");
const socketPath = process.argv[2];

if (!socketPath) {
  console.error("usage: node scripts/golden-replay.mjs <socket path>");
  process.exit(1);
}
if (process.platform === "win32") {
  console.error("Unix sockets only. On Windows, run pipe-smoke.mjs against the AddOn itself.");
  process.exit(1);
}

const read = (name) => readFileSync(join(goldenDir, name));
const hello = read("hello-base.bin");
const snapshot = read("snapshot-step3.bin");
const heartbeat = read("heartbeat.bin");

if (existsSync(socketPath)) unlinkSync(socketPath);

const server = net.createServer((socket) => {
  socket.write(hello);
  const snapshots = setInterval(() => {
    try {
      socket.write(snapshot);
    } catch {
      /* the client went away; the close handler clears the timers */
    }
  }, 10);
  const heartbeats = setInterval(() => {
    try {
      socket.write(heartbeat);
    } catch {
      /* as above */
    }
  }, 500);
  const stop = () => {
    clearInterval(snapshots);
    clearInterval(heartbeats);
  };
  socket.on("close", stop);
  socket.on("error", stop);
});

server.listen(socketPath, () => {
  console.log(`golden replay on ${socketPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    if (existsSync(socketPath)) unlinkSync(socketPath);
    process.exit(0);
  });
}
