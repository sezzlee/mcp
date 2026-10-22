import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeCell,
  type NormalizeOptions,
} from "../src/grid/cell-value.js";
import { ooxmlSnapshot } from "../src/format/ooxml-cell.js";
import type { RawValue } from "../src/metadata/spreadsheetml/cells.js";
import { limits } from "../src/platform/limits.js";

const values: NormalizeOptions = {
  valueMode: "values",
  mergePolicy: "master",
  includeHyperlinks: false,
};

const snapshot = ({
  value,
  formula,
  numberFormat = "General",
  href,
  merged = false,
}: {
  readonly value: RawValue;
  readonly formula?: string;
  readonly numberFormat?: string;
  readonly href?: string;
  readonly merged?: boolean;
}) =>
  ooxmlSnapshot({
    value,
    formula,
    numberFormat,
    date1904: false,
    href,
    merged,
  });

const text = (value: string): RawValue => ({ kind: "string", value });

/**
 * Serials from Excel's 1900 date system: 46037 is 15 January 2026, and
 * 0.395833… of a day is 09:30.
 */
const january15 = 46037;
const january15At0930 = 46037 + 9.5 / 24;

describe("scalars", () => {
  it("keeps null and empty string apart", () => {
    expect(
      normalizeCell(snapshot({ value: { kind: "none" } }), values).value,
    ).toBeNull();
    expect(normalizeCell(snapshot({ value: text("") }), values).value).toBe("");
  });

  it("passes numbers and booleans through", () => {
    expect(
      normalizeCell(snapshot({ value: { kind: "number", value: 0 } }), values)
        .value,
    ).toBe(0);
    expect(
      normalizeCell(
        snapshot({ value: { kind: "boolean", value: false } }),
        values,
      ).value,
    ).toBe(false);
  });

  it("renders a midnight date as a calendar day", () => {
    const cell = snapshot({
      value: { kind: "number", value: january15 },
      numberFormat: "yyyy-mm-dd",
    });
    expect(normalizeCell(cell, values).value).toBe("2026-01-15");
  });

  it("renders a timed date as a zoneless wall clock", () => {
    const cell = snapshot({
      value: { kind: "number", value: january15At0930 },
      numberFormat: "yyyy-mm-dd hh:mm",
    });
    expect(normalizeCell(cell, values).value).toBe("2026-01-15T09:30:00.000");
  });

  it("keeps the time when the format carries a time token", () => {
    const cell = snapshot({
      value: { kind: "number", value: january15 },
      numberFormat: "yyyy-mm-dd hh:mm",
    });
    expect(normalizeCell(cell, values).value).toBe("2026-01-15T00:00:00.000");
  });

  it("refuses a non-finite number", () => {
    expect(() =>
      snapshot({ value: { kind: "number", value: Number.POSITIVE_INFINITY } }),
    ).toThrow(expect.objectContaining({ code: "numeric_overflow" }));
  });

  it("tags error cells from the stored text", () => {
    const cell = snapshot({ value: { kind: "error", value: "#DIV/0!" } });
    expect(normalizeCell(cell, values).value).toEqual({ error: "#DIV/0!" });
  });

  it("names an error cell that stores no text", () => {
    const cell = snapshot({ value: { kind: "error", value: "" } });
    expect(normalizeCell(cell, values).value).toEqual({ error: "#ERROR!" });
  });

  it("returns hyperlink text and hides the href by default", () => {
    const cell = snapshot({
      value: text("Docs"),
      href: "https://example.test",
    });
    expect(normalizeCell(cell, values)).toEqual({ value: "Docs" });
    expect(normalizeCell(cell, { ...values, includeHyperlinks: true })).toEqual(
      {
        value: "Docs",
        note: { kind: "hyperlink", href: "https://example.test" },
      },
    );
  });

  it("truncates long strings and records the original length", () => {
    const long = "x".repeat(limits.maxStringChars + 7);
    const result = normalizeCell(snapshot({ value: text(long) }), values);
    expect(String(result.value)).toHaveLength(limits.maxStringChars);
    expect(result.note).toEqual({ kind: "truncated", length: long.length });
  });
});

describe("an ISO date cell without a zone", () => {
  const hostZone = process.env.TZ;
  afterEach(() => {
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
  });

  /**
   * Guard: on a UTC host the zone-less reading and the UTC reading agree, so
   * the host zone is moved off UTC to make the difference observable.
   */
  it("reads the same wall clock whatever the host zone", () => {
    process.env.TZ = "Asia/Tokyo";
    const cell = snapshot({
      value: { kind: "date", value: "2026-01-15T09:30:00" },
      numberFormat: "yyyy-mm-dd hh:mm",
    });
    expect(normalizeCell(cell, values).value).toBe("2026-01-15T09:30:00.000");
  });

  it("keeps the wall clock and offset a date cell was written with", () => {
    process.env.TZ = "Asia/Tokyo";
    const cell = snapshot({
      value: { kind: "date", value: "2026-01-15T09:30:00+03:00" },
      numberFormat: "yyyy-mm-dd hh:mm",
    });
    expect(normalizeCell(cell, values).value).toBe(
      "2026-01-15T09:30:00.000+03:00",
    );
  });

  it.each([
    ["2026-01-15", "2026-01-15"],
    ["2026-01-15T09:30", "2026-01-15T09:30:00.000"],
    ["2026-01-15 09:30:15.1239", "2026-01-15T09:30:15.123"],
    ["2026-01-15T09:30:00-0530", "2026-01-15T09:30:00.000-05:30"],
    ["2026-01-15T09:30:00z", "2026-01-15T09:30:00.000Z"],
    ["0001-01-01", "0001-01-01"],
    ["2024-02-29", "2024-02-29"],
  ])("reads the ISO 8601 date cell %s", (written, read) => {
    const cell = snapshot({ value: { kind: "date", value: written } });
    expect(normalizeCell(cell, values).value).toBe(read);
  });

  it.each([
    "2023-02-29",
    "2026-02-30",
    "2026-13-01",
    "0000-01-01",
    "2026-01-15T24:00:00",
    "2026-01-15T09:30:00+24:00",
    "Jan 15 2026",
    "1/15/2026",
    "2026/01/15",
    "2026-1-5",
    " 2026-01-15",
  ])("keeps %s as text instead of moving it to another day", (written) => {
    const cell = snapshot({ value: { kind: "date", value: written } });
    expect(normalizeCell(cell, values).value).toBe(written);
  });
});

describe("merged cells", () => {
  it("blanks continuation cells under the master policy", () => {
    expect(
      normalizeCell(snapshot({ value: text("merged"), merged: true }), values)
        .value,
    ).toBeNull();
  });

  it("repeats the master value when asked", () => {
    const result = normalizeCell(
      snapshot({ value: text("merged"), merged: true }),
      { ...values, mergePolicy: "repeat" },
    );
    expect(result.value).toBe("merged");
  });
});

describe("formulas", () => {
  const formulaCell = (cached: RawValue) =>
    snapshot({ value: cached, formula: "SUM(A1:A2)" });

  it("returns the cached value", () => {
    expect(
      normalizeCell(formulaCell({ kind: "number", value: 7 }), values),
    ).toEqual({ value: 7 });
  });

  it("keeps a cached zero", () => {
    expect(
      normalizeCell(formulaCell({ kind: "number", value: 0 }), values),
    ).toEqual({ value: 0 });
  });

  it("keeps a cached false", () => {
    expect(
      normalizeCell(formulaCell({ kind: "boolean", value: false }), values),
    ).toEqual({ value: false });
  });

  it("reports an uncached formula", () => {
    expect(normalizeCell(formulaCell({ kind: "none" }), values)).toEqual({
      value: null,
      note: { kind: "formula", formula: "=SUM(A1:A2)", cached: false },
    });
  });

  it("returns the formula text in formulas mode", () => {
    expect(
      normalizeCell(formulaCell({ kind: "number", value: 7 }), {
        ...values,
        valueMode: "formulas",
      }),
    ).toEqual({ value: "=SUM(A1:A2)" });
  });

  it("returns both in both mode", () => {
    expect(
      normalizeCell(formulaCell({ kind: "number", value: 7 }), {
        ...values,
        valueMode: "both",
      }),
    ).toEqual({
      value: 7,
      note: { kind: "formula", formula: "=SUM(A1:A2)", cached: true },
    });
  });
});
