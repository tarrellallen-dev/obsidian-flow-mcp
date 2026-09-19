import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listNinjaScriptFiles,
  scanStrategyConflicts,
} from "../src/diagnostics/nt8Diagnostics.js";

let root: string;

async function writeScript(relativePath: string, source: string): Promise<void> {
  const filePath = path.join(root, "bin", "Custom", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, source, "utf8");
}

describe("NT8 diagnostics", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "of-nt8-diagnostics-"));
    await mkdir(path.join(root, "log"), { recursive: true });
    await mkdir(path.join(root, "trace"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("summarizes user-authored classes without NinjaTrader generated wrapper classes", async () => {
    await writeScript(
      "Indicators/MySignal.cs",
      `
namespace NinjaTrader.NinjaScript.Indicators.ObsidianFlowIndicators
{
  public class MySignal : Indicator
  {
    protected override void OnStateChange()
    {
      if (State == State.Configure)
        AddDataSeries(BarsPeriodType.Tick, 1);
    }
  }
}

#region NinjaScript generated code
namespace NinjaTrader.NinjaScript.Indicators
{
  public partial class Indicator
  {
    public MySignal MySignal() { return null; }
  }
}
namespace NinjaTrader.NinjaScript.Strategies
{
  public partial class Strategy {}
}
#endregion
`,
    );

    const files = await listNinjaScriptFiles("indicators", root);

    expect(files).toHaveLength(1);
    expect(files[0]?.classes).toEqual(["MySignal"]);
    expect(files[0]?.addDataSeries).toEqual(["BarsPeriodType.Tick, 1"]);
  });

  it("reports hosted indicator data-series requirements for Strategy Analyzer debugging", async () => {
    await writeScript(
      "Indicators/MySignal.cs",
      `
namespace NinjaTrader.NinjaScript.Indicators.ObsidianFlowIndicators
{
  public class MySignal : Indicator
  {
    protected override void OnStateChange()
    {
      if (State == State.Configure)
        AddDataSeries(BarsPeriodType.Tick, 1);
    }
  }
}
`,
    );
    await writeScript(
      "Strategies/MyStrategy.cs",
      `
using NinjaTrader.NinjaScript.Indicators.ObsidianFlowIndicators;

namespace NinjaTrader.NinjaScript.Strategies
{
  public class MyStrategy : Strategy
  {
    protected override void OnStateChange()
    {
      if (State == State.DataLoaded)
        MySignal();
    }
  }
}
`,
    );

    const scan = await scanStrategyConflicts("MyStrategy", root);

    expect(scan.strategy?.classes).toEqual(["MyStrategy"]);
    expect(scan.hostedIndicators.map((file) => file.classes[0])).toEqual(["MySignal"]);
    expect(scan.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "missing-host-series",
          severity: "error",
        }),
      ]),
    );
  });
});
