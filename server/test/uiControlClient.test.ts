import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveUiControlEndpoint,
  sendUiControlRequest,
} from "../src/transport/uiControlClient.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function withServer(
  handler: (request: unknown) => unknown,
  test: (endpoint: { platform: NodeJS.Platform; socketPath?: string; pipeName?: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "of-ui-control-"));
  tmpDirs.push(dir);
  const pipeName = `of-ui-control-${process.pid}-${Date.now()}`;
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\${pipeName}-control`
      : path.join(dir, "control.sock");
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      socket.write(JSON.stringify(handler(request)) + "\n");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });

  try {
    await test(
      process.platform === "win32"
        ? { platform: "win32", pipeName }
        : { platform: process.platform, socketPath: endpoint },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("UI control client", () => {
  it("resolves the Windows control pipe from the market pipe name", () => {
    expect(resolveUiControlEndpoint({ platform: "win32", pipeName: "obsidian-flow-mcp-v1" })).toBe(
      "\\\\.\\pipe\\obsidian-flow-mcp-v1-control",
    );
  });

  it("sends one JSON line and parses one JSON reply", async () => {
    await withServer(
      (request) => ({
        ok: true,
        seen: request,
      }),
      async (endpoint) => {
        const reply = await sendUiControlRequest<{ ok: boolean; seen: { command: string; id: string } }>(
          { command: "ui.status" },
          { ...endpoint, timeoutMs: 500 },
        );

        expect(reply.ok).toBe(true);
        expect(reply.seen.command).toBe("ui.status");
        expect(reply.seen.id).toMatch(/[0-9a-f-]{36}/);
      },
    );
  });
});
