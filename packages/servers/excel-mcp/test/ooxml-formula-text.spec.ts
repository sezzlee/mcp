import { describe, expect, it } from "vitest";
import type { RawCell } from "../src/metadata/spreadsheetml/cells.js";
import {
  displayFormula,
  formulaTexts,
  shiftFormula,
} from "../src/metadata/spreadsheetml/formula-text.js";

describe("displayFormula", () => {
  it.each([
    ["_xlfn.CONCAT(A1,B1)", "CONCAT(A1,B1)"],
    ['HYPERLINK("#",_xlfn.UNICHAR(9660))', 'HYPERLINK("#",UNICHAR(9660))'],
    ['"_xlfn.kept"&_xlfn.DAYS(B1,A1)', '"_xlfn.kept"&DAYS(B1,A1)'],
    ['"a""_xlfn.kept"', '"a""_xlfn.kept"'],
    ["'_xlfn.sheet'!A1", "'_xlfn.sheet'!A1"],
    ['"a_x000D__x000A_b"', '"a\nb"'],
    ["SUM(A1:A3)", "SUM(A1:A3)"],
  ])("shows %s as %s", (stored, shown) => {
    expect(displayFormula(stored)).toBe(shown);
  });
});

describe("shiftFormula", () => {
  it.each([
    ["B1*2", 1, 0, "B2*2"],
    ["$B$1+B1", 2, 1, "$B$1+C3"],
    ["$B1+B$1", 1, 1, "$B2+C$1"],
    ["SUM(A1:A3)", 1, 0, "SUM(A2:A4)"],
    ["Sheet1!A1", 1, 0, "Sheet1!A2"],
    ["'Q1 2024'!B2", 1, 1, "'Q1 2024'!C3"],
    ['"A1"&A1', 1, 0, '"A1"&A2'],
    ["LOG10(A1)", 1, 0, "LOG10(A2)"],
    ["Q1_total+A1", 1, 0, "Q1_total+A2"],
    ["A1", -1, 0, "#REF!"],
    ["XFD1", 0, 1, "#REF!"],
    ["Z9", 0, 1, "AA9"],
  ])(
    "moves %s by %i rows and %i columns to %s",
    (formula, rows, columns, moved) => {
      expect(shiftFormula(formula, rows, columns)).toBe(moved);
    },
  );
});

describe("formulaTexts", () => {
  const cell = (
    row: number,
    column: number,
    formula: RawCell["formula"],
  ): RawCell => ({
    row,
    column,
    value: { kind: "none" },
    style: 0,
    ...(formula === undefined ? {} : { formula }),
  });

  it("expands a shared group from the cell that defines it", () => {
    const texts = formulaTexts([
      cell(1, 3, { kind: "shared", group: 0, text: "A1*B1", ref: "C1:C3" }),
      cell(2, 3, { kind: "shared", group: 0, text: undefined, ref: undefined }),
      cell(3, 4, { kind: "shared", group: 0, text: undefined, ref: undefined }),
      cell(4, 1, { kind: "normal", text: "_xlfn.CONCAT(A1)" }),
      cell(5, 1, undefined),
    ]);

    expect([...texts]).toEqual([
      [0, "A1*B1"],
      [1, "A2*B2"],
      [2, "B3*C3"],
      [3, "CONCAT(A1)"],
    ]);
  });

  it("leaves a group cell met before its defining cell without text", () => {
    const texts = formulaTexts([
      cell(1, 1, { kind: "shared", group: 7, text: undefined, ref: undefined }),
      cell(2, 1, { kind: "shared", group: 7, text: "B2", ref: "A1:A2" }),
    ]);

    expect([...texts]).toEqual([[1, "B2"]]);
  });
});
