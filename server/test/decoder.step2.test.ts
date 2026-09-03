/**
 * Step-2 snapshot block (schema/wire-v1.md "step-2 block"). Golden files come from
 * schema/tools/gen-golden.mjs; the step-1 goldens are untouched and stay decodable, which is
 * the additive-extension guarantee this file pins.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { StateCache, allocFigure } from "../src/cache/stateCache.js";
import { loadServerConfig } from "../src/config.js";
import { buildServer, environmentBlock } from "../src/index.js";
import { FrameSplitter } from "../src/transport/frameSplitter.js";
import {
  decodeFrame,
  FrameType,
  HEADER_BYTES,
  NS_UNAVAILABLE,
  SNAPSHOT_PAYLOAD_BYTES,
  SNAPSHOT_STEP2_PAYLOAD_BYTES,
} from "../src/wire/decoder.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN = join(ROOT, "schema", "golden");
const golden = (name: string) => readFileSync(join(GOLDEN, name));

describe("step-2 snapshot golden files", () => {
  it("pins the extended payload size", () => {
    expect(SNAPSHOT_STEP2_PAYLOAD_BYTES).toBe(160);
    expect(golden("snapshot-step2.bin").length).toBe(4 + HEADER_BYTES + SNAPSHOT_STEP2_PAYLOAD_BYTES);
  });

  it("still decodes the step-1 golden with instrumentation absent", () => {
    const frame = decodeFrame(golden("snapshot.bin"));
    if (frame.payload.kind !== "snapshot") throw new Error("expected snapshot");
    expect(golden("snapshot.bin").length).toBe(4 + HEADER_BYTES + SNAPSHOT_PAYLOAD_BYTES);
    expect(frame.payload.eventsDrained).toBe(123456789n);
    expect(frame.payload.instrumentation).toBeNull();
  });

  it("decodes every step-2 field at its documented offset", () => {
    const frame = decodeFrame(golden("snapshot-step2.bin"));
    expect(frame.header.type).toBe(FrameType.Snapshot);
    expect(frame.header.instrument).toBe(1);
    expect(frame.header.ringEventsDropped).toBe(3);
    if (frame.payload.kind !== "snapshot") throw new Error("expected snapshot");

    // step-1 block unchanged in front
    expect(frame.payload.eventsDrained).toBe(987654321n);
    expect(frame.payload.bytesAllocatedOnPublisher).toBe(8192n);
    expect(frame.payload.handlerSamples).toBe(300000n);

    const inst = frame.payload.instrumentation;
    if (inst === null) throw new Error("expected step-2 block");
    expect(inst.data).toEqual({
      p50Ns: 1299,
      p99Ns: 8999,
      p999Ns: 45999,
      maxNs: 71234,
      sampleCount: 200000n,
      allocBytesPer1024: 0n,
      allocBytesTotal: 1536n,
    });
    expect(inst.depth).toEqual({
      p50Ns: 999,
      p99Ns: 4599,
      p999Ns: 12999,
      maxNs: 30001,
      sampleCount: 100000n,
      allocBytesPer1024: 0n,
      allocBytesTotal: 0n,
    });
    expect(inst.publisherAllocBytesTotal).toBe(8192n);
    expect(inst.serialize).toEqual({
      p50Ns: 2099,
      p99Ns: 6999,
      p999Ns: 19999,
      maxNs: 4294967294, // saturated u32, one below the unavailable sentinel
      sampleCount: 12345n,
    });
    expect(inst.stopwatchFrequency).toBe(10_000_000n);
    expect(inst.ringDropsTotal).toBe(3n);
    expect(inst.sampleOverrunsTotal).toBe(0n);
  });

  it("reads raw bytes at the documented offsets, independent of the decoder's field order", () => {
    const buf = golden("snapshot-step2.bin");
    const payload = buf.subarray(4 + HEADER_BYTES);
    expect(payload.readUInt32LE(24)).toBe(1299); // dataP50Ns
    expect(payload.readBigUInt64LE(40)).toBe(200000n); // dataSampleCount
    expect(payload.readUInt32LE(48)).toBe(999); // depthP50Ns
    expect(payload.readBigInt64LE(72)).toBe(0n); // dataAllocBytesPer1024
    expect(payload.readBigInt64LE(80)).toBe(1536n); // dataAllocBytesTotal
    expect(payload.readBigInt64LE(104)).toBe(8192n); // publisherAllocBytesTotal
    expect(payload.readUInt32LE(112)).toBe(2099); // serializeP50Ns
    expect(payload.readUInt32LE(124)).toBe(0xfffffffe); // serializeMaxNs, saturated
    expect(payload.readBigUInt64LE(136)).toBe(10_000_000n); // stopwatchFrequency
    expect(payload.readBigUInt64LE(144)).toBe(3n); // ringDropsTotal
    expect(payload.readBigUInt64LE(152)).toBe(0n); // sampleOverrunsTotal
  });

  it("carries -1 allocation figures through as unavailable, never as 0", () => {
    const frame = decodeFrame(golden("snapshot-step2-unavailable.bin"));
    if (frame.payload.kind !== "snapshot") throw new Error("expected snapshot");
    const inst = frame.payload.instrumentation;
    if (inst === null) throw new Error("expected step-2 block");
    // Empty histograms carry 0xFFFFFFFF on the wire and decode to null, never 0 ns.
    const raw = golden("snapshot-step2-unavailable.bin").subarray(4 + HEADER_BYTES);
    expect(raw.readUInt32LE(24)).toBe(NS_UNAVAILABLE);
    expect(inst.data.p50Ns).toBeNull();
    expect(inst.data.maxNs).toBeNull();
    expect(inst.data.sampleCount).toBe(0n);
    expect(inst.serialize.p99Ns).toBeNull();
    expect(inst.depth.p50Ns).toBe(109); // populated histogram still decodes normally
    expect(inst.data.allocBytesPer1024).toBe(-1n);
    expect(inst.data.allocBytesTotal).toBe(-1n);
    expect(inst.depth.allocBytesPer1024).toBe(-1n);
    expect(inst.publisherAllocBytesTotal).toBe(-1n);
    expect(inst.stopwatchFrequency).toBe(2_441_442n);
    expect(inst.sampleOverrunsTotal).toBe(7n);
    expect(allocFigure(-1n)).toEqual({ bytes: -1, status: "unavailable" });
    expect(allocFigure(0n)).toEqual({ bytes: 0, status: "measured" });
  });

  it("rejects a snapshot payload between the two accepted sizes", () => {
    const buf = Buffer.concat([golden("snapshot.bin"), Buffer.alloc(8)]);
    buf.writeUInt32LE(HEADER_BYTES + SNAPSHOT_PAYLOAD_BYTES + 8, 0);
    expect(() => decodeFrame(buf)).toThrow(/snapshot payload/);
  });

  it("rejects a step-2 block declaring a non-positive stopwatchFrequency", () => {
    const buf = Buffer.from(golden("snapshot-step2.bin"));
    buf.writeBigUInt64LE(0n, 4 + HEADER_BYTES + 136);
    expect(() => decodeFrame(buf)).toThrow(/stopwatchFrequency/);
  });

  it("splits a stream mixing step-1 and step-2 snapshots", () => {
    const frames = new FrameSplitter().push(golden("stream-step2.bin")).map((f) => decodeFrame(f));
    expect(frames.map((f) => f.header.type)).toEqual([
      FrameType.Hello,
      FrameType.Heartbeat,
      FrameType.Snapshot,
      FrameType.Snapshot,
    ]);
    const [, , step2, step1] = frames;
    if (step2!.payload.kind !== "snapshot" || step1!.payload.kind !== "snapshot") {
      throw new Error("expected snapshots");
    }
    expect(step2!.payload.instrumentation).not.toBeNull();
    expect(step1!.payload.instrumentation).toBeNull();
  });
});

describe("cache latency view and latency_report", () => {
  function primedCache(): StateCache {
    const cache = new StateCache();
    cache.onConnect();
    for (const f of new FrameSplitter().push(golden("stream-step2.bin"))) {
      cache.applyFrame(decodeFrame(f));
    }
    return cache;
  }

  it("exposes the step-2 block per instrument and marks step-1 payloads absent", () => {
    const views = primedCache().viewLatency();
    expect(views.map((v) => v.name)).toEqual(["ES 06-26", "NQ 06-26"]);

    const es = views[0]!; // received the step-1 snapshot0
    expect(es.instrumentation).toBe("absent");
    expect(es.data).toBeNull();

    const nq = views[1]!; // received the step-2 snapshot
    expect(nq.instrumentation).toBe("present");
    expect(nq.data!.p99Ns).toBe(8999);
    expect(nq.data!.allocBytesPer1024).toEqual({ bytes: 0, status: "measured" });
    expect(nq.data!.allocBytesTotal).toEqual({ bytes: 1536, status: "measured" });
    expect(nq.depth!.sampleCount).toBe("100000");
    expect(nq.serialize!.maxNs).toBe(4294967294);
    expect(nq.stopwatchFrequency).toBe("10000000");
    expect(nq.ringDropsTotal).toBe("3");
    expect(nq.droppedTotal).toBe(3);
    expect(nq.freshness).toBe("live");
  });

  it("reports instrumentation none before any snapshot", () => {
    const cache = new StateCache();
    cache.onConnect();
    cache.applyFrame(decodeFrame(golden("hello.bin")));
    const view = cache.viewLatencyByName("ES 06-26");
    expect(view!.instrumentation).toBe("none");
    expect(view!.serialize).toBeNull();
  });

  it("loads nt8Build and feed from server/orderflow.config.json", () => {
    const config = loadServerConfig(join(ROOT, "server", "orderflow.config.json"));
    expect(config.nt8Build).toBe("8.1.8.2 64-bit");
    expect(config.feed).toBe("Rithmic (CME Level 2)");
    expect(loadServerConfig(null)).toMatchObject({ nt8Build: "unknown", feed: "unknown" });
  });

  it("builds an environment block with the cpu model from os.cpus()", () => {
    const env = environmentBlock({ nt8Build: "x", feed: "y", source: "test" }, "10000000");
    expect(env).toMatchObject({ nt8Build: "x", feed: "y", stopwatchFrequency: "10000000" });
    expect(env.node).toBe(process.version);
    expect(typeof env.cpu).toBe("string");
    expect(env.cpu.length).toBeGreaterThan(0);
    expect(env.os).toContain(process.platform);
  });

  it("registers latency_report with a description that scopes the measurement", () => {
    const server = buildServer(primedCache(), { nt8Build: "x", feed: "y", source: "test" });
    // McpServer keeps its registrations private; read the tool table through the public
    // wrapper's private field rather than adding a test-only accessor to production code.
    const tools = (server as unknown as { _registeredTools: Record<string, { description?: string }> })
      ._registeredTools;
    const tool = tools["latency_report"];
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/OWN in-process measurements/);
    expect(tool!.description).toMatch(/not end-to-end/);
    expect(tool!.description).toMatch(/NOT measured yet/);
    expect(tool!.description).toMatch(/THREAD-WIDE/);
  });
});
