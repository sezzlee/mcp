import { describe, expect, inject, it } from "vitest";
import ExcelJS from "exceljs";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { parseOoxml } from "../src/format/ooxml-workbook.js";
import { collectTables, declaredTablesOf } from "../src/metadata/tables.js";
import { createHandlers } from "../src/tools/handlers.js";

function payload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected a text payload");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

interface TableHost {
  addTable(definition: Record<string, unknown>): void;
}

async function workbookWithTables(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("T");
  (sheet as unknown as TableHost).addTable({
    name: "Faturalar",
    ref: "A1",
    headerRow: true,
    totalsRow: true,
    columns: [
      { name: "Musteri", filterButton: true },
      { name: "Tutar", totalsRowFunction: "sum" },
      { name: "Not", totalsRowLabel: "Toplam" },
    ],
    rows: [["a", 1, "x"]],
  });
  (sheet as unknown as TableHost).addTable({
    name: "Kalemler",
    ref: "F1",
    headerRow: true,
    columns: [{ name: "Kod" }, { name: "Adet" }],
    rows: [["k", 2]],
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("the OOXML table reader agrees with ExcelJS", () => {
  it("reports the same tables, columns and flags", async () => {
    const bytes = await workbookWithTables();

    const reference = new ExcelJS.Workbook();
    await reference.xlsx.load(Uint8Array.from(bytes).buffer);
    const host = reference.worksheets[0] as ExcelJS.Worksheet & {
      readonly tables?: Record<string, { table?: Record<string, unknown> }>;
    };
    const expected = Object.values(host.tables ?? {})
      .map((entry) => entry.table)
      .filter((table): table is Record<string, unknown> => table !== undefined)
      .map((table) => ({
        name: table["name"],
        ref: table["tableRef"],
        headerRow: table["headerRow"],
        totalsRow: table["totalsRow"],
        autoFilterRef: table["autoFilterRef"],
        columns: (
          table["columns"] as readonly Record<string, unknown>[] | undefined
        )?.map((column) => ({
          name: column["name"],
          totalsRowFunction: column["totalsRowFunction"],
          totalsRowLabel: column["totalsRowLabel"],
          filterButton: column["filterButton"],
        })),
      }))
      .sort((left, right) => (left.name! < right.name! ? -1 : 1));

    const parsed = parseOoxml(bytes, "tables.xlsx");
    const actual = [...parsed.facts("T").tables]
      .map((table) => ({
        name: table.name,
        ref: table.ref,
        headerRow: table.headerRow,
        totalsRow: table.totalsRow,
        autoFilterRef: table.autoFilterRef,
        columns: table.columns.map((column) => ({
          name: column.name,
          totalsRowFunction: column.totalsRowFunction,
          totalsRowLabel: column.totalsRowLabel,
          filterButton: column.filterButton,
        })),
      }))
      .sort((left, right) => (left.name < right.name ? -1 : 1));

    expect(actual).toEqual(expected);
  });

  it("reports no tables for a sheet that declares none", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("T");
    sheet.getCell("A1").value = "a";
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(parseOoxml(bytes, "empty.xlsx").facts("T").tables).toEqual([]);
  });

  it("keeps a missing column name as a null position", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("T");
    (sheet as unknown as TableHost).addTable({
      name: "T",
      ref: "A1",
      headerRow: true,
      columns: [{ name: "one" }, { name: "two" }, { name: "three" }],
      rows: [[1, 2, 3]],
    });
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
    const tableXml = await zip.file("xl/tables/table1.xml")!.async("string");
    zip.file("xl/tables/table1.xml", tableXml.replace(' name="two"', ""));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const parsed = parseOoxml(bytes, "missing.xlsx");
    expect(declaredTablesOf(parsed.facts("T").tables)[0]?.columns).toEqual([
      "one",
      null,
      "three",
    ]);
    const report = collectTables("T", parsed.facts("T").tables);
    expect(report.warnings?.[0]).toMatchObject({
      code: "table_missing_names",
      message: expect.stringContaining("missing column names"),
    });
  });
});

describe("tables no longer need the ExcelJS metadata reader", () => {
  for (const file of ["prefixed.xlsx", "unnumbered-sheet.xlsx"]) {
    it(`reads the table declared in ${file}, mapping filterButton by colId`, async () => {
      const fixtures = inject("fixtures");
      const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
      const result = await handlers.get_tables({ filePath: file });
      expect(result.isError).not.toBe(true);
      const body = payload(result);
      expect(body).toMatchObject({ sheet: "Veri", count: 1 });
      expect(body["tables"]).toEqual([
        {
          name: "Kalemler",
          ref: "A1:B3",
          headerRow: true,
          totalsRow: false,
          autoFilterRef: "A1:B3",
          columns: [
            { name: "Ürün", letter: "A" },
            { name: "Adet", letter: "B", filterButton: true },
          ],
          columnsTruncated: false,
        },
      ]);
    });

    it(`declares tables as a capability for ${file}`, async () => {
      const fixtures = inject("fixtures");
      const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
      const body = payload(
        await handlers.describe_workbook({ filePath: file }),
      );
      const capabilities = body["capabilities"] as Record<string, boolean>;
      expect(capabilities["tables"]).toBe(true);
      const sheets = body["sheets"] as readonly Record<string, unknown>[];
      expect(sheets[0]?.["tableCount"]).toBe(1);
    });
  }
});
