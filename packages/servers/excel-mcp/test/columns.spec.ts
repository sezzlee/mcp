import { describe, expect, it } from "vitest";
import { buildColumnIndex, resolveColumn } from "../src/grid/columns.js";
import type { SezzleeExcelError } from "../src/platform/errors.js";
import type { GridBounds } from "../src/grid/range.js";

const bounds: GridBounds = { top: 1, left: 1, bottom: 10, right: 8 };
const headers = ["Region", "Total", "Date", "B", "Total", "", null, "İSTANBUL"];

const index = buildColumnIndex("Sales!A1:H10", bounds, 1, headers);
const letterOnly = buildColumnIndex(
  "Sales!A1:H10",
  bounds,
  0,
  headers.map(() => null),
);

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as SezzleeExcelError).code;
  }
  return "no-error";
}

describe("resolution", () => {
  it("resolves by header, folded", () => {
    expect(resolveColumn(index, "Region")).toBe(1);
    expect(resolveColumn(index, "region")).toBe(1);
    expect(resolveColumn(index, "istanbul")).toBe(8);
    expect(resolveColumn(index, "ıstanbul")).toBe(8);
  });

  it("falls back to the A1 letter", () => {
    expect(resolveColumn(index, "C")).toBe(3);
    expect(resolveColumn(index, "h")).toBe(8);
  });
});

describe("conflicts are errors", () => {
  it("refuses a duplicate header and names both letters", () => {
    expect(codeOf(() => resolveColumn(index, "Total"))).toBe(
      "ambiguous_column",
    );
    try {
      resolveColumn(index, "Total");
    } catch (error) {
      expect((error as SezzleeExcelError).recovery).toContain('"B"');
      expect((error as SezzleeExcelError).recovery).toContain('"E"');
    }
  });

  it("refuses a header that collides with a letter", () => {
    expect(codeOf(() => resolveColumn(index, "B"))).toBe("ambiguous_column");
  });

  it("columnMode breaks the header/letter collision both ways", () => {
    expect(resolveColumn(index, "B", "header")).toBe(4);
    expect(resolveColumn(index, "B", "letter")).toBe(2);
  });

  it("columnMode header still refuses a duplicate header", () => {
    expect(codeOf(() => resolveColumn(index, "Total", "header"))).toBe(
      "ambiguous_column",
    );
  });
});

describe("columns without header text", () => {
  it("is letter-addressable only", () => {
    expect(resolveColumn(index, "F")).toBe(6);
    expect(resolveColumn(index, "G")).toBe(7);
    expect(codeOf(() => resolveColumn(index, "2026"))).toBe("unknown_column");
  });

  it("explains that headerRow is 0", () => {
    expect(codeOf(() => resolveColumn(letterOnly, "Region"))).toBe(
      "unknown_column",
    );
    try {
      resolveColumn(letterOnly, "Region");
    } catch (error) {
      expect((error as SezzleeExcelError).recovery).toContain("headerRow is 0");
    }
  });
});

describe("unknown columns", () => {
  it("lists the resolvable columns", () => {
    try {
      resolveColumn(index, "Nope");
      expect.unreachable();
    } catch (error) {
      const failure = error as SezzleeExcelError;
      expect(failure.code).toBe("unknown_column");
      expect(failure.message).toContain("Sales!A1:H10");
      expect(failure.recovery).toContain("A (Region)");
      expect(failure.recovery).toContain("A..H");
    }
  });

  it("refuses a letter outside the range", () => {
    expect(codeOf(() => resolveColumn(index, "Z", "letter"))).toBe(
      "unknown_column",
    );
  });
});

describe("a header row that carries no text", () => {
  const blank = buildColumnIndex(
    "Sales!A1:H10",
    bounds,
    1,
    headers.map(() => null),
  );

  it("names the row that was read", () => {
    try {
      resolveColumn(blank, "Region");
      expect.unreachable();
    } catch (error) {
      expect((error as SezzleeExcelError).recovery).toContain(
        "row 1 (headerRow)",
      );
    }
  });

  it("offers the next call that would work", () => {
    try {
      resolveColumn(blank, "Region");
      expect.unreachable();
    } catch (error) {
      expect((error as SezzleeExcelError).recovery).toContain("Pass headerRow");
    }
  });

  it("does not offer headerRow advice when the sheet has headers", () => {
    try {
      resolveColumn(index, "Nope");
      expect.unreachable();
    } catch (error) {
      expect((error as SezzleeExcelError).recovery).not.toContain(
        "Pass headerRow",
      );
    }
  });
});

describe("a header row that holds a single title cell", () => {
  function recoveryOf(cells: readonly (string | null)[]): string {
    try {
      resolveColumn(
        buildColumnIndex("Sales!A1:H10", bounds, 1, cells),
        "Amount",
      );
    } catch (error) {
      return (error as SezzleeExcelError).recovery ?? "";
    }
    return "";
  }

  it("offers headerRow when the title sits in the first column", () => {
    expect(
      recoveryOf([
        "2026 Sales Report",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ]),
    ).toContain("Pass headerRow");
  });

  it("does not offer headerRow when the one label sits further right", () => {
    expect(
      recoveryOf([null, null, "Region", null, null, null, null, null]),
    ).not.toContain("Pass headerRow");
  });
});
