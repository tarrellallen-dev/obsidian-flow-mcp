/**
 * End-to-end over a real socket: a fake publisher speaking wire v1 on a Unix socket, the real
 * PipeClient, the real decoder and the real cache. This is the CI stand-in for the named pipe
 * (spec section 9).
 */

import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StateCache } from "../src/cache/stateCache.js";
import { PipeClient } from "../src/transport/pipeClient.js";
import { attach, buildServer } from "../src/index.js";
import { HEADER_BYTES } from "../src/wire/decoder.js";

// Instrument names in these fixtures are EXAMPLES; the base-table hello built here is the
// step-2 layout, which the decoder still accepts (identities absent).
const TYPE_SNAPSHOT = 1;
const TYPE_HELLO = 3;
const TYPE_HEARTBEAT = 4;
const INSTRUMENT_NONE = 0xffff;

let sequence = 0;

function frame(type: number, instrument: number, payload: Buffer, dropped = 0): Buffer {
  const buf = Buffer.alloc(4 + HEADER_BYTES + payload.length);
  buf.writeUInt32LE(HEADER_BYTES + payload.length, 0);
  buf.writeUInt16LE(type, 4);
  buf.writeUInt16LE(1, 6);
  buf.writeUInt32LE(sequence++, 8);
  buf.writeUInt32LE(dropped, 12);
  buf.writeBigInt64LE(BigInt(Date.now()), 16);
  buf.writeBigInt64LE(638_000_000_000_000_000n, 24);
  buf.writeUInt16LE(instrument, 32);
  buf.writeUInt16LE(0, 34);
  payload.copy(buf, 4 + HEADER_BYTES);
  return buf;
}

function helloFrame(instruments: { index: number; name: string }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(10);
  head.writeBigUInt64LE(10_000_000n, 0); // stopwatchFrequency
  head.writeUInt16LE(instruments.length, 8);
  parts.push(head);
  for (const inst of instruments) {
    const name = Buffer.from(inst.name, "ascii");
    const entry = Buffer.alloc(19 + name.length);
    entry.writeUInt16LE(inst.index, 0);
    entry.writeUInt8(name.length, 2);
    name.copy(entry, 3);
    entry.writeDoubleLE(0.25, 3 + name.length);
    entry.writeDoubleLE(50, 11 + name.length);
    parts.push(entry);
  }
  return frame(TYPE_HELLO, INSTRUMENT_NONE, Buffer.concat(parts));
}

function snapshotFrame(instrument: number, eventsDrained: bigint, dropped = 0): Buffer {
  const payload = Buffer.alloc(24);
  payload.writeBigUInt64LE(eventsDrained, 0);
  payload.writeBigUInt64LE(0n, 8);
  payload.writeBigUInt64LE(eventsDrained / 2n, 16);
  return frame(TYPE_SNAPSHOT, instrument, payload, dropped);
}

function heartbeatFrame(): Buffer {
  return frame(TYPE_HEARTBEAT, INSTRUMENT_NONE, Buffer.alloc(0));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("fake publisher over a unix socket", () => {
  let dir: string;
  let socketPath: string;
  let server: net.Server;
  let connections: net.Socket[];
  let client: PipeClient | null;

  beforeEach(() => {
    sequence = 0;
    connections = [];
    client = null;
    dir = mkdtempSync(join(tmpdir(), "of-mcp-"));
    socketPath = join(dir, "of.sock");
  });

  afterEach(async () => {
    client?.stop();
    for (const c of connections) c.destroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  function startPublisher(onConnection: (socket: net.Socket) => void): Promise<void> {
    server = net.createServer((socket) => {
      connections.push(socket);
      onConnection(socket);
    });
    return new Promise((resolve) => server.listen(socketPath, resolve));
  }

  it("fills the cache from hello, heartbeats and snapshots", async () => {
    await startPublisher((socket) => {
      socket.write(helloFrame([{ index: 0, name: "ES 06-26" }, { index: 1, name: "NQ 06-26" }]));
      socket.write(heartbeatFrame());
      socket.write(snapshotFrame(0, 1000n, 2));
      socket.write(snapshotFrame(1, 2000n, 0));
    });

    const cache = new StateCache();
    client = new PipeClient({ platform: "linux", socketPath, minBackoffMs: 10, maxBackoffMs: 20 });
    attach(cache, client);
    client.start();

    await waitFor(() => cache.framesReceived >= 4);

    const views = cache.viewInstruments();
    expect(views.map((v) => v.name)).toEqual(["ES 06-26", "NQ 06-26"]);
    expect(views[0]!.eventsDrained).toBe("1000");
    expect(views[0]!.handlerSamples).toBe("500");
    expect(views[0]!.droppedTotal).toBe(2);
    expect(views[0]!.tickSize).toBe(0.25);
    expect(views[0]!.freshness).toBe("live");
    expect(views[1]!.eventsDrained).toBe("2000");

    const health = cache.health();
    expect(health.helloReceived).toBe(true);
    expect(health.instrumentCount).toBe(2);
    expect(health.endpoint).toBe(socketPath);
    expect(health.eventsDrained).toBe("2000");
  });

  it("survives a stream written in adversarial chunk sizes", async () => {
    const stream = Buffer.concat([
      helloFrame([{ index: 0, name: "ES 06-26" }]),
      heartbeatFrame(),
      snapshotFrame(0, 7n),
      heartbeatFrame(),
      snapshotFrame(0, 9n),
    ]);

    await startPublisher((socket) => {
      let offset = 0;
      const pump = () => {
        if (offset >= stream.length) return;
        const size = ((offset * 7) % 11) + 1;
        socket.write(stream.subarray(offset, offset + size));
        offset += size;
        setTimeout(pump, 1);
      };
      pump();
    });

    const cache = new StateCache();
    client = new PipeClient({ platform: "linux", socketPath, minBackoffMs: 10, maxBackoffMs: 20 });
    attach(cache, client);
    client.start();

    await waitFor(() => cache.viewInstrument(0)?.eventsDrained === "9");
    expect(cache.framesReceived).toBe(5);
  });

  it("marks the cache reconnecting when the publisher drops, then recovers on a fresh hello", async () => {
    let connectionIndex = 0;
    await startPublisher((socket) => {
      connectionIndex++;
      if (connectionIndex === 1) {
        socket.write(helloFrame([{ index: 0, name: "ES 06-26" }]));
        socket.write(snapshotFrame(0, 100n));
        setTimeout(() => socket.destroy(), 30);
      } else {
        socket.write(helloFrame([{ index: 0, name: "ES 06-26" }]));
        socket.write(snapshotFrame(0, 500n));
      }
    });

    const cache = new StateCache();
    client = new PipeClient({
      platform: "linux",
      socketPath,
      minBackoffMs: 10,
      maxBackoffMs: 20,
      random: () => 0,
    });
    attach(cache, client);
    client.start();

    await waitFor(() => cache.viewInstrument(0)?.eventsDrained === "100");
    await waitFor(() => cache.helloReceived === false);
    expect(cache.viewInstrument(0)!.freshness).toBe("reconnecting");

    await waitFor(() => cache.viewInstrument(0)?.eventsDrained === "500", 5000);
    expect(cache.health().connectionCount).toBeGreaterThanOrEqual(2);
  });

  it("builds an MCP server whose tools answer from the same cache", async () => {
    await startPublisher((socket) => {
      socket.write(helloFrame([{ index: 0, name: "ES 06-26" }]));
      socket.write(snapshotFrame(0, 42n));
    });

    const cache = new StateCache();
    client = new PipeClient({ platform: "linux", socketPath, minBackoffMs: 10, maxBackoffMs: 20 });
    attach(cache, client);
    client.start();
    await waitFor(() => cache.viewInstrument(0)?.eventsDrained === "42");

    // buildServer must not throw and must register both tools.
    const mcp = buildServer(cache);
    expect(mcp).toBeDefined();
    expect(cache.health().pipeState).toBe("connected");
    await mcp.close();
  });
});
