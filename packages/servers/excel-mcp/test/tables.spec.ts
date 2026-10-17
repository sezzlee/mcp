import { describe, expect, inject, it } from "vitest";
import { loadDocument, type LoadedWorkbook } from "../src/format/document.js";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
  type SandboxedPath,
} from "../src/platform/paths.js";
import { collectTables } from "../src/metadata/tables.js";

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
  return collectTables(sheet, loaded.workbook.facts(sheet).tables);
}

describe("collectTables", () => {
  it("reports every declared table, ordered by its top-left cell", async () => {
    const report = await facets("Tablolar");
    expect(report.count).toBe(2);
    expect(report.tables.map((table) => table.name)).toEqual([
      "Faturalar",
      "Kalemler",
    ]);
    expect(report.truncated).toBe(false);
  });

  it("derives column letters from a non-A origin", async () => {
    const report = await facets("Tablolar");
    const items = report.tables[1];
    expect(items?.ref).toBe("E1:F2");
    expect(items?.columns.map((column) => column.letter)).toEqual(["E", "F"]);
  });

  it("keeps the autofilter range apart from the table range", async () => {
    const report = await facets("Tablolar");
    const invoices = report.tables[0];
    expect(invoices?.ref).toBe("A1:C4");
    expect(invoices?.totalsRow).toBe(true);
    expect(invoices?.autoFilterRef).toBe("A1:C3");
  });

  it("omits a display name that repeats the name", async () => {
    const report = await facets("Tablolar");
    expect(report.tables.every((table) => !("displayName" in table))).toBe(
      true,
    );
  });

  it("drops the writer defaults instead of reporting them", async () => {
    const report = await facets("Tablolar");
    const columns = report.tables.flatMap((table) => table.columns);
    expect(columns.every((column) => column.totalsRowFunction !== "none")).toBe(
      true,
    );
    expect(columns.every((column) => column.filterButton !== false)).toBe(true);
    const items = report.tables[1];
    expect(
      items?.columns.every((column) => !("totalsRowLabel" in column)),
    ).toBe(true);
  });

  it("carries no style on a table or a column", async () => {
    const report = await facets("Tablolar");
    for (const table of report.tables) {
      expect("style" in table).toBe(false);
      for (const column of table.columns) {
        expect("style" in column).toBe(false);
        expect("dxfId" in column).toBe(false);
      }
    }
  });

  it("reports an empty list for a sheet with no table", async () => {
    const report = await facets("Bos");
    expect(report.count).toBe(0);
    expect(report.tables).toEqual([]);
  });
});
