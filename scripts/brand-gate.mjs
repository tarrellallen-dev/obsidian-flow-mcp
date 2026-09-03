// Brand gate. Every user-visible surface must name Obsidian Flow or The Boy Prodigy.
// Run: node scripts/brand-gate.mjs   (exit 1 on any miss). Wired into CI in step 8.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRANDS = ["Obsidian Flow", "The Boy Prodigy", "obsidian-flow"];

// [file, regex that captures the user-visible string]
const SURFACES = [
  ["addon/OrderFlowMcpAddOn.cs", /_menuItem\.Header\s*=\s*"([^"]*)"/, "Control Center menu entry"],
  ["addon/OrderFlowMcpAddOn.cs", /Description\s*=\s*"([^"]*)"/, "AddOn description"],
  ["addon/OrderFlowMcpAddOn.cs", /\bName\s*=\s*"([^"]*)"/, "AddOn name (NT8 AddOn list)"],
  ["addon/StatusWindow.cs", /Caption\s*=\s*"([^"]*)"/, "status window caption"],
  ["server/src/index.ts", /SERVER_NAME\s*=\s*"([^"]*)"/, "MCP server name"],
  ["server/package.json", /"name"\s*:\s*"([^"]*)"/, "npm package name"],
  ["README.md", /^#\s*(.*)$/m, "README title"],
];

let failed = 0;
for (const [file, rx, label] of SURFACES) {
  const text = readFileSync(resolve(root, file), "utf8");
  const m = text.match(rx);
  const value = m ? m[1] : "";
  const lower = value.toLowerCase();
  const branded = BRANDS.some((b) => lower.includes(b.toLowerCase()));
  // Product names are "Obsidian Flow <thing>" - the brand itself reads as order flow.
  const noOrderflow = !/order[\s-]?flow/.test(lower);
  const ok = branded && noOrderflow;
  console.log(`${ok ? "ok  " : "MISS"} ${label} (${file}): "${value}"`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`brand-gate: ${failed} surface(s) fail (must name Obsidian Flow or The Boy Prodigy, and must not say order flow)`);
  process.exit(1);
}
