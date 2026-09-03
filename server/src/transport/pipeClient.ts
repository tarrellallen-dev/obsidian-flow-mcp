/**
 * Reconnecting client for the AddOn's frame stream.
 *
 * On win32 it connects to \\.\pipe\<pipeName>. Everywhere else it connects to the Unix socket
 * path in OF_SOCKET_PATH, which exists so the server can be tested and run in CI on Linux.
 *
 * Reconnect uses exponential backoff with full jitter. Every connect is treated as a brand new
 * session: the consumer must discard the previous instrument table and wait for a fresh hello
 * (schema/wire-v1.md, "Framing and reconnect").
 */

import { EventEmitter } from "node:events";
import net from "node:net";

import { decodeFrame, MAX_FRAME_BYTES, type Frame } from "../wire/decoder.js";
import { FrameSplitter } from "./frameSplitter.js";

export type PipeState = "disconnected" | "connecting" | "connected";

export interface PipeClientOptions {
  /** Pipe name without the \\.\pipe\ prefix. Used on win32 only. */
  pipeName?: string;
  /** Unix socket path. Used off win32. Defaults to process.env.OF_SOCKET_PATH. */
  socketPath?: string;
  /** Overrides platform detection. Tests set this. */
  platform?: NodeJS.Platform;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  maxFrameBytes?: number;
  /** Injectable for tests. Defaults to Math.random. */
  random?: () => number;
}

export interface PipeClientEvents {
  frame: (frame: Frame) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (error: Error) => void;
}

const DEFAULT_MIN_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5_000;

export function resolveEndpoint(options: PipeClientOptions): string {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const name = options.pipeName ?? "obsidianflow-orderflow-v1";
    return `\\\\.\\pipe\\${name}`;
  }
  const socketPath = options.socketPath ?? process.env.OF_SOCKET_PATH;
  if (!socketPath) {
    throw new Error(
      "OF_SOCKET_PATH is required off win32: the named pipe transport is Windows only",
    );
  }
  return socketPath;
}

export class PipeClient extends EventEmitter {
  private readonly endpoint: string;
  private readonly splitter: FrameSplitter;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly random: () => number;

  private socket: net.Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = true;
  private stateValue: PipeState = "disconnected";

  constructor(options: PipeClientOptions = {}) {
    super();
    this.endpoint = resolveEndpoint(options);
    this.splitter = new FrameSplitter(options.maxFrameBytes ?? MAX_FRAME_BYTES);
    this.minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.random = options.random ?? Math.random;
  }

  get state(): PipeState {
    return this.stateValue;
  }

  get target(): string {
    return this.endpoint;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    this.setState("disconnected");
  }

  private setState(next: PipeState): void {
    this.stateValue = next;
  }

  private connect(): void {
    if (this.stopped) return;

    this.setState("connecting");
    this.splitter.reset();

    const socket = net.connect({ path: this.endpoint });
    this.socket = socket;

    socket.on("connect", () => {
      this.attempt = 0;
      this.setState("connected");
      this.emit("connected");
    });

    socket.on("data", (chunk: Buffer) => {
      let frames: Buffer[];
      try {
        frames = this.splitter.push(chunk);
      } catch (err) {
        // A frame larger than maxFrameBytes means the stream is no longer parseable.
        this.emit("error", err as Error);
        this.dropAndRetry("frame size violation");
        return;
      }

      for (const raw of frames) {
        try {
          this.emit("frame", decodeFrame(raw));
        } catch (err) {
          // A single malformed frame is reported but does not tear down the connection;
          // the splitter is still in sync because the length prefix was honoured.
          this.emit("error", err as Error);
        }
      }
    });

    socket.on("error", (err: Error) => {
      this.emit("error", err);
    });

    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.dropAndRetry("socket closed");
    });
  }

  private dropAndRetry(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }

    const wasConnected = this.stateValue === "connected";
    this.setState("disconnected");
    if (wasConnected || this.attempt === 0) {
      this.emit("disconnected", reason);
    }

    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = this.backoffMs();
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // Do not hold the event loop open just to retry.
    this.reconnectTimer.unref?.();
  }

  /** Exponential backoff with full jitter, capped. */
  backoffMs(): number {
    const exponent = Math.min(this.attempt, 8);
    const ceiling = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** exponent);
    return Math.floor(this.minBackoffMs + this.random() * Math.max(0, ceiling - this.minBackoffMs));
  }
}
