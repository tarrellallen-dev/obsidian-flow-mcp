import net from "node:net";
import { randomUUID } from "node:crypto";

export interface UiControlClientOptions {
  pipeName?: string;
  socketPath?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export interface UiControlRequest {
  command: string;
  [key: string]: unknown;
}

export function resolveUiControlEndpoint(options: UiControlClientOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const base = options.pipeName ?? "obsidian-flow-mcp-v1";
    return `\\\\.\\pipe\\${base}-control`;
  }

  const socketPath = options.socketPath ?? process.env.OF_UI_CONTROL_SOCKET_PATH;
  if (!socketPath) {
    throw new Error("OF_UI_CONTROL_SOCKET_PATH is required off win32 for UI control tests");
  }
  return socketPath;
}

export async function sendUiControlRequest<T = unknown>(
  request: UiControlRequest,
  options: UiControlClientOptions = {},
): Promise<T> {
  const endpoint = resolveUiControlEndpoint(options);
  const timeoutMs = options.timeoutMs ?? 2_500;
  const id = typeof request.id === "string" ? request.id : randomUUID();
  const payload = JSON.stringify({ ...request, id }) + "\n";

  return await new Promise<T>((resolve, reject) => {
    const socket = net.connect({ path: endpoint });
    let settled = false;
    let buffer = "";

    const timer = setTimeout(() => {
      finish(new Error(`UI control request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();

    function finish(err?: Error, value?: T): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(value as T);
    }

    socket.on("connect", () => {
      socket.write(payload, "utf8");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      const line = buffer.slice(0, newline).trim();
      if (!line) {
        finish(new Error("UI control server returned an empty reply"));
        return;
      }

      try {
        const parsed = JSON.parse(line) as T;
        finish(undefined, parsed);
      } catch (err) {
        finish(err as Error);
      }
    });

    socket.on("error", (err) => finish(err));
    socket.on("close", () => {
      if (!settled) finish(new Error("UI control connection closed before a reply"));
    });
  });
}
