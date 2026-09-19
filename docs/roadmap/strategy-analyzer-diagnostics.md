# Roadmap: Strategy Analyzer diagnostics MCP layer

Status: planned. This is not present in the current MCP server. The current server exposes
live AddOn market-structure state; this note records the next diagnostic layer needed for
strategy debugging and Strategy Analyzer work.

## What the owner needs

The MCP should let an LLM help diagnose why a NinjaTrader strategy is not behaving correctly in
Strategy Analyzer. The LLM needs more than live market-state snapshots: it needs the evidence a
human would gather while debugging a backtest.

The target is not fragile UI control. The target is a read-only evidence bundle the model can
inspect reliably:

- strategy source code,
- indicator dependencies,
- NinjaTrader log and trace files,
- Strategy Analyzer backtest logs,
- exported Analyzer results,
- screenshots when UI context is needed,
- data-series requirements,
- common NinjaScript conflict scans.

## Why this belongs next to the MCP

The server is already the controlled bridge between NinjaTrader state and an MCP client. A
diagnostic layer can extend that bridge so an LLM can answer questions such as:

- Why does this strategy compile but not trade?
- Which hosted indicator is adding data the hosting strategy did not preload?
- Are Strategy Analyzer settings conflicting with the strategy's assumptions?
- Are backtest logs showing data download, local-data, fill-resolution, or parameter issues?
- Which strategy version and parameter set produced a given result?

## Evidence sources

### 1. NinjaScript source

Read-only access to:

- `Documents\NinjaTrader 8\bin\Custom\Strategies`
- `Documents\NinjaTrader 8\bin\Custom\Indicators`
- selected AddOn framework files required by the strategy

The tool should never bulk-send every file by default. It should list files, read selected files,
and build focused dependency maps.

### 2. Logs and traces

Read-only access to:

- `Documents\NinjaTrader 8\log`
- `Documents\NinjaTrader 8\trace`

The first scans should extract:

- compile errors,
- runtime exceptions,
- Strategy Analyzer errors,
- `tried to load additional data` errors,
- order rejection messages,
- data connection/data download warnings,
- strategy-specific `Print()` output,
- timestamps and source file names where available.

### 3. Strategy Analyzer backtest logs

NinjaTrader documents that Strategy Analyzer saves logs for backtests, including test settings,
parameters, key results, notes, and for open/unlocked strategies, a saved snapshot version of the
code used for the backtest.

The MCP diagnostic layer should locate and summarize those logs, then connect them to the
current strategy source.

### 4. Exported results

Support a user-provided folder for CSV/HTML/image exports from Strategy Analyzer:

- summary performance,
- trades,
- optimization grid,
- walk-forward results,
- Monte Carlo results,
- screenshots.

The MCP can parse these files without controlling the Strategy Analyzer UI directly.

## Proposed MCP tools

### `nt8_environment`

Returns:

- NinjaTrader documents path,
- discovered version hints from logs,
- configured repo/workspace paths,
- whether live AddOn pipe is available,
- newest log/trace timestamps,
- detected Strategy Analyzer evidence folders.

### `ninja_script_files`

Lists strategies, indicators, AddOns, and selected framework files with:

- path,
- class names,
- namespace,
- last modified time,
- whether it contains generated NinjaScript wrapper code.

### `ninja_script_read`

Reads a selected strategy/indicator file with line numbers. This should require an explicit path
from `ninja_script_files`; it should not accept arbitrary unrestricted filesystem paths.

### `strategy_dependency_map`

For a named strategy, reports:

- hosted indicators,
- called generated wrapper methods,
- `AddDataSeries` calls,
- `BarsInProgress` routing,
- `CurrentBars[]` guards,
- entry/exit signal names,
- managed/unmanaged order mode,
- properties exposed to Strategy Analyzer.

### `strategy_conflict_scan`

Runs static checks for common NinjaTrader strategy conflicts:

- hosted indicators that call `AddDataSeries` without a matching strategy preload,
- `BarsInProgress` logic that returns before the required series is processed,
- missing `CurrentBars[index]` guards,
- duplicate class/enum names under `bin\Custom`,
- backup `.cs` files that still compile,
- strategy name/class name mismatch,
- repeated generated wrapper blocks,
- property enum duplication,
- `OnRender` calculation work,
- per-tick allocations/logging,
- order signal-name mismatches with `SetStopLoss` / `SetProfitTarget`.

### `nt8_log_scan`

Scans the latest log/trace files and returns high-signal findings only:

- error level,
- timestamp,
- source file if detectable,
- normalized category,
- suggested next file to inspect.

### `strategy_analyzer_logs`

Lists and summarizes Strategy Analyzer backtest logs when available:

- strategy name,
- instrument,
- data series,
- test type,
- date range,
- parameters,
- headline result metrics,
- notes/pinned state when available,
- code snapshot path or availability.

### `strategy_analyzer_import`

Parses exported Analyzer files dropped into a configured folder:

- performance summary,
- trade list,
- optimization table,
- walk-forward table,
- screenshots as metadata records.

### `strategy_debug_bundle`

Builds a single JSON/Markdown evidence bundle for an LLM:

- selected strategy source,
- dependency map,
- conflict scan,
- latest relevant log entries,
- Strategy Analyzer log summary,
- exported results summary,
- live MCP health and instrument state if the AddOn is running.

This should be the default tool a chat calls before proposing fixes.

## What not to do first

Do not make UI scraping the foundation. Strategy Analyzer is a desktop UI and direct visual
inspection depends on screen access. The durable MCP path is evidence-based: logs, source,
Analyzer logs, exports, and explicit screenshots.

Do not let the MCP write or delete NinjaScript files in V1. The first diagnostic version is
read-only. Fixes can be proposed as patches by the coding agent after the user approves.

Do not expose protected proprietary formulas beyond the source files the owner explicitly grants
to the debugging session.

## Immediate test case

Current local strategy-debug lane:

- `Strategies\TAZonesRetouchStrategyV2.cs`
- `Strategies\TAZonesRetouchStrategy.cs`
- `Indicators\TAZones.cs`
- latest files in `log\` and `trace\`

Known conflict family to scan first:

- hosted indicators that call `AddDataSeries(BarsPeriodType.Tick, 1)`,
- Strategy Analyzer/hosting-script errors that say additional data must be loaded by the hosting
  NinjaScript in `State.Configure`,
- near-duplicate strategy files that are not compile duplicates but can confuse manual testing.

## V1 build order

1. Add filesystem-scoped read tools for NinjaScript source, logs, traces, and Analyzer export
   folders.
2. Add static strategy conflict scanner.
3. Add latest-log/trace high-signal summarizer.
4. Add Strategy Analyzer export importer.
5. Add Strategy Analyzer log discovery if the storage path is confirmed.
6. Add `strategy_debug_bundle`.
7. Only after that, consider an optional UI/screenshot companion for visual Strategy Analyzer
   review.
