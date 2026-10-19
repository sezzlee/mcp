import { describe, expect, it } from "vitest";
import {
  readNumberText,
  sniffNumberMarks,
  type NumberMarks,
} from "../src/grid/number-text.js";
import type { SezzleeExcelError } from "../src/platform/errors.js";

const turkish: NumberMarks = { decimal: ",", group: "." };
const american: NumberMarks = { decimal: ".", group: "," };
const spaced: NumberMarks = { decimal: ",", group: " " };
const swiss: NumberMarks = { decimal: ".", group: "'" };

describe("readNumberText", () => {
  it.each([
    ["1.234,50", turkish, 1234.5],
    ["-1.234,50", turkish, -1234.5],
    ["(1.234,50)", turkish, -1234.5],
    ["1.234.567", turkish, 1234567],
    ["1.234", turkish, 1234],
    ["0,5", turkish, 0.5],
    ["0", turkish, 0],
    ["1,234.50", american, 1234.5],
    ["1.234", american, 1.234],
    [".5", american, 0.5],
    ["1e3", american, 1000],
    ["1 234,50", spaced, 1234.5],
    ["1 234,50", spaced, 1234.5],
    ["1 234,50", spaced, 1234.5],
    ["1'234.50", swiss, 1234.5],
    ["1’234.50", swiss, 1234.5],
    ["−5", american, -5],
  ] as const)("reads %j as %d", (text, marks, expected) => {
    expect(readNumberText(text, marks)).toEqual({
      kind: "number",
      value: expected,
      unit: { kind: "plain" },
    });
  });

  it.each([
    ["%20", turkish, 0.2],
    ["20%", turkish, 0.2],
    ["% 12,5", turkish, 0.125],
    ["-%20", turkish, -0.2],
  ] as const)(
    "reads the percentage %j as the ratio %d",
    (text, marks, ratio) => {
      expect(readNumberText(text, marks)).toEqual({
        kind: "number",
        value: ratio,
        unit: { kind: "percent" },
      });
    },
  );

  it.each([
    ["₺1.234,50", turkish, 1234.5, "TRY"],
    ["1.234,50 TL", turkish, 1234.5, "TRY"],
    ["1.234,50TL", turkish, 1234.5, "TRY"],
    ["TRY 95", turkish, 95, "TRY"],
    ["-₺5", turkish, -5, "TRY"],
    ["₺-5", turkish, -5, "TRY"],
    ["$1,234.50", american, 1234.5, "$"],
    ["USD 10", american, 10, "USD"],
    ["EUR 95", american, 95, "EUR"],
    ["95 €", turkish, 95, "EUR"],
    ["£3", american, 3, "GBP"],
  ] as const)("reads %j in its currency", (text, marks, value, code) => {
    expect(readNumberText(text, marks)).toEqual({
      kind: "number",
      value,
      unit: { kind: "currency", code },
    });
  });

  it.each([
    ["00123", turkish],
    ["0532", american],
    ["4111111111111111", american],
    ["10000000000000000000", turkish],
  ] as const)("keeps the identifier %j out of the numbers", (text, marks) => {
    expect(readNumberText(text, marks)).toEqual({ kind: "identifier" });
  });

  it.each([
    ["1,234.50", turkish],
    ["1.234,50", american],
    ["1.23", turkish],
    ["12.3.4", american],
    ["0.123", turkish],
    ["007,50", turkish],
    ["abc", turkish],
    ["", turkish],
    ["-", turkish],
    ["%", turkish],
    ["-(5)", turkish],
    ["--5", turkish],
    ["%20 TL", turkish],
    ["5 TLX", turkish],
    ["ABC123", american],
    ["1 234,50", turkish],
  ] as const)("leaves %j as text", (text, marks) => {
    expect(readNumberText(text, marks)).toEqual({ kind: "text" });
  });

  it.each([
    ["012", american, 12],
    ["00123", turkish, 123],
    ["007,50", turkish, 7.5],
  ] as const)(
    "reads the identifier-like %j as a number when the caller says so",
    (text, marks, value) => {
      expect(readNumberText(text, marks, "read")).toEqual({
        kind: "number",
        value,
        unit: { kind: "plain" },
      });
    },
  );

  it("refuses numeric text beyond the finite range", () => {
    let code = "no-error";
    try {
      readNumberText("1e999", american);
    } catch (error) {
      code = (error as SezzleeExcelError).code;
    }
    expect(code).toBe("numeric_overflow");
  });
});

describe("sniffNumberMarks", () => {
  it("decides Turkish marks from a decimal comma and a grouped thousand", () => {
    expect(sniffNumberMarks(["1.234,50", "12,5", "7"])).toEqual({
      kind: "decided",
      marks: { decimal: ",", group: "." },
    });
  });

  it("decides American marks from a grouped thousand with a decimal point", () => {
    expect(sniffNumberMarks(["1,234.50", "99.5"])).toEqual({
      kind: "decided",
      marks: { decimal: ".", group: "," },
    });
  });

  it("decides a decimal point when no value carries a group mark", () => {
    expect(sniffNumberMarks(["1234.50", "99.5"])).toEqual({
      kind: "decided",
      marks: { decimal: ".", group: "none" },
    });
  });

  it("decides a decimal comma for the ungrouped comma column of comma_decimal_null.csv", () => {
    expect(sniffNumberMarks(["80000000,00", "1527319,20"])).toEqual({
      kind: "decided",
      marks: { decimal: ",", group: "none" },
    });
  });

  it("resolves a lone 1.234 by a sibling value that only a decimal point reads", () => {
    expect(sniffNumberMarks(["1.234", "12.5"])).toEqual({
      kind: "decided",
      marks: { decimal: ".", group: "none" },
    });
  });

  it("refuses to choose when every value reads both as thousands and as decimals", () => {
    const decision = sniffNumberMarks(["1.234", "5.678", "9"]);
    expect(decision.kind).toBe("ambiguous");
    expect(decision).toMatchObject({ example: "1.234" });
    expect(decision).toMatchObject({
      candidates: expect.arrayContaining([
        { decimal: ".", group: "none" },
        { decimal: ",", group: "." },
      ]),
    });
  });

  it("lets the marks most values agree on win over a stray value", () => {
    expect(
      sniffNumberMarks(["1.234,50", "2.000,00", "3.100,25", "1,234.50"]),
    ).toEqual({ kind: "decided", marks: { decimal: ",", group: "." } });
  });

  it("decides from the digits behind a currency or percent sign", () => {
    expect(sniffNumberMarks(["₺1.234,50", "%12,5", "(2.000,00)"])).toEqual({
      kind: "decided",
      marks: { decimal: ",", group: "." },
    });
  });

  it("finds no number in text, blanks or identifiers", () => {
    expect(sniffNumberMarks(["abc", "", "N/A", "00123", "0532"])).toEqual({
      kind: "none",
    });
  });
});
