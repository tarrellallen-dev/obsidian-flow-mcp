// Publish gate. Refuses to let anything into a public repository that belongs
// to the paid tier or to a private account. Runs in CI on every push and should
// be run by hand before any release.
//
// It checks for four things, and each one has bitten a real Obsidian Flow
// release before:
//   1. licence-check code (the free build must have none at all)
//   2. live credentials or endpoints
//   3. paid-tier symbols that must never appear in the open repository
//   4. the placeholder text that means a doc was never finished
//
// Exit 1 on any hit, naming the file and line.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "bin", "obj", "golden"]);

// [regex, why it is forbidden]. Case-insensitive.
const FORBIDDEN = [
  [/validate-?licen[cs]e/, "licence validation endpoint"],
  [/licen[cs]e[_-]?key\s*[:=]\s*["'][^"']+["']/, "hardcoded licence key"],
  [/supabase\.co/, "Supabase endpoint"],
  [/service[_-]?role/, "service-role credential"],
  [/\b(sk|pk)_(live|test)_[A-Za-z0-9]{8,}/, "Stripe key"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bBoyProdigy\.Framework\b/, "closed framework reference"],
  [/\bTAProfileEngine\b|\bTrueAggressionEngine\b/, "paid engine symbol"],
  [/\bHiddenLiquidityBias\b/, "paid indicator symbol"],
  [/\bDevelopmentFullAccess\b/, "licensing bypass flag"],
  [/\bTODO\s*:?\s*(fill|replace|fixme)\b/, "unfinished placeholder"],
];

// Files that legitimately discuss the paid tier by name, in prose, and are
// allowed to mention it. Everything else is checked.
const PROSE_ALLOWED = new Set([
  "docs/roadmap/backtester-companion.md",
  "docs/roadmap/shared-framing.md",
  "scripts/publish-gate.mjs",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const BINARY = /\.(bin|png|jpg|jpeg|gif|zip|dll|pdb|ico)$/i;
let hits = 0;
let scanned = 0;

for (const file of walk(root)) {
  if (BINARY.test(file)) continue;
  const rel = relative(root, file).split("\\").join("/");
  if (PROSE_ALLOWED.has(rel)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  scanned++;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [rx, why] of FORBIDDEN) {
      if (new RegExp(rx, "i").test(lines[i])) {
        console.error(`BLOCK ${rel}:${i + 1}  ${why}`);
        console.error(`      ${lines[i].trim().slice(0, 120)}`);
        hits++;
      }
    }
  }
}

if (hits) {
  console.error(`\npublish-gate: ${hits} finding(s). Nothing publishes until these are gone.`);
  process.exit(1);
}
console.log(`Publish gate passed: ${scanned} files scanned, no paid-tier symbols or credentials.`);
