import { describe, expect, inject, it } from "vitest";
import ExcelJS from "exceljs";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { collectConditionalFormats } from "../src/metadata/conditional-formats.js";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { parseOoxml } from "../src/format/ooxml-workbook.js";
import { createHandlers } from "../src/tools/handlers.js";

function payload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected a text payload");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

interface FormattingHost {
  addConditionalFormatting(definition: Record<string, unknown>): void;
}

async function workbookWithFormats(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("K");
  const host = sheet as unknown as FormattingHost;
  host.addConditionalFormatting({
    ref: "A1:A9",
    rules: [
      {
        type: "cellIs",
        operator: "greaterThan",
        priority: 1,
        formulae: ["5"],
        style: {},
      },
    ],
  });
  host.addConditionalFormatting({
    ref: "B1:B9",
    rules: [
      {
        type: "colorScale",
        priority: 2,
        cfvo: [{ type: "min" }, { type: "percentile", value: 50 }],
        color: [{ argb: "FFFF0000" }],
      },
      {
        type: "top10",
        priority: 3,
        rank: 5,
        percent: true,
        bottom: false,
        style: {},
      },
    ],
  });
  host.addConditionalFormatting({
    ref: "C1:C9",
    rules: [
      { type: "timePeriod", timePeriod: "today", priority: 4, style: {} },
      { type: "aboveAverage", aboveAverage: true, priority: 5, style: {} },
      {
        type: "iconSet",
        priority: 6,
        iconSet: "3Arrows",
        cfvo: [{ type: "min" }, { type: "num", value: 3 }, { type: "max" }],
      },
    ],
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("the OOXML conditional format reader agrees with ExcelJS", () => {
  it("reports the same predicates for every rule kind", async () => {
    const bytes = await workbookWithFormats();

    const reference = new ExcelJS.Workbook();
    await reference.xlsx.load(Uint8Array.from(bytes).buffer);
    const host = reference.worksheets[0] as ExcelJS.Worksheet & {
      readonly conditionalFormattings?: readonly {
        readonly ref?: string;
        readonly rules?: readonly Record<string, unknown>[];
      }[];
    };
    const expected = (host.conditionalFormattings ?? []).flatMap((block) =>
      (block.rules ?? []).map((rule) => ({
        ref: block.ref,
        type: rule["type"],
        operator: rule["operator"],
        priority: rule["priority"],
        formulae: rule["formulae"],
        timePeriod: rule["timePeriod"],
        iconSet: rule["iconSet"],
        rank: rule["rank"],
        percent: rule["percent"],
        bottom: rule["bottom"],
        aboveAverage: rule["aboveAverage"],
      })),
    );

    const parsed = parseOoxml(bytes, "cf.xlsx");
    const actual = parsed.facts("K").conditionalFormats.flatMap((block) =>
      block.rules.map((rule) => ({
        ref: block.ref,
        type: rule.type,
        operator: rule.operator,
        priority: rule.priority,
        formulae: rule.formulae,
        timePeriod: rule.timePeriod,
        iconSet: rule.iconSet,
        rank: rule.rank,
        percent: rule.percent,
        bottom: rule.bottom,
        aboveAverage: rule.aboveAverage,
      })),
    );

    const order = (rows: readonly { priority?: unknown }[]) =>
      [...rows].sort(
        (left, right) =>
          Number(left.priority ?? 0) - Number(right.priority ?? 0),
      );
    expect(order(actual)).toEqual(order(expected));
  });

  it("folds the containsText family back into a type and an operator", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("K");
    (sheet as unknown as FormattingHost).addConditionalFormatting({
      ref: "A1:A9",
      rules: [
        {
          type: "containsText",
          operator: "containsText",
          text: "ara",
          priority: 1,
          style: {},
        },
      ],
    });
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const rules = parseOoxml(bytes, "text.xlsx").facts("K").conditionalFormats;
    expect(rules?.[0]?.rules[0]).toMatchObject({
      type: "containsText",
      operator: "containsText",
    });
  });
});

describe("conditional formats no longer need the ExcelJS metadata reader", () => {
  for (const file of ["prefixed.xlsx", "unnumbered-sheet.xlsx"]) {
    it(`reads the rules declared in ${file}, in priority order`, async () => {
      const fixtures = inject("fixtures");
      const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
      const result = await handlers.get_conditional_formats({
        filePath: file,
      });
      expect(result.isError).not.toBe(true);
      const body = payload(result);
      expect(body).toMatchObject({ sheet: "Veri", count: 2, complete: false });
      expect(body["rules"]).toEqual([
        {
          ranges: ["B1:B3"],
          rangesTruncated: false,
          type: "colorScale",
          priority: 1,
          thresholds: [
            { type: "min" },
            { type: "formula", formula: "AVERAGE($B$1:$B$3)" },
            { type: "max" },
          ],
        },
        {
          ranges: ["B1:B3"],
          rangesTruncated: false,
          type: "cellIs",
          priority: 2,
          operator: "greaterThan",
          formulae: ["10"],
        },
      ]);
    });

    it(`declares conditionalFormats as a capability for ${file}`, async () => {
      const fixtures = inject("fixtures");
      const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
      const body = payload(
        await handlers.describe_workbook({ filePath: file }),
      );
      const capabilities = body["capabilities"] as Record<string, boolean>;
      expect(capabilities["conditionalFormats"]).toBe(true);
      const sheets = body["sheets"] as readonly Record<string, unknown>[];
      expect(sheets[0]?.["conditionalFormatRuleCount"]).toBe(2);
    });
  }
});

describe("a formula threshold keeps its expression", () => {
  it("reports the text instead of marking the threshold unreadable", async () => {
    const fixtures = inject("fixtures");
    const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
    const body = payload(
      await handlers.get_conditional_formats({ filePath: "prefixed.xlsx" }),
    );
    const rules = body["rules"] as readonly Record<string, unknown>[];
    const thresholds = rules[0]?.["thresholds"] as readonly Record<
      string,
      unknown
    >[];
    expect(thresholds[1]).toEqual({
      type: "formula",
      formula: "AVERAGE($B$1:$B$3)",
    });
    expect(body["limitations"]).toEqual([]);
  });
});

describe("collectConditionalFormats on an empty sheet", () => {
  it("reports nothing without claiming completeness", () => {
    const report = collectConditionalFormats("S", []);
    expect(report).toMatchObject({ sheet: "S", count: 0, complete: false });
    expect(report.rules).toEqual([]);
  });
});
