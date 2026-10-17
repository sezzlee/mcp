import { beforeAll, describe, expect, inject, it } from "vitest";
import type { SezzleeExcelError } from "../src/platform/errors.js";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
  type SandboxedPath,
} from "../src/platform/paths.js";
import { selectSheetName } from "../src/format/ooxml-workbook.js";
import { requireSheetBounds } from "../src/grid/sheet.js";
import {
  clearDocumentCache,
  describeDocument,
  documentSheet,
  loadDocument,
  type LoadedWorkbook,
} from "../src/format/document.js";

async function codeOf(
  action: () => Promise<unknown> | unknown,
): Promise<string> {
  try {
    await action();
  } catch (error) {
    return (error as SezzleeExcelError).code;
  }
  return "no-error";
}

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

describe("describeWorkbook", () => {
  beforeAll(() => {
    clearDocumentCache();
  });

  it("reports the value-derived used range, not the declared one", async () => {
    const loaded = await loadXlsx(await pathTo("q1/sample.xlsx"));
    const description = describeDocument(
      loaded,
      {
        filePath: "q1/sample.xlsx",
        sizeBytes: loaded.sizeBytes,
        modifiedAt: loaded.modifiedAt,
      },
      true,
    );
    const sheet = description.sheets[0];
    expect(sheet?.name).toBe("Q1");
    expect(sheet?.usedRange).toBe("A1:F10");
    expect(sheet?.rowCount).toBe(10);
    expect(sheet?.declaredRowCount).toBe(5000);
  });

  it("counts formulas and their cached values apart", async () => {
    const loaded = await loadXlsx(await pathTo("q1/sample.xlsx"));
    const sheet = describeDocument(
      loaded,
      {
        filePath: "q1/sample.xlsx",
        sizeBytes: loaded.sizeBytes,
        modifiedAt: loaded.modifiedAt,
      },
      true,
    ).sheets[0];
    expect(sheet?.formulaCellCount).toBe(9);
    expect(sheet?.cachedFormulaValueCount).toBe(8);
  });

  it("reports merges, hidden sheets and the date system", async () => {
    const loaded = await loadXlsx(await pathTo("q1/sample.xlsx"));
    const description = describeDocument(
      loaded,
      {
        filePath: "q1/sample.xlsx",
        sizeBytes: loaded.sizeBytes,
        modifiedAt: loaded.modifiedAt,
      },
      true,
    );
    expect(description.dateSystem).toBe("1900");
    expect(description.sheets[0]?.mergeCount).toBe(1);
    expect(description.sheets[1]).toMatchObject({
      name: "Notes",
      state: "hidden",
      usedRange: null,
    });
  });

  it("counts the grid-external facets without walking cells", async () => {
    const loaded = await loadXlsx(await pathTo("facets.xlsx"));
    const described = describeDocument(
      loaded,
      {
        filePath: "facets.xlsx",
        sizeBytes: loaded.sizeBytes,
        modifiedAt: loaded.modifiedAt,
      },
      false,
    );
    const byName = new Map(
      described.sheets.map((sheet) => [sheet.name, sheet]),
    );
    expect(byName.get("Tablolar")).toMatchObject({
      tableCount: 2,
      conditionalFormatRuleCount: 0,
      autoFilterRef: "A1:C4",
      frozenRowCount: 1,
      frozenColumnCount: 1,
    });
    expect(byName.get("Kosullu")?.conditionalFormatRuleCount).toBe(5);
    expect(byName.get("Resimler")?.imageCount).toBe(2);
  });

  it("zeroes the facet counts for an xlsx sheet that carries none", async () => {
    const loaded = await loadXlsx(await pathTo("facets.xlsx"));
    const described = describeDocument(
      loaded,
      {
        filePath: "facets.xlsx",
        sizeBytes: loaded.sizeBytes,
        modifiedAt: loaded.modifiedAt,
      },
      false,
    );
    const bare = described.sheets.find((sheet) => sheet.name === "Bos");
    expect(bare).toMatchObject({
      tableCount: 0,
      conditionalFormatRuleCount: 0,
      imageCount: 0,
      autoFilterRef: null,
      frozenRowCount: 0,
      frozenColumnCount: 0,
    });
  });

  it("emits guidance for a tall sheet", async () => {
    const loaded = await loadXlsx(await pathTo("large.xlsx"));
    const description = describeDocument(
      loaded,
      {
        filePath: "large.xlsx",
        sizeBytes: loaded.sizeBytes,
        modifiedAt: loaded.modifiedAt,
      },
      false,
    );
    expect(description.guidance).toMatch(/rows/);
    expect(description.definedNames).toBeUndefined();
  });
});

describe("worksheet selection", () => {
  it("defaults to the first visible sheet", async () => {
    const loaded = await loadXlsx(await pathTo("q1/sample.xlsx"));
    expect(selectSheetName(loaded.workbook, undefined)).toBe("Q1");
  });

  it("lists every sheet, hidden ones included, when the name is wrong", async () => {
    const loaded = await loadXlsx(await pathTo("q1/sample.xlsx"));
    try {
      selectSheetName(loaded.workbook, "Nope");
      expect.unreachable();
    } catch (error) {
      const failure = error as SezzleeExcelError;
      expect(failure.code).toBe("unknown_sheet");
      expect(failure.recovery).toContain("Notes (hidden)");
    }
  });
});

describe("empty sheets", () => {
  it("has no used bounds", async () => {
    const loaded = await loadXlsx(await pathTo("empty.xlsx"));
    const sheet = documentSheet(loaded, undefined);
    expect(sheet.bounds).toBeUndefined();
    expect(await codeOf(() => requireSheetBounds(sheet))).toBe("empty_sheet");
  });
});

describe("unreadable files", () => {
  it("rejects a file that is not a zip container", async () => {
    expect(
      await codeOf(async () => loadXlsx(await pathTo("corrupt.xlsx"))),
    ).toBe("not_a_workbook");
  });

  it("rejects an encrypted or legacy container", async () => {
    expect(
      await codeOf(async () => loadXlsx(await pathTo("encrypted.xlsx"))),
    ).toBe("encrypted_workbook");
  });
});

describe("workbook cache", () => {
  it("returns the same instance for an unchanged file", async () => {
    clearDocumentCache();
    const path = await pathTo("q1/sample.xlsx");
    const first = await loadXlsx(path);
    const second = await loadXlsx(path);
    expect(second.workbook).toBe(first.workbook);
    expect(second.stamp).toBe(first.stamp);
  });
});
