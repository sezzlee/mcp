import { beforeAll, describe, expect, inject, it } from "vitest";
import { documentSheet, loadDocument } from "../src/format/document.js";
import type { SezzleeExcelError } from "../src/platform/errors.js";
import {
  declaredHeaderRow,
  isHeaderCandidate,
  rowFacts,
  scanHeaderRow,
} from "../src/grid/header.js";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
  type WorkbookRoot,
} from "../src/platform/paths.js";
import { resolveRange, type GridBounds } from "../src/grid/range.js";
import {
  presentIndices,
  requireSheetBounds,
  type DeclaredTable,
  type SheetView,
} from "../src/grid/sheet.js";

describe("header row evidence", () => {
  let root: WorkbookRoot;

  beforeAll(async () => {
    root = await createWorkbookRoot(inject("fixtures").root);
  });

  const open = async (
    filePath: string,
    sheetName?: string,
  ): Promise<{ sheet: SheetView; bounds: GridBounds }> => {
    const loaded = await loadDocument(
      await resolveWorkbookPath(root, filePath),
    );
    const sheet = documentSheet(loaded, sheetName);
    return {
      sheet,
      bounds: resolveRange(requireSheetBounds(sheet), undefined),
    };
  };

  const codeOf = async (action: () => Promise<unknown>): Promise<string> => {
    try {
      await action();
    } catch (error) {
      return (error as SezzleeExcelError).code;
    }
    return "no-error";
  };

  it("does not count an empty string as naming or disqualifying", async () => {
    const { sheet, bounds } = await open("analysis.xlsx", "Sales");
    const facts = rowFacts(sheet, bounds, 1, "master");
    expect(facts.disqualifying).toBe(0);
    expect(isHeaderCandidate(facts)).toBe(true);
  });

  it("treats a merged title band as a non-candidate", async () => {
    const { sheet, bounds } = await open("title-band.xlsx", "Faturalar");
    expect(isHeaderCandidate(rowFacts(sheet, bounds, 1, "master"))).toBe(false);
    expect(isHeaderCandidate(rowFacts(sheet, bounds, 3, "master"))).toBe(true);
  });

  it("disqualifies a row that holds numbers", async () => {
    const { sheet, bounds } = await open("title-band.xlsx", "Faturalar");
    const facts = rowFacts(sheet, bounds, 4, "master");
    expect(facts.disqualifying).toBeGreaterThan(0);
    expect(isHeaderCandidate(facts)).toBe(false);
  });

  it("resolves the header row past a title band and a blank row", async () => {
    const { sheet, bounds } = await open("title-band.xlsx", "Faturalar");
    expect(scanHeaderRow(sheet, bounds, "master", "Faturalar")).toBe(3);
  });

  it.each([
    ["q1/sample.xlsx", undefined],
    ["wide.xlsx", undefined],
    ["large.xlsx", undefined],
    ["analysis.xlsx", "Sales"],
  ])("resolves row 1 for %s", async (filePath, sheetName) => {
    const { sheet, bounds } = await open(filePath, sheetName);
    expect(scanHeaderRow(sheet, bounds, "master", filePath)).toBe(1);
  });

  it("refuses to choose when two rows are both header rows", async () => {
    const { sheet, bounds } = await open("title-band.xlsx", "AllText");
    expect(
      await codeOf(async () =>
        scanHeaderRow(sheet, bounds, "master", "AllText"),
      ),
    ).toBe("ambiguous_header_row");
  });

  it("names the candidate rows so the agent can choose", async () => {
    const { sheet, bounds } = await open("title-band.xlsx", "AllText");
    try {
      scanHeaderRow(sheet, bounds, "master", "AllText");
      expect.unreachable();
    } catch (error) {
      const failure = error as SezzleeExcelError;
      expect(failure.recovery).toContain("Row 1");
      expect(failure.recovery).toContain("Row 2");
      expect(failure.recovery).toContain("headerRow 0 disables headers");
    }
  });

  it("refuses when no row is a header row", async () => {
    const { sheet, bounds } = await open("title-band.xlsx", "NoHeader");
    expect(
      await codeOf(async () =>
        scanHeaderRow(sheet, bounds, "master", "NoHeader"),
      ),
    ).toBe("unknown_header_row");
  });

  it("prefers a declared table over the text scan", async () => {
    const { sheet, bounds } = await open("title-band.xlsx", "Declared");
    const declared = declaredHeaderRow(sheet, bounds, "master");
    expect(declared?.row).toBe(3);
    expect(declared?.source).toContain("Faturalar");
    expect(scanHeaderRow(sheet, bounds, "master", "Declared")).toBe(3);
  });

  it("finds no declaration on a sheet that carries none", async () => {
    const { sheet, bounds } = await open("title-band.xlsx", "Faturalar");
    expect(declaredHeaderRow(sheet, bounds, "master")).toBeUndefined();
  });
});

describe("a table that omits headerRowCount", () => {
  const bounds: GridBounds = { top: 1, left: 1, bottom: 4, right: 3 };

  const sheetWith = (
    table: DeclaredTable,
    row: readonly (string | number | null)[],
  ): SheetView => ({
    name: "S",
    bounds,
    merges: [],
    tables: [table],
    autoFilter: undefined,
    hiddenRows: new Set<number>(),
    rowAt(at) {
      if (at !== 1) {
        return undefined;
      }
      return {
        cellAt(column) {
          const value = row[column - 1];
          if (value === undefined || value === null) {
            return undefined;
          }
          return { merged: false, value: { value } };
        },
        populatedColumns: ({ from, to }) => presentIndices(row, from, to),
      };
    },
    populatedRows: ({ from, to }) => (from <= 1 && to >= 1 ? [1] : []),
  });

  const named: DeclaredTable = {
    name: "Faturalar",
    ref: "A1:C4",
    headerRow: false,
    columns: ["Fatura No", "Tutar", "Kalan"],
  };

  it("reads the header row Excel left implicit", () => {
    const sheet = sheetWith(named, ["Fatura No", "Tutar", "Kalan"]);
    const declared = declaredHeaderRow(sheet, bounds, "master");
    expect(declared?.row).toBe(1);
    expect(declared?.source).toContain("Faturalar");
  });

  it("matches the declared names case- and accent-insensitively", () => {
    const sheet = sheetWith(named, ["FATURA NO", "TUTAR", "KALAN"]);
    expect(declaredHeaderRow(sheet, bounds, "master")?.row).toBe(1);
  });

  it("leaves a genuinely header-less table alone", () => {
    const headerless: DeclaredTable = {
      name: "Kalemler",
      ref: "A1:C4",
      headerRow: false,
      columns: ["Column1", "Column2", "Column3"],
    };
    const sheet = sheetWith(headerless, [1, 2, 3]);
    expect(declaredHeaderRow(sheet, bounds, "master")).toBeUndefined();
  });

  it("claims nothing when only some names match", () => {
    const sheet = sheetWith(named, ["Fatura No", "Tutar", "Bakiye"]);
    expect(declaredHeaderRow(sheet, bounds, "master")).toBeUndefined();
  });

  it("claims nothing when the table declares no column name", () => {
    const unnamed: DeclaredTable = {
      name: "Bos",
      ref: "A1:C4",
      headerRow: false,
      columns: [],
    };
    const sheet = sheetWith(unnamed, ["Fatura No", "Tutar", "Kalan"]);
    expect(declaredHeaderRow(sheet, bounds, "master")).toBeUndefined();
  });

  it("trusts an explicit headerRowCount without consulting the grid", () => {
    const explicit: DeclaredTable = { ...named, headerRow: true };
    const sheet = sheetWith(explicit, [null, null, null]);
    expect(declaredHeaderRow(sheet, bounds, "master")?.row).toBe(1);
  });
});
