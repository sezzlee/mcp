import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";
import { rawWorkbook } from "./fixtures/raw-workbook.js";

const styles = [
  '<numFmts count="5">',
  '<numFmt numFmtId="164" formatCode="[mm]:ss"/>',
  '<numFmt numFmtId="165" formatCode="[ss].00"/>',
  '<numFmt numFmtId="166" formatCode="[$EUR-407]#,##0.00"/>',
  '<numFmt numFmtId="167" formatCode="&quot;£&quot;#,##0.00"/>',
  '<numFmt numFmtId="168" formatCode="[$$-409]0.00"/>',
  '</numFmts><cellXfs count="9">',
  ...[0, 46, 164, 165, 9, 10, 166, 167, 168].map(
    (numFmtId) => `<xf numFmtId="${numFmtId}"/>`,
  ),
  "</cellXfs>",
].join("");

const numericRows = [
  '<row r="1"><c r="A1" s="1"><v>1.5</v></c><c r="B1" s="4"><v>0.25</v></c><c r="C1" s="6"><v>10</v></c><c r="D1" s="8"><v>2</v></c></row>',
  '<row r="2"><c r="A2" s="2"><v>0.0625</v></c><c r="B2" s="5"><v>0.5</v></c><c r="C2" s="6"><v>20</v></c><c r="D2" s="8"><v>3</v></c></row>',
  '<row r="3"><c r="A3" s="3"><v>-0.125</v></c><c r="B3" s="4"><v>0.125</v></c><c r="C3" s="7"><v>30</v></c><c r="D3" s="8"><v>4</v></c></row>',
].join("");

let directory: string;
let handlers: ToolHandlers;

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  expect(result.isError, content.text.slice(0, 300)).not.toBe(true);
  return JSON.parse(content.text) as Record<string, unknown>;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-native-format-"));
  handlers = createHandlers(await createWorkbookRoot(directory));
  for (const date1904 of [false, true]) {
    await writeFile(
      join(directory, date1904 ? "numeric-1904.xlsx" : "numeric.xlsx"),
      await rawWorkbook({
        sheetData: numericRows,
        styles,
        parts: date1904
          ? {
              "xl/workbook.xml":
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
            }
          : {},
      }),
    );
  }
  await writeFile(
    join(directory, "errors.xlsx"),
    await rawWorkbook({
      sheetData: [
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Group</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>',
        '<row r="2"><c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2" t="e"><v>#DIV/0!</v></c></row>',
        '<row r="3"><c r="A3" t="inlineStr"><is><t>a</t></is></c><c r="B3" t="e"><v>#N/A</v></c></row>',
        '<row r="4"><c r="A4" t="inlineStr"><is><t>b</t></is></c><c r="B4" t="e"><v>#DIV/0!</v></c></row>',
        '<row r="5"><c r="A5" t="inlineStr"><is><t>b</t></is></c><c r="B5"><v>4</v></c></row>',
        '<row r="6"><c r="A6" t="inlineStr"><is><t>c</t></is></c><c r="B6" t="inlineStr"><is><t>#N/A</t></is></c></row>',
        '<row r="7"><c r="A7" t="inlineStr"><is><t>c</t></is></c><c r="B7" t="e"><v>#SPILL!</v></c></row>',
      ].join(""),
    }),
  );
  const codes = [
    ...Array.from(
      { length: 36 },
      (_, at) => `#E${String(at).padStart(2, "0")}!`,
    ),
    `#${"x".repeat(1000)}`,
    `#${"x".repeat(1000)}`,
    "#E00!",
    "#E00!",
    "#E00!",
    "#E00!",
  ];
  await writeFile(
    join(directory, "error-limits.xlsx"),
    await rawWorkbook({
      sheetData: codes
        .map(
          (code, at) =>
            `<row r="${at + 1}"><c r="A${at + 1}" t="e"><v>${code}</v></c></row>`,
        )
        .join(""),
    }),
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("native XLSX numeric meaning", () => {
  it("reads elapsed hours, minutes and seconds independently of the date system", async () => {
    for (const filePath of ["numeric.xlsx", "numeric-1904.xlsx"]) {
      const result = body(
        await handlers.read_sheet({ filePath, headerRow: 0 }),
      );
      expect(result["values"]).toEqual([
        [{ durationSeconds: 129600 }, 0.25, 10, 2],
        [{ durationSeconds: 5400 }, 0.5, 20, 3],
        [{ durationSeconds: -10800 }, 0.125, 30, 4],
      ]);
    }
  });

  it("carries percentage and currency meaning into numeric totals", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "numeric.xlsx",
        headerRow: 0,
        columnMode: "letter",
        metrics: [
          { fn: "sum", column: "B" },
          { fn: "sum", column: "C" },
          { fn: "sum", column: "D" },
        ],
      }),
    );
    expect(result["rows"]).toEqual([[0.875, 60, 9]]);
    expect(result["columns"]).toMatchObject([
      { fn: "sum", unit: "fraction", counted: 3, skipped: 0 },
      { fn: "sum", mixedCurrencies: true, counted: 3, skipped: 0 },
      { fn: "sum", currency: "$", counted: 3, skipped: 0 },
    ]);
    expect(result["warnings"]).toEqual(
      expect.arrayContaining([expect.stringContaining("EUR, GBP")]),
    );
  });

  it("reports native errors by code and distinguishes skipped errors from counted values", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "errors.xlsx",
        metrics: [
          { fn: "sum", column: "Value" },
          { fn: "avg", column: "Value" },
          { fn: "countValues", column: "Value" },
          { fn: "countDistinct", column: "Value" },
        ],
      }),
    );
    expect(result["rows"]).toEqual([[4, 4, 5, 4]]);
    expect(result["columns"]).toMatchObject([
      { counted: 1, skipped: 5, skippedErrors: 4 },
      { counted: 1, skipped: 5, skippedErrors: 4 },
      { counted: 5, skipped: 1 },
      { counted: 5, skipped: 1 },
    ]);
    expect(result["errorDistribution"]).toEqual({
      scope: "metricInputs",
      total: 4,
      byCode: [
        { code: "#DIV/0!", count: 2, examples: ["B2", "B4"] },
        { code: "#N/A", count: 1, examples: ["B3"] },
        { code: "#SPILL!", count: 1, examples: ["B7"] },
      ],
    });
  });

  it("counts each enabled error input once across filtered metrics, pivots and grouping sets", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "errors.xlsx",
        groupBy: ["Group"],
        pivotBy: ["Group"],
        groupingSets: [{ groupBy: [] }],
        where: [{ column: "Group", op: "ne", value: "c" }],
        metrics: [
          {
            fn: "sum",
            column: "Value",
            where: [{ column: "Group", op: "eq", value: "a" }],
          },
          {
            fn: "avg",
            column: "B",
            where: [{ column: "Group", op: "eq", value: "b" }],
          },
        ],
      }),
    );
    expect(result["errorDistribution"]).toEqual({
      scope: "metricInputs",
      total: 3,
      byCode: [
        { code: "#DIV/0!", count: 2, examples: ["B2", "B4"] },
        { code: "#N/A", count: 1, examples: ["B3"] },
      ],
    });
  });

  it("bounds distinct error codes and examples while retaining exact overflow counts", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "error-limits.xlsx",
        headerRow: 0,
        columnMode: "letter",
        metrics: [
          { fn: "sum", column: "A" },
          { fn: "countValues", column: "A" },
        ],
        compact: true,
      }),
    );
    expect(result["rows"]).toEqual([[null, 42]]);
    expect(result["columns"]).toMatchObject([
      { counted: 0, skipped: 42, skippedErrors: 42 },
      { counted: 42, skipped: 0 },
    ]);
    expect(result["errorDistribution"]).toEqual({
      scope: "metricInputs",
      total: 42,
      byCode: [
        { code: "#E00!", count: 5, examples: ["A1", "A39", "A40"] },
        ...Array.from({ length: 31 }, (_, at) => ({
          code: `#E${String(at + 1).padStart(2, "0")}!`,
          count: 1,
          examples: [`A${at + 2}`],
        })),
      ],
      other: {
        count: 6,
        examples: [
          { cell: "A33", code: "#E32!" },
          { cell: "A34", code: "#E33!" },
          { cell: "A35", code: "#E34!" },
        ],
      },
    });
    expect(JSON.stringify(result).length).toBeLessThan(8000);
  });

  it("reports long native error codes with their original length and bounded text", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "error-limits.xlsx",
        range: "A37:A38",
        headerRow: 0,
        columnMode: "letter",
        metrics: [{ fn: "sum", column: "A" }],
      }),
    );
    expect(result["errorDistribution"]).toEqual({
      scope: "metricInputs",
      total: 2,
      byCode: [],
      other: {
        count: 2,
        examples: [
          { cell: "A37", code: `#${"x".repeat(127)}`, truncatedFrom: 1001 },
          { cell: "A38", code: `#${"x".repeat(127)}`, truncatedFrom: 1001 },
        ],
      },
    });
  });

  it("keeps unused error cells outside the metric-input distribution", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "errors.xlsx",
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([[6]]);
    expect(result["errorDistribution"]).toBeUndefined();
  });
});
