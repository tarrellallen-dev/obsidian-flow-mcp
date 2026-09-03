/**
 * Server-side configuration: the parts of the environment block (spec section 8) that the
 * process cannot discover on its own. Read once at startup from server/orderflow.config.json,
 * or from the path in OF_CONFIG_PATH. Missing file or keys fall back to "unknown" so the
 * latency_report tool never invents an NT8 build or a feed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerConfig {
  /** NinjaTrader build as shown under Help > About, e.g. "8.1.8.2 64-bit". */
  nt8Build: string;
  /** Data feed and level, e.g. "Rithmic (CME Level 2)". */
  feed: string;
  /** Where the values came from; "defaults" when no file was found. */
  source: string;
}

export const CONFIG_FILE_NAME = "orderflow.config.json";
export const UNKNOWN = "unknown";

/**
 * Looks for the config file next to the module, then up to three directories above it, so the
 * same code finds server/orderflow.config.json whether it runs from src/ (tsx) or dist/src/
 * (compiled).
 */
export function findConfigPath(startDir: string = dirname(fileURLToPath(import.meta.url))): string | null {
  const explicit = process.env.OF_CONFIG_PATH;
  if (explicit) return resolve(explicit);

  let dir = startDir;
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadServerConfig(path: string | null = findConfigPath()): ServerConfig {
  const fallback: ServerConfig = { nt8Build: UNKNOWN, feed: UNKNOWN, source: "defaults" };
  if (path === null) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...fallback, source: `${path} (unreadable)` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...fallback, source: `${path} (not an object)` };
  }

  const obj = parsed as Record<string, unknown>;
  const str = (key: string): string => {
    const v = obj[key];
    return typeof v === "string" && v.length > 0 ? v : UNKNOWN;
  };
  return { nt8Build: str("nt8Build"), feed: str("feed"), source: path };
}
