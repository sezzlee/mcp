import { describe, expect, inject, it } from "vitest";
import type { SezzleeExcelError } from "../src/platform/errors.js";
import { limits } from "../src/platform/limits.js";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
} from "../src/platform/paths.js";
import {
  findInSheet,
  readSheet,
  type ReadSheetOptions,
} from "../src/grid/read-sheet.js";
import { loadDocument, sheetSource } from "../src/format/document.js";
import type { SheetSource } from "../src/grid/sheet.js";
import { largeRowCount } from "./fixtures/build.js";

const loneSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isWellFormed(text: string): boolean {
  return !loneSurrogate.test(text);
}

const base: ReadSheetOptions = {
  maxCells: limits.maxCellsDefault,
  valueMode: "values",
  mergedCells: "master",
  headerRow: 1,
  headerRowSource: "default",
  includeHyperlinks: false,
};

async function open(file: string): Promise<SheetSource> {
  const fixtures = inject("fixtures");
  const root = await createWorkbookRoot(fixtures.root);
  return sheetSource(await loadDocument(await resolveWorkbookPath(root, file)));
}

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

describe("compact grid", () => {
  it("hoists headers out of the values grid", async () => {
    const result = readSheet(await open("q1/sample.xlsx"), base);
    expect(result.headerRow).toBe(1);
    expect(result.columns.map((column) => column.header)).toEqual([
      "Region",
      "Units",
      "Price",
      "Total",
      "Zero",
      "Share",
    ]);
    expect(result.values[0]?.[0]).toBe("EMEA0");
  });

  it("reports number formats per column", async () => {
    const result = readSheet(await open("q1/sample.xlsx"), base);
    expect(result.columns[2]?.numberFormat).toBe("$#,##0.00");
    expect(result.columns[5]?.numberFormat).toBe("0%");
  });

  it("keeps a cached zero and annotates uncached formulas", async () => {
    const result = readSheet(await open("q1/sample.xlsx"), base);
    expect(result.values[0]?.[4]).toBe(0);
    expect(result.cellNotes?.["A8"]).toEqual({
      kind: "formula",
      formula: "=NOCACHE()",
      cached: false,
    });
    expect(result.warnings?.[0]).toMatchObject({
      code: "uncached_formulas",
      message: expect.stringContaining("no cached value"),
    });
  });

  it("returns formula text in formulas mode", async () => {
    const result = readSheet(await open("q1/sample.xlsx"), {
      ...base,
      valueMode: "formulas",
    });
    expect(result.values[0]?.[3]).toBe("=B2*C2");
  });

  it("annotates every formula in both mode", async () => {
    const result = readSheet(await open("q1/sample.xlsx"), {
      ...base,
      valueMode: "both",
    });
    expect(result.values[0]?.[3]).toBeCloseTo(19.99);
    expect(result.cellNotes?.["D2"]).toEqual({
      kind: "formula",
      formula: "=B2*C2",
      cached: true,
    });
  });

  it("blanks merged continuation cells and lists the merge", async () => {
    const master = readSheet(await open("q1/sample.xlsx"), base);
    const mergedRow = master.values[master.values.length - 1];
    expect(mergedRow?.[0]).toBe("merged");
    expect(mergedRow?.[1]).toBeNull();
    expect(master.merges).toEqual(["A10:C10"]);

    const repeated = readSheet(await open("q1/sample.xlsx"), {
      ...base,
      mergedCells: "repeat",
    });
    expect(repeated.values[repeated.values.length - 1]?.[1]).toBe("merged");
  });

  it("lists only the merges of the rows a page returns", async () => {
    const source = await open("q1/sample.xlsx");
    const width = readSheet(source, base).columns.length;
    const first = readSheet(source, { ...base, maxCells: width * 2 });
    expect(first.rowNumbers).toEqual([2, 3]);
    expect(first.merges).toBeUndefined();
    expect(readSheet(source, { ...base, range: "10:10" }).merges).toEqual([
      "A10:C10",
    ]);
  });

  it("preserves positional alignment on sparse rows", async () => {
    const result = readSheet(await open("q1/sample.xlsx"), base);
    for (const line of result.values) {
      expect(line).toHaveLength(result.columns.length);
    }
  });

  it("honours an explicit range", async () => {
    const result = readSheet(await open("q1/sample.xlsx"), {
      ...base,
      range: "A2:B3",
    });
    expect(result.range).toBe("A2:B3");
    expect(result.values).toEqual([
      ["EMEA0", 1],
      ["EMEA1", 2],
    ]);
  });
});

describe("truncation and paging", () => {
  it("walks a large sheet without gaps or overlap", async () => {
    const loaded = await open("large.xlsx");
    let page = readSheet(loaded, { ...base, maxCells: 300 });
    expect(page.truncated).toBe(true);
    expect(page.truncationReason).toBe("maxCells");

    const seen: number[] = [];
    let guard = 0;
    while (page.nextCursor !== undefined && guard < 5) {
      for (const line of page.values) {
        seen.push(Number(line[0]));
      }
      page = readSheet(loaded, {
        ...base,
        cursor: page.nextCursor,
        maxCells: 300,
      });
      guard += 1;
    }
    expect(seen).toHaveLength(500);
    expect(seen[0]).toBe(1);
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBe((seen[index - 1] ?? 0) + 1);
    }
  });

  it("stops on the payload cap before the cell cap", async () => {
    const result = readSheet(await open("long-strings.xlsx"), {
      ...base,
      maxCells: 10_000,
    });
    expect(result.truncationReason).toBe("maxPayloadBytes");
    expect(result.returnedCells).toBeLessThan(10_000);
  });

  it("always returns at least one row", async () => {
    const result = readSheet(await open("large.xlsx"), {
      ...base,
      maxCells: 1,
    });
    expect(result.returnedRows).toBe(1);
    expect(result.nextCursor).toBeDefined();
  });

  it("reaches the end of the sheet", async () => {
    const loaded = await open("large.xlsx");
    const tail = readSheet(loaded, {
      ...base,
      range: `A${largeRowCount - 2}:C${largeRowCount}`,
      headerRow: 0,
    });
    expect(tail.truncated).toBe(false);
    expect(tail.nextCursor).toBeUndefined();
    expect(tail.returnedRows).toBe(3);
  });

  it("rejects a cursor combined with a range", async () => {
    const loaded = await open("large.xlsx");
    const page = readSheet(loaded, { ...base, maxCells: 30 });
    expect(
      await codeOf(() =>
        readSheet(loaded, { ...base, cursor: page.nextCursor, range: "A1:C9" }),
      ),
    ).toBe("invalid_argument");
  });

  it("rejects a cursor from a different workbook", async () => {
    const other = await open("q1/sample.xlsx");
    const page = readSheet(await open("large.xlsx"), { ...base, maxCells: 30 });
    expect(
      await codeOf(() =>
        readSheet(other, { ...base, cursor: page.nextCursor }),
      ),
    ).toBe("stale_cursor");
  });
});

describe("unicode safety", () => {
  it("never returns a lone surrogate from a truncated cell", async () => {
    const result = readSheet(await open("turkish.xlsx"), {
      ...base,
      range: "A6:A6",
      headerRow: 0,
    });
    const value = result.values[0]?.[0];
    expect(typeof value).toBe("string");
    expect(isWellFormed(String(value))).toBe(true);
    expect(result.cellNotes?.["A6"]).toEqual({
      kind: "truncated",
      length: 513,
    });
  });

  it("resolves a sheet name in either normalisation form", async () => {
    const loaded = await open("turkish.xlsx");
    const composed = readSheet(loaded, { ...base, sheetName: "Şubeler" });
    const decomposed = readSheet(loaded, {
      ...base,
      sheetName: "Şubeler".normalize("NFD"),
    });
    expect(decomposed.sheet).toBe(composed.sheet);
  });
});

describe("wire size", () => {
  it("keeps a 50x20 read far below the per-cell-object shape", async () => {
    const result = readSheet(await open("wide.xlsx"), {
      ...base,
      maxCells: 1000,
    });
    expect(result.returnedRows).toBe(49);
    expect(result.columns).toHaveLength(20);
    expect(JSON.stringify(result).length).toBeLessThan(12_000);
  });
});

describe("findInSheet", () => {
  const find = {
    matchMode: "contains" as const,
    caseSensitive: false,
    searchIn: "values" as const,
    maxResults: limits.defaultFindResults,
  };

  it("finds a value by substring", async () => {
    const result = await findInSheet(await open("q1/sample.xlsx"), {
      ...find,
      query: "EMEA2",
    });
    expect(result.matches).toEqual([
      { address: "A4", row: 4, column: 1, value: "EMEA2" },
    ]);
  });

  it("matches formulas when asked", async () => {
    const result = await findInSheet(await open("q1/sample.xlsx"), {
      ...find,
      query: "NOCACHE",
      searchIn: "formulas",
    });
    expect(result.matches[0]?.address).toBe("A8");
  });

  it("truncates at maxResults but reports the total", async () => {
    const result = await findInSheet(await open("large.xlsx"), {
      ...find,
      query: "name-",
      maxResults: 5,
    });
    expect(result.matches).toHaveLength(5);
    expect(result.total).toBe(largeRowCount - 1);
    expect(result.truncated).toBe(true);
  });

  it("rejects an oversized regular expression", async () => {
    const loaded = await open("q1/sample.xlsx");
    expect(
      await codeOf(() =>
        findInSheet(loaded, {
          ...find,
          matchMode: "regex",
          query: "a".repeat(limits.maxRegexSource + 1),
        }),
      ),
    ).toBe("invalid_pattern");
  });

  it("rejects Unicode property escapes", async () => {
    const loaded = await open("q1/sample.xlsx");
    expect(
      await codeOf(() =>
        findInSheet(loaded, { ...find, matchMode: "regex", query: "\\p{L}+" }),
      ),
    ).toBe("invalid_pattern");
  });

  it("folds case and diacritics by default", async () => {
    const loaded = await open("turkish.xlsx");
    for (const query of ["istanbul", "İSTANBUL", "ıstanbul", "Istanbul"]) {
      const result = await findInSheet(loaded, { ...find, query });
      expect(result.matching).toBe("folded");
      expect(result.total).toBeGreaterThan(0);
    }
    expect(
      (await findInSheet(loaded, { ...find, query: "sisli" })).total,
    ).toBeGreaterThan(0);
    expect(
      (await findInSheet(loaded, { ...find, query: "ogrenci" })).total,
    ).toBeGreaterThan(0);
  });

  it("reports canonical matching when case sensitive", async () => {
    const loaded = await open("turkish.xlsx");
    const result = await findInSheet(loaded, {
      ...find,
      query: "istanbul",
      caseSensitive: true,
    });
    expect(result.matching).toBe("canonical");
    expect(result.total).toBe(0);
  });
});
