import { describe, expect, inject, it } from "vitest";
import {
  aggregateSheet,
  type AggregateOptions,
} from "../src/grid/aggregate.js";
import { loadDocument, sheetSource } from "../src/format/document.js";
import type { SheetSource } from "../src/grid/sheet.js";
import { readSheet } from "../src/grid/read-sheet.js";
import type { SezzleeExcelError } from "../src/platform/errors.js";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
} from "../src/platform/paths.js";
import { largeRowCount } from "./fixtures/build.js";

const base: AggregateOptions = {
  metrics: [{ fn: "count" }],
  match: "all",
  headerRow: 1,
  headerRowSource: "default",
  columnMode: "auto",
  caseSensitive: false,
  mergedCells: "master",
  orderBy: "group",
  descending: false,
  maxGroups: 50,
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

describe("whole-sheet totals", () => {
  it("sums exactly over 20k integer rows", async () => {
    const result = aggregateSheet(await open("large.xlsx"), {
      ...base,
      metrics: [{ fn: "sum", column: "amount" }],
    });
    expect(result.rows[0]?.[0]).toBe(
      ((largeRowCount - 1) * largeRowCount * 3) / 2,
    );
    expect(result.scannedRows).toBe(largeRowCount - 1);
    expect(result.matchedRows).toBe(largeRowCount - 1);
  });

  it("stays small on the wire", async () => {
    const result = aggregateSheet(await open("large.xlsx"), {
      ...base,
      metrics: [{ fn: "sum", column: "amount" }, { fn: "count" }],
    });
    expect(JSON.stringify(result).length).toBeLessThan(700);
  });
});

describe("accounting", () => {
  it("keeps counted plus skipped equal to the matched rows", async () => {
    const result = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      columnMode: "letter",
      metrics: [{ fn: "sum", column: "B" }],
    });
    const metric = result.columns.find((column) => column.role === "metric");
    expect((metric?.counted ?? 0) + (metric?.skipped ?? 0)).toBe(
      result.matchedRows,
    );
  });

  it("reads numeric text, excludes error and boolean cells and reports why", async () => {
    const result = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      columnMode: "letter",
      metrics: [{ fn: "sum", column: "B" }],
    });
    expect(result.rows[0]?.[0]).toBe(10 + 12 + 20.5);
    expect(result.columnStats?.["B"]).toMatchObject({
      numbers: 2,
      texts: 1,
      textNumbers: 1,
      booleans: 1,
      errors: 1,
    });
    expect(result.readAs?.["B"]).toEqual([
      { type: "number", decimal: ".", group: "none" },
    ]);
  });

  it("sums only what every reading of a mixed-format column agrees on and names the rest", async () => {
    const result = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      metrics: [{ fn: "sum", column: "Amount" }],
    });
    expect(result.rows[0]?.[0]).toBe(8 + 9);
    const warnings = result.warnings ?? [];
    expect(
      warnings.some(
        (entry) =>
          entry.startsWith("H: values such as '1234.50'") &&
          entry.includes('[{"column":"H","type":"number","decimal":","}]'),
      ),
    ).toBe(true);
    expect(warnings).toContain(
      "H: 3 text cells do not read as a number, such as '1234.50', '1.234,56', 'x'; the totals exclude them.",
    );
    expect(warnings).toContain(
      `H: 1 cell looks like an identifier (a leading zero or more than 15 digits), such as '007'; the totals exclude them. If they are quantities, pass columns [{"column":"H","type":"number","decimal":"."}].`,
    );
  });

  it("reads a column with the marks columns names", async () => {
    const result = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      columns: [{ column: "Amount", type: "number", decimal: "." }],
      metrics: [{ fn: "sum", column: "Amount" }],
    });
    expect(result.rows[0]?.[0]).toBe(1234.5 + 7 + 8 + 9);
  });

  it("refuses a decimal mark that is also the group mark", async () => {
    const source = await open("analysis.xlsx");
    expect(
      await codeOf(() =>
        aggregateSheet(source, {
          ...base,
          columns: [
            { column: "Amount", type: "number", decimal: ",", group: "," },
          ],
          metrics: [{ fn: "sum", column: "Amount" }],
        }),
      ),
    ).toBe("invalid_argument");
  });
});

describe("null, not zero", () => {
  it("returns null for a sum with nothing to add", async () => {
    const result = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      columnMode: "letter",
      metrics: [
        { fn: "sum", column: "B" },
        { fn: "avg", column: "B" },
      ],
      where: [{ column: "A", op: "eq", value: "Bos" }],
    });
    expect(result.rows[0]?.[0]).toBeNull();
    expect(result.rows[0]?.[1]).toBeNull();
  });

  it("returns one row with count zero when nothing matches", async () => {
    const result = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      columnMode: "letter",
      metrics: [{ fn: "count" }, { fn: "sum", column: "B" }],
      where: [{ column: "A", op: "eq", value: "nowhere" }],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual([0, null]);
    expect(result.matchedRows).toBe(0);
  });
});

describe("floating point", () => {
  it("sums 500 tenths to exactly 50", async () => {
    const result = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      sheetName: "Floats",
      metrics: [{ fn: "sum", column: "small" }],
    });
    expect(result.rows[0]?.[0]).toBe(50);
  });

  it("beats naive summation on a mixed-magnitude column", async () => {
    const result = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      sheetName: "Floats",
      metrics: [{ fn: "sum", column: "mixed" }],
    });
    let naive = 0;
    for (let row = 2; row <= 501; row += 1) {
      naive += row % 100 === 0 ? 1e9 : 0.001;
    }
    const exact = 5 * 1e9 + 495 * 0.001;
    expect(Math.abs((result.rows[0]?.[0] as number) - exact)).toBeLessThan(
      Math.abs(naive - exact) + 1e-9,
    );
  });
});

describe("min and max", () => {
  it("works on dates and echoes the kind used", async () => {
    const result = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      metrics: [
        { fn: "min", column: "Date" },
        { fn: "max", column: "Date" },
      ],
    });
    expect(result.rows[0]?.[0]).toBe("2026-01-10");
    expect(result.rows[0]?.[1]).toBe("2026-01-15");
    expect(result.columns[0]?.kindUsed).toBe("date");
  });
});

describe("grouping", () => {
  it("keeps case and accent variants apart and says so", async () => {
    const result = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      groupBy: ["Region"],
      metrics: [{ fn: "count" }],
    });
    const labels = result.rows.map((row) => row[0]);
    expect(labels).toContain("İSTANBUL");
    expect(labels).toContain("istanbul");
    expect(
      result.warnings?.some((entry) => entry.includes("differ only by case")),
    ).toBe(true);
  });

  it("orders deterministically across runs", async () => {
    const loaded = await open("analysis.xlsx");
    const first = aggregateSheet(loaded, { ...base, groupBy: ["Region"] });
    const second = aggregateSheet(loaded, { ...base, groupBy: ["Region"] });
    expect(second.rows).toEqual(first.rows);
  });

  it("caps an exploding group-by and points at the fix", async () => {
    const result = aggregateSheet(await open("large.xlsx"), {
      ...base,
      groupBy: ["name"],
      metrics: [{ fn: "sum", column: "amount" }],
    });
    expect(result.groupCount).toBe(largeRowCount - 1);
    expect(result.returnedGroups).toBe(50);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("maxGroups");
    expect(result.hint).toContain("orderBy");
  });

  it("returns the true top group when ordered by metric", async () => {
    const result = aggregateSheet(await open("large.xlsx"), {
      ...base,
      groupBy: ["name"],
      metrics: [{ fn: "sum", column: "amount" }],
      orderBy: "metric",
      orderByMetric: 1,
      descending: true,
      maxGroups: 1,
    });
    expect(result.rows[0]).toEqual([
      `name-${largeRowCount - 1}`,
      (largeRowCount - 1) * 3,
    ]);
  });

  it("groups merged continuation rows under null under the master policy", async () => {
    const master = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      sheetName: "Merged",
      groupBy: ["Region"],
      metrics: [{ fn: "sum", column: "Total" }],
    });
    expect(master.rows).toContainEqual([null, 5]);

    const repeated = aggregateSheet(await open("analysis.xlsx"), {
      ...base,
      sheetName: "Merged",
      mergedCells: "repeat",
      groupBy: ["Region"],
      metrics: [{ fn: "sum", column: "Total" }],
    });
    expect(repeated.rows).toEqual([["EMEA", 6]]);
  });
});

describe("filtering", () => {
  it("intersects with match all and unions with match any", async () => {
    const loaded = await open("analysis.xlsx");
    const all = aggregateSheet(loaded, {
      ...base,
      columnMode: "letter",
      where: [
        { column: "A", op: "eq", value: "Ankara" },
        { column: "B", op: "gt", value: 15 },
      ],
    });
    expect(all.matchedRows).toBe(1);

    const any = aggregateSheet(loaded, {
      ...base,
      columnMode: "letter",
      match: "any",
      where: [
        { column: "A", op: "eq", value: "Ankara" },
        { column: "B", op: "gt", value: 15 },
      ],
    });
    expect(any.matchedRows).toBe(3);
  });
});

describe("failures", () => {
  it("refuses a duplicate header", async () => {
    const loaded = await open("analysis.xlsx");
    expect(
      await codeOf(() =>
        aggregateSheet(loaded, { ...base, groupBy: ["Total"] }),
      ),
    ).toBe("ambiguous_column");
  });

  it("refuses an unknown column", async () => {
    const loaded = await open("analysis.xlsx");
    expect(
      await codeOf(() =>
        aggregateSheet(loaded, { ...base, groupBy: ["Nope"] }),
      ),
    ).toBe("unknown_column");
  });

  it("refuses a metric without a column", async () => {
    const loaded = await open("analysis.xlsx");
    expect(
      await codeOf(() =>
        aggregateSheet(loaded, { ...base, metrics: [{ fn: "sum" }] }),
      ),
    ).toBe("invalid_argument");
  });

  it("refuses an empty sheet", async () => {
    const loaded = await open("empty.xlsx");
    expect(await codeOf(() => aggregateSheet(loaded, base))).toBe(
      "empty_sheet",
    );
  });
});

describe("csv", () => {
  it("sums a csv's numeric text without any option", async () => {
    const result = aggregateSheet(await open("csv/big.csv"), {
      ...base,
      metrics: [{ fn: "sum", column: "amount" }, { fn: "count" }],
    });
    expect(result.rows[0]?.[0]).toBe((999 * 1000 * 3) / 2);
    expect(result.rows[0]?.[1]).toBe(999);
  });
});

describe("a title band shifts the header row", () => {
  const invoices = async (headerRow: number) =>
    aggregateSheet(await open("title-band.xlsx"), {
      ...base,
      sheetName: "Faturalar",
      headerRow,
      headerRowSource: "explicit",
      metrics: [{ fn: "count" }],
    });

  it("counts the blank row and the header row as data at the default", async () => {
    const result = await invoices(1);
    expect(result.rows[0]?.[0]).toBe(8);
    expect(result.blankRows).toBe(1);
    expect(result.firstScannedRow).toBe(2);
  });

  it("still counts the header row as data one row down", async () => {
    expect((await invoices(2)).rows[0]?.[0]).toBe(7);
  });

  it("counts only the data rows on the real header row", async () => {
    const result = await invoices(3);
    expect(result.rows[0]?.[0]).toBe(6);
    expect(result.blankRows).toBe(0);
    expect(result.warnings).toBeUndefined();
  });

  it("warns and names the real header row at the default", async () => {
    const result = await invoices(1);
    expect(result.warnings?.[0]).toContain("headerRow 1");
    expect(result.warnings?.[0]).toContain("Row 3");
  });

  it("echoes where the header row came from", async () => {
    expect((await invoices(3)).headerRowSource).toBe("explicit");
  });

  it("stays silent on a sheet whose header row is row 1", async () => {
    const result = aggregateSheet(await open("q1/sample.xlsx"), base);
    expect(result.warnings).toBeUndefined();
  });
});

describe("merged header cells follow the requested merge policy", () => {
  const twoRow = async (extra: Partial<AggregateOptions>) =>
    aggregateSheet(await open("title-band.xlsx"), {
      ...base,
      sheetName: "IkiSatir",
      headerRow: 2,
      headerRowSource: "explicit",
      groupBy: ["Bolge"],
      metrics: [{ fn: "count" }, { fn: "sum", column: "Toplam" }],
      ...extra,
    });

  it("resolves a vertically merged header under repeat", async () => {
    const result = await twoRow({ mergedCells: "repeat" });
    expect(result.rows).toEqual([["EMEA", 3, 36]]);
  });

  it("cannot resolve that header under the default master policy", async () => {
    expect(await codeOf(() => twoRow({ mergedCells: "master" }))).toBe(
      "unknown_column",
    );
  });

  it("agrees with read_sheet about the headers under repeat", async () => {
    const loaded = await open("title-band.xlsx");
    const grid = readSheet(loaded, {
      sheetName: "IkiSatir",
      maxCells: 2000,
      valueMode: "values",
      mergedCells: "repeat",
      headerRow: 2,
      headerRowSource: "explicit",
      includeHyperlinks: false,
    });
    expect(grid.columns.map((column) => column.header)).toEqual([
      "Bolge",
      "Ocak",
      "Subat",
      "Toplam",
    ]);
    const totals = await twoRow({ mergedCells: "repeat" });
    expect(totals.columns[0]?.label).toBe("Bolge");
  });

  it("refuses a horizontally merged group label under repeat", async () => {
    const failure = await codeOf(() =>
      twoRow({
        headerRow: 1,
        mergedCells: "repeat",
        groupBy: ["Ceyrek 1"],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(failure).toBe("ambiguous_column");
  });

  it("names the letters that would disambiguate it", async () => {
    try {
      await twoRow({
        headerRow: 1,
        mergedCells: "repeat",
        groupBy: ["Ceyrek 1"],
        metrics: [{ fn: "count" }],
      });
      expect.unreachable();
    } catch (error) {
      const failure = error as SezzleeExcelError;
      expect(failure.recovery).toContain('"B"');
      expect(failure.recovery).toContain('"C"');
    }
  });

  it("leaves an unmerged sheet identical under both policies", async () => {
    const asMaster = aggregateSheet(await open("q1/sample.xlsx"), {
      ...base,
      mergedCells: "master",
    });
    const asRepeat = aggregateSheet(await open("q1/sample.xlsx"), {
      ...base,
      mergedCells: "repeat",
    });
    expect(asRepeat.rows).toEqual(asMaster.rows);
  });
});
