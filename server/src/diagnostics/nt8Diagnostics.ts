import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ScriptKind = "strategies" | "indicators" | "addons" | "all";

export interface NinjaScriptFileSummary {
  path: string;
  relativePath: string;
  kind: ScriptKind;
  bytes: number;
  modifiedUtc: string;
  namespace: string | null;
  classes: string[];
  enums: string[];
  addDataSeries: string[];
  generatedWrapper: boolean;
}

export interface LogFinding {
  path: string;
  relativePath: string;
  line: number;
  category: string;
  text: string;
}

export interface ConflictFinding {
  severity: "info" | "warning" | "error";
  category: string;
  message: string;
  files: string[];
  evidence?: string[];
}

export interface StrategyConflictScan {
  strategy: NinjaScriptFileSummary | null;
  hostedIndicators: NinjaScriptFileSummary[];
  findings: ConflictFinding[];
}

export interface Nt8Paths {
  documentsRoot: string;
  customRoot: string;
  strategiesRoot: string;
  indicatorsRoot: string;
  addonsRoot: string;
  logRoot: string;
  traceRoot: string;
}

const DEFAULT_MAX_READ_CHARS = 80_000;
const DEFAULT_MAX_FINDINGS = 80;

export function nt8DocumentsRoot(): string {
  return (
    process.env.OF_NT8_DOCS ??
    path.join(os.homedir(), "Documents", "NinjaTrader 8")
  );
}

export function nt8Paths(root = nt8DocumentsRoot()): Nt8Paths {
  const customRoot = path.join(root, "bin", "Custom");
  return {
    documentsRoot: root,
    customRoot,
    strategiesRoot: path.join(customRoot, "Strategies"),
    indicatorsRoot: path.join(customRoot, "Indicators"),
    addonsRoot: path.join(customRoot, "AddOns"),
    logRoot: path.join(root, "log"),
    traceRoot: path.join(root, "trace"),
  };
}

function normalizeForCompare(value: string): string {
  return path.resolve(value).toLowerCase();
}

function isInside(child: string, parent: string): boolean {
  const resolvedChild = normalizeForCompare(child);
  const resolvedParent = normalizeForCompare(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep.toLowerCase());
}

function requireInside(child: string, allowedRoots: string[]): string {
  const resolved = path.resolve(child);
  if (!allowedRoots.some((root) => isInside(resolved, root))) {
    throw new Error(`Path is outside the configured NinjaTrader diagnostic roots: ${child}`);
  }
  return resolved;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function walkFiles(root: string, predicate: (file: string) => boolean): Promise<string[]> {
  if (!(await dirExists(root))) return [];
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full, predicate)));
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function relativeTo(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function extractMatches(source: string, regex: RegExp): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(regex)) {
    const value = match[1];
    if (value) values.push(value);
  }
  return unique(values);
}

function userAuthoredSource(source: string): string {
  return source.split("#region NinjaScript generated code")[0] ?? source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractAddDataSeries(source: string): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(/AddDataSeries\s*\(([^;]+?)\)\s*;/gs)) {
    const value = match[1]?.replace(/\s+/g, " ").trim();
    if (value) values.push(value);
  }
  return unique(values);
}

function classifyScriptKind(filePath: string, p = nt8Paths()): ScriptKind {
  if (isInside(filePath, p.strategiesRoot)) return "strategies";
  if (isInside(filePath, p.indicatorsRoot)) return "indicators";
  if (isInside(filePath, p.addonsRoot)) return "addons";
  return "all";
}

async function summarizeScriptFile(filePath: string, p = nt8Paths()): Promise<NinjaScriptFileSummary> {
  const source = await readFile(filePath, "utf8");
  const authored = userAuthoredSource(source);
  const s = await stat(filePath);
  const kind = classifyScriptKind(filePath, p);
  return {
    path: filePath,
    relativePath: relativeTo(p.customRoot, filePath),
    kind,
    bytes: s.size,
    modifiedUtc: s.mtime.toISOString(),
    namespace: authored.match(/\bnamespace\s+([A-Za-z0-9_.]+)/)?.[1] ?? null,
    classes: extractMatches(
      authored,
      /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|new|unsafe)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm,
    ),
    enums: extractMatches(
      authored,
      /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|new|unsafe)\s+)*enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm,
    ),
    addDataSeries: extractAddDataSeries(authored),
    generatedWrapper: source.includes("NinjaScript generated code"),
  };
}

export async function listNinjaScriptFiles(kind: ScriptKind = "all", root = nt8DocumentsRoot()): Promise<NinjaScriptFileSummary[]> {
  const p = nt8Paths(root);
  const roots: string[] =
    kind === "strategies"
      ? [p.strategiesRoot]
      : kind === "indicators"
        ? [p.indicatorsRoot]
        : kind === "addons"
          ? [p.addonsRoot]
          : [p.strategiesRoot, p.indicatorsRoot, p.addonsRoot];

  const files = (
    await Promise.all(
      roots.map((r) => walkFiles(r, (file) => file.toLowerCase().endsWith(".cs"))),
    )
  ).flat();
  const summaries = await Promise.all(files.map((file) => summarizeScriptFile(file, p)));
  return summaries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function readNinjaScriptFile(
  requestedPath: string,
  options: { root?: string; maxChars?: number } = {},
): Promise<{ path: string; relativePath: string; truncated: boolean; text: string }> {
  const p = nt8Paths(options.root ?? nt8DocumentsRoot());
  const absolute = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.join(p.customRoot, requestedPath);
  const guarded = requireInside(absolute, [p.customRoot]);
  if (!guarded.toLowerCase().endsWith(".cs")) {
    throw new Error("Only .cs NinjaScript source files can be read by this diagnostic tool.");
  }
  const text = await readFile(guarded, "utf8");
  const maxChars = Math.max(1_000, options.maxChars ?? DEFAULT_MAX_READ_CHARS);
  const truncated = text.length > maxChars;
  const body = truncated ? text.slice(0, maxChars) : text;
  const numbered = body
    .split(/\r?\n/)
    .map((line, index) => `${String(index + 1).padStart(5, " ")}  ${line}`)
    .join("\n");
  return {
    path: guarded,
    relativePath: relativeTo(p.customRoot, guarded),
    truncated,
    text: numbered,
  };
}

function addFinding(findings: ConflictFinding[], finding: ConflictFinding): void {
  findings.push(finding);
}

function strategyFileScore(file: NinjaScriptFileSummary, query: string): number {
  const q = query.toLowerCase();
  const rel = file.relativePath.toLowerCase();
  const classes = file.classes.map((c) => c.toLowerCase());
  let score = 0;
  if (rel.endsWith(`${q}.cs`)) score += 50;
  if (rel.includes(q)) score += 20;
  if (classes.includes(q)) score += 40;
  return score;
}

async function pickStrategy(strategy?: string, root = nt8DocumentsRoot()): Promise<NinjaScriptFileSummary | null> {
  const strategies = await listNinjaScriptFiles("strategies", root);
  if (strategies.length === 0) return null;
  if (!strategy) {
    return strategies.slice().sort((a, b) => Date.parse(b.modifiedUtc) - Date.parse(a.modifiedUtc))[0] ?? null;
  }
  const scored = strategies
    .map((file) => ({ file, score: strategyFileScore(file, strategy) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.file ?? null;
}

async function findIndicatorByClass(className: string, root = nt8DocumentsRoot()): Promise<NinjaScriptFileSummary | null> {
  const indicators = await listNinjaScriptFiles("indicators", root);
  return indicators.find((file) => file.classes.includes(className)) ?? null;
}

function detectHostedIndicators(strategySource: string, indicatorCandidates: string[]): string[] {
  const hosted: string[] = [];
  for (const name of indicatorCandidates) {
    const escaped = escapeRegExp(name);
    const callPattern = new RegExp(`(?<!\\[)\\b${escaped}\\s*\\(`);
    const newPattern = new RegExp(`new\\s+${escaped}\\b`);
    if (callPattern.test(strategySource) || newPattern.test(strategySource)) hosted.push(name);
  }
  return unique(hosted);
}

function normalizeSeries(series: string): string {
  return series.replace(/\s+/g, "").toLowerCase();
}

function matchingSeriesExists(required: string, available: string[]): boolean {
  const n = normalizeSeries(required);
  return available.some((candidate) => normalizeSeries(candidate) === n);
}

function extractSignalNames(source: string, method: string): string[] {
  const names: string[] = [];
  const regex = new RegExp(`${method}\\s*\\(([^)]*)\\)`, "g");
  for (const match of source.matchAll(regex)) {
    const args = match[1] ?? "";
    const stringArgs = [...args.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter(Boolean) as string[];
    if (stringArgs.length > 0) names.push(stringArgs[stringArgs.length - 1] as string);
  }
  return unique(names);
}

export async function scanStrategyConflicts(strategy?: string, root = nt8DocumentsRoot()): Promise<StrategyConflictScan> {
  const p = nt8Paths(root);
  const findings: ConflictFinding[] = [];
  const selected = await pickStrategy(strategy, root);
  const allScripts = await listNinjaScriptFiles("all", root);
  const indicators = allScripts.filter((file) => file.kind === "indicators");

  const classOwners = new Map<string, { display: string; owners: string[] }>();
  const enumOwners = new Map<string, { display: string; owners: string[] }>();
  for (const file of allScripts) {
    const namespace = file.namespace ?? "<global>";
    for (const cls of file.classes) {
      const key = `${namespace}.${cls}`;
      const entry = classOwners.get(key) ?? { display: key, owners: [] };
      entry.owners.push(file.relativePath);
      classOwners.set(key, entry);
    }
    for (const en of file.enums) {
      const key = `${namespace}.${en}`;
      const entry = enumOwners.get(key) ?? { display: key, owners: [] };
      entry.owners.push(file.relativePath);
      enumOwners.set(key, entry);
    }
  }
  for (const { display, owners } of classOwners.values()) {
    if (owners.length > 1) {
      addFinding(findings, {
        severity: "error",
        category: "duplicate-class",
        message: `Class ${display} is defined in ${owners.length} compiling .cs files.`,
        files: owners,
      });
    }
  }
  for (const { display, owners } of enumOwners.values()) {
    if (owners.length > 1) {
      addFinding(findings, {
        severity: "error",
        category: "duplicate-enum",
        message: `Enum ${display} is defined in ${owners.length} compiling .cs files.`,
        files: owners,
      });
    }
  }

  if (!selected) {
    addFinding(findings, {
      severity: "error",
      category: "strategy-not-found",
      message: strategy ? `Could not find strategy matching ${strategy}.` : "No strategy .cs files were found.",
      files: [],
    });
    return { strategy: null, hostedIndicators: [], findings };
  }

  const strategySource = await readFile(selected.path, "utf8");
  const hostedNames = detectHostedIndicators(strategySource, indicators.flatMap((file) => file.classes));
  const hostedIndicators = (
    await Promise.all(hostedNames.map((name) => findIndicatorByClass(name, root)))
  ).filter((file): file is NinjaScriptFileSummary => file !== null);

  for (const indicator of hostedIndicators) {
    for (const series of indicator.addDataSeries) {
      if (!matchingSeriesExists(series, selected.addDataSeries)) {
        addFinding(findings, {
          severity: "error",
          category: "missing-host-series",
          message:
            `${selected.relativePath} hosts ${indicator.classes.join(", ")} which adds ` +
            `AddDataSeries(${series}), but the strategy does not preload the same series in State.Configure.`,
          files: [selected.relativePath, indicator.relativePath],
          evidence: [`indicator AddDataSeries(${series})`, `strategy AddDataSeries: ${selected.addDataSeries.join(" | ") || "none"}`],
        });
      } else {
        addFinding(findings, {
          severity: "info",
          category: "host-series-ok",
          message:
            `${selected.relativePath} preloads the secondary series required by ${indicator.classes.join(", ")}.`,
          files: [selected.relativePath, indicator.relativePath],
          evidence: [`AddDataSeries(${series})`],
        });
      }
    }
  }

  const currentBarsIndexes = unique([...strategySource.matchAll(/CurrentBars\s*\[\s*(\d+)\s*\]/g)].map((m) => m[1] ?? ""));
  for (const index of currentBarsIndexes) {
    const guarded =
      new RegExp(`CurrentBars\\s*\\[\\s*${index}\\s*\\]\\s*<`).test(strategySource) ||
      new RegExp(`CurrentBars\\s*\\[\\s*${index}\\s*\\]\\s*<=`).test(strategySource);
    if (!guarded) {
      addFinding(findings, {
        severity: "warning",
        category: "currentbars-guard",
        message: `Strategy references CurrentBars[${index}] but no obvious availability guard was found.`,
        files: [selected.relativePath],
      });
    }
  }

  const enterNames = unique([
    ...extractSignalNames(strategySource, "EnterLong"),
    ...extractSignalNames(strategySource, "EnterShort"),
  ]);
  const stopTargetNames = unique([
    ...extractSignalNames(strategySource, "SetStopLoss"),
    ...extractSignalNames(strategySource, "SetProfitTarget"),
  ]);
  for (const name of enterNames) {
    if (!stopTargetNames.includes(name)) {
      addFinding(findings, {
        severity: "warning",
        category: "order-signal-name",
        message: `Entry signal "${name}" has no matching SetStopLoss/SetProfitTarget signal name.`,
        files: [selected.relativePath],
      });
    }
  }
  for (const name of stopTargetNames) {
    if (!enterNames.includes(name)) {
      addFinding(findings, {
        severity: "warning",
        category: "order-signal-name",
        message: `SetStopLoss/SetProfitTarget references "${name}" but no matching entry signal was found.`,
        files: [selected.relativePath],
      });
    }
  }

  const nearDuplicateStrategies = (await listNinjaScriptFiles("strategies", root)).filter(
    (file) => file.path !== selected.path && file.relativePath.replace(/v\d+/i, "").toLowerCase() === selected.relativePath.replace(/v\d+/i, "").toLowerCase(),
  );
  for (const file of nearDuplicateStrategies) {
    addFinding(findings, {
      severity: "info",
      category: "near-duplicate-strategy",
      message: `Another strategy file has a very similar name. This is not a compile conflict, but it can confuse manual Strategy Analyzer testing.`,
      files: [selected.relativePath, file.relativePath],
    });
  }

  const staleCompileSourceFiles = (await walkFiles(p.customRoot, (file) => {
    const lower = file.toLowerCase();
    return lower.endsWith(".cs") && (lower.includes("\\backup") || lower.includes("\\archive") || lower.includes("\\_export_prep_backup"));
  })).map((file) => relativeTo(p.customRoot, file));
  for (const file of staleCompileSourceFiles) {
    addFinding(findings, {
      severity: "warning",
      category: "backup-source-compiles",
      message: "A backup/archive .cs file under bin\\Custom will still be compiled by NinjaTrader.",
      files: [file],
    });
  }

  return { strategy: selected, hostedIndicators, findings };
}

function categorizeLogLine(line: string): string | null {
  const lower = line.toLowerCase();
  if (lower.includes("tried to load additional data")) return "missing-host-data-series";
  if (/\bcs\d{4}\b/i.test(line)) return "compile-error";
  if (lower.includes("exception")) return "exception";
  if (lower.includes("error")) return "error";
  if (lower.includes("warning")) return "warning";
  if (lower.includes("strategy analyzer")) return "strategy-analyzer";
  if (lower.includes("tazones") || lower.includes("retouchstrategy") || lower.includes("strategy")) return "strategy-context";
  return null;
}

async function newestFiles(root: string, limit: number, extensionPattern = /\.(txt|log)$/i): Promise<string[]> {
  const files = await walkFiles(root, (file) => extensionPattern.test(file));
  const stats = await Promise.all(files.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })));
  return stats.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((item) => item.file);
}

export async function scanNt8Logs(
  options: { root?: string; maxFiles?: number; maxFindings?: number; query?: string } = {},
): Promise<LogFinding[]> {
  const p = nt8Paths(options.root ?? nt8DocumentsRoot());
  const maxFiles = Math.max(1, options.maxFiles ?? 6);
  const maxFindings = Math.max(1, options.maxFindings ?? DEFAULT_MAX_FINDINGS);
  const files = [
    ...(await newestFiles(p.logRoot, maxFiles)),
    ...(await newestFiles(p.traceRoot, maxFiles)),
  ];
  const findings: LogFinding[] = [];
  const query = options.query?.toLowerCase();
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (query && !line.toLowerCase().includes(query)) continue;
      const category = categorizeLogLine(line);
      if (!category) continue;
      findings.push({
        path: file,
        relativePath: isInside(file, p.documentsRoot) ? relativeTo(p.documentsRoot, file) : file,
        line: i + 1,
        category,
        text: line.length > 600 ? `${line.slice(0, 600)}...` : line,
      });
      if (findings.length >= maxFindings) return findings;
    }
  }
  return findings;
}

export async function strategyDebugBundle(strategy?: string, root = nt8DocumentsRoot()): Promise<unknown> {
  const p = nt8Paths(root);
  const conflictScan = await scanStrategyConflicts(strategy, root);
  const logFindings = await scanNt8Logs({ root, maxFiles: 8, maxFindings: 60, query: strategy });
  const fallbackLogFindings = logFindings.length > 0 ? logFindings : await scanNt8Logs({ root, maxFiles: 8, maxFindings: 60 });
  let strategySource: unknown = null;
  if (conflictScan.strategy) {
    strategySource = await readNinjaScriptFile(conflictScan.strategy.path, { root, maxChars: 60_000 });
  }
  return {
    documentsRoot: p.documentsRoot,
    generatedAtUtc: new Date().toISOString(),
    strategy: conflictScan.strategy,
    hostedIndicators: conflictScan.hostedIndicators,
    findings: conflictScan.findings,
    recentLogFindings: fallbackLogFindings,
    strategySource,
  };
}
