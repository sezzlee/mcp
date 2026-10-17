import { describe, expect, inject, it } from "vitest";
import { collectConditionalFormats } from "../src/metadata/conditional-formats.js";
import { loadDocument, type LoadedWorkbook } from "../src/format/document.js";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
  type SandboxedPath,
} from "../src/platform/paths.js";

async function pathTo(file: string): Promise<SandboxedPath> {
  const fixtures = inject("fixtures");
  const root = await createWorkbookRoot(fixtures.root);
  return resolveWorkbookPath(root, file);
}

async function loadXlsx(path: SandboxedPath): Promise<LoadedWorkbook> {
  const loaded = await loadDocument(path);
  if (loaded.format !== "xlsx") {
    throw new Error("expected an xlsx fixture");
  }
  return loaded;
}

async function facets(sheet: string) {
  const loaded = await loadXlsx(await pathTo("facets.xlsx"));
  return collectConditionalFormats(
    sheet,
    loaded.workbook.facts(sheet).conditionalFormats,
  );
}

describe("collectConditionalFormats", () => {
  it("counts rules rather than the blocks that carry them", async () => {
    const report = await facets("Kosullu");
    expect(report.count).toBe(5);
    expect(report.rules).toHaveLength(5);
    expect(report.truncated).toBe(false);
    expect(report.rangesTruncated).toBe(false);
  });

  it("splits a multi-range sqref into separate ranges", async () => {
    const report = await facets("Kosullu");
    const first = report.rules[0];
    expect(first?.ranges).toEqual(["B2:B20", "D2:D20"]);
  });

  it("orders rules by the priority Excel evaluates them in", async () => {
    const report = await facets("Kosullu");
    expect(report.rules.map((rule) => rule.priority)).toEqual([1, 2, 3, 4, 5]);
    expect(report.rules.map((rule) => rule.type)).toEqual([
      "cellIs",
      "expression",
      "colorScale",
      "dataBar",
      "iconSet",
    ]);
  });

  it("reports the predicate and never the effect", async () => {
    const report = await facets("Kosullu");
    for (const rule of report.rules) {
      expect("style" in rule).toBe(false);
      expect("color" in rule).toBe(false);
      expect("x14Id" in rule).toBe(false);
      expect("dxfId" in rule).toBe(false);
    }
  });

  it("keeps the thresholds of a scale and drops its bar geometry", async () => {
    const report = await facets("Kosullu");
    const bar = report.rules.find((rule) => rule.type === "dataBar");
    expect(bar?.thresholds).toEqual([{ type: "min" }, { type: "max" }]);
    for (const dropped of [
      "minLength",
      "maxLength",
      "gradient",
      "axisPosition",
      "direction",
      "border",
    ]) {
      expect(dropped in (bar ?? {})).toBe(false);
    }
    const scale = report.rules.find((rule) => rule.type === "colorScale");
    expect(scale?.thresholds).toEqual([
      { type: "min" },
      { type: "percentile", value: 90 },
    ]);
  });

  it("keeps the icon set family and drops its presentation flags", async () => {
    const report = await facets("Kosullu");
    const icons = report.rules.find((rule) => rule.type === "iconSet");
    expect(icons?.iconSet).toBe("3TrafficLights1");
    expect("reverse" in (icons ?? {})).toBe(false);
    expect("showValue" in (icons ?? {})).toBe(false);
  });

  it("carries the searched text inside the formula it was compiled into", async () => {
    const report = await facets("Kosullu");
    const expression = report.rules.find((rule) => rule.type === "expression");
    expect(expression?.formulae).toEqual(["$B2>$C2"]);
    expect("text" in (expression ?? {})).toBe(false);
  });

  it("reports an empty list for a sheet with no rule", async () => {
    const report = await facets("Bos");
    expect(report.count).toBe(0);
    expect(report.rules).toEqual([]);
  });
});
