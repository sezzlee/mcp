import type { CallToolResult } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, inject, it } from "vitest";
import {
  capabilities,
  type FormatCapabilities,
} from "../src/platform/capabilities.js";
import { createWorkbookRoot } from "../src/platform/paths.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

function payload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("the tool returned no text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

function unsupported(result: CallToolResult): boolean {
  return (
    result.isError === true &&
    payload(result)["error"] === "unsupported_for_format"
  );
}

function unreadableKind(result: CallToolResult): boolean {
  return (
    result.isError === true &&
    payload(result)["error"] === "unsupported_object_kind"
  );
}

const files: Readonly<Record<"xlsx" | "csv", string>> = {
  xlsx: "q1/sample.xlsx",
  csv: "csv/simple.csv",
};

describe("declared capabilities match observed behaviour", () => {
  let handlers: ToolHandlers;

  beforeAll(async () => {
    const fixtures = inject("fixtures");
    handlers = createHandlers(await createWorkbookRoot(fixtures.root));
  });

  const probes: Readonly<
    Record<
      keyof FormatCapabilities,
      (filePath: string) => Promise<CallToolResult>
    >
  > = {
    merges: (filePath) => handlers.get_merged_ranges({ filePath }),
    frozenPanes: (filePath) => handlers.describe_workbook({ filePath }),
    dataValidations: (filePath) => handlers.get_data_validations({ filePath }),
    formulas: (filePath) =>
      handlers.read_sheet({ filePath, valueMode: "formulas" }),
    hyperlinks: (filePath) =>
      handlers.read_sheet({ filePath, includeHyperlinks: true }),
    numberFormats: (filePath) =>
      handlers.read_sheet({ filePath, mergedCells: "repeat" }),
    multipleSheets: (filePath) =>
      handlers.read_sheet({ filePath, mergedCells: "repeat" }),
    definedNames: (filePath) => handlers.describe_workbook({ filePath }),
    typedValues: (filePath) => handlers.read_sheet({ filePath }),
    headerScan: (filePath) =>
      handlers.read_sheet({ filePath, headerScan: true }),
    tables: (filePath) => handlers.get_tables({ filePath }),
    conditionalFormats: (filePath) =>
      handlers.get_conditional_formats({ filePath }),
    images: (filePath) => handlers.get_images({ filePath }),
    charts: (filePath) => handlers.get_charts({ filePath }),
    pivotTables: (filePath) =>
      handlers.get_images({ filePath, kind: "pivotTable" }),
    sparklines: (filePath) =>
      handlers.get_images({ filePath, kind: "sparkline" }),
  };

  const gated: readonly (keyof FormatCapabilities)[] = [
    "merges",
    "dataValidations",
    "formulas",
    "hyperlinks",
    "headerScan",
    "tables",
    "conditionalFormats",
    "images",
    "charts",
  ];

  const unreadable: readonly (keyof FormatCapabilities)[] = [
    "pivotTables",
    "sparklines",
  ];

  for (const format of ["xlsx", "csv"] as const) {
    for (const flag of gated) {
      it(`${format}: ${flag} is ${capabilities[format][flag] ? "usable" : "refused"}`, async () => {
        const result = await probes[flag](files[format]);
        expect(unsupported(result)).toBe(!capabilities[format][flag]);
      });
    }
  }

  for (const format of ["xlsx", "csv"] as const) {
    for (const flag of unreadable) {
      it(`${format}: ${flag} is refused as an unreadable kind`, async () => {
        expect(capabilities[format][flag]).toBe(false);
        const result = await probes[flag](files[format]);
        expect(unreadableKind(result)).toBe(true);
      });
    }
  }

  it("csv declares and delivers untyped values", async () => {
    expect(capabilities.csv.typedValues).toBe(false);
    const body = payload(await handlers.read_sheet({ filePath: files.csv }));
    const rows = body["values"] as unknown[][];
    expect(rows.flat().every((cell) => typeof cell === "string")).toBe(true);
  });

  it("xlsx declares and delivers typed values", async () => {
    expect(capabilities.xlsx.typedValues).toBe(true);
    const body = payload(await handlers.read_sheet({ filePath: files.xlsx }));
    const rows = body["values"] as unknown[][];
    expect(rows.flat().some((cell) => typeof cell === "number")).toBe(true);
  });

  it("csv declares and delivers no number formats", async () => {
    expect(capabilities.csv.numberFormats).toBe(false);
    const body = payload(await handlers.read_sheet({ filePath: files.csv }));
    const columns = body["columns"] as { numberFormat: unknown }[];
    expect(columns.every((column) => column.numberFormat === null)).toBe(true);
  });

  it("csv declares and delivers a single sheet", async () => {
    expect(capabilities.csv.multipleSheets).toBe(false);
    const body = payload(
      await handlers.describe_workbook({ filePath: files.csv }),
    );
    expect((body["sheets"] as unknown[]).length).toBe(1);
    const wrong = await handlers.read_sheet({
      filePath: files.csv,
      sheetName: "Sheet1",
    });
    expect(payload(wrong)["error"]).toBe("unknown_sheet");
  });

  it("csv declares and delivers no defined names", async () => {
    expect(capabilities.csv.definedNames).toBe(false);
    const body = payload(
      await handlers.describe_workbook({ filePath: files.csv }),
    );
    expect(body["definedNames"]).toBeUndefined();
  });

  it("reports the format and the capability block on every describe", async () => {
    for (const format of ["xlsx", "csv"] as const) {
      const body = payload(
        await handlers.describe_workbook({ filePath: files[format] }),
      );
      expect(body["format"]).toBe(format);
      expect(body["capabilities"]).toEqual(capabilities[format]);
    }
  });

  it("nulls the inapplicable sheet metrics for csv instead of zeroing them", async () => {
    const body = payload(
      await handlers.describe_workbook({ filePath: files.csv }),
    );
    const sheet = (body["sheets"] as Record<string, unknown>[])[0];
    expect(sheet).toMatchObject({
      declaredRowCount: null,
      mergeCount: null,
      dataValidationRuleCount: null,
      formulaCellCount: null,
      cachedFormulaValueCount: null,
      tableCount: null,
      conditionalFormatRuleCount: null,
      imageCount: null,
      chartCount: null,
      autoFilterRef: null,
      frozenRowCount: null,
      frozenColumnCount: null,
    });
    expect(sheet?.["kind"]).toBe("worksheet");
    expect(body["dateSystem"]).toBeNull();
  });

  it("echoes the csv report on every csv-bearing response", async () => {
    const described = payload(
      await handlers.describe_workbook({ filePath: files.csv }),
    );
    const read = payload(await handlers.read_sheet({ filePath: files.csv }));
    const found = payload(
      await handlers.find_in_sheet({ filePath: files.csv, query: "01234" }),
    );
    for (const body of [described, read, found]) {
      expect(body["csv"]).toMatchObject({
        delimiter: "comma",
        delimiterSource: "sniffed",
      });
    }
    expect(
      payload(await handlers.read_sheet({ filePath: files.xlsx }))["csv"],
    ).toBeUndefined();
  });
});
