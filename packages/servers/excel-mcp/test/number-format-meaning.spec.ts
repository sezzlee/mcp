import { describe, expect, it } from "vitest";
import { ooxmlSnapshot } from "../src/format/ooxml-cell.js";

function facts(numberFormat: string, value: number, date1904 = false) {
  return ooxmlSnapshot({
    value: { kind: "number", value },
    formula: undefined,
    numberFormat,
    date1904,
    href: undefined,
    merged: false,
  }).value;
}

describe("native number format interpretation", () => {
  it.each([
    ["[h]:mm:ss", 1.5, 129600],
    ["[hh]:mm", -0.125, -10800],
    ["[m]:ss", 0.0625, 5400],
    ["[mm]:ss", 60, 5184000],
    ["[ss].00", 0.00000095367431640625, 0.0823974609375],
    ["[H]:MM:SS", 0, 0],
  ] as const)(
    "preserves the elapsed serial in %s",
    (format, value, seconds) => {
      for (const date1904 of [false, true]) {
        expect(facts(format, value, date1904)).toEqual({
          value: { durationSeconds: seconds },
          meaning: { unit: "seconds" },
        });
      }
    },
  );

  it.each([
    [
      "[>=1][h]:mm;0.00%",
      1.5,
      { durationSeconds: 129600 },
      { unit: "seconds" },
    ],
    ["[>=1][h]:mm;0.00%", 0.25, 0.25, { unit: "fraction" }],
    [
      "[Red][<0][h]:mm;[>=1]yyyy-mm-dd;0.00%",
      -1.5,
      { durationSeconds: -129600 },
      { unit: "seconds" },
    ],
    ["[Red][<0][h]:mm;[>=1]yyyy-mm-dd;0.00%", 0.25, 0.25, { unit: "fraction" }],
    ["0.00%;[h]:mm;0.00", -1, { durationSeconds: -86400 }, { unit: "seconds" }],
    ["0.00%;[h]:mm;0.00", 0, 0, undefined],
    ["0.00%;[h]:mm;0.00", 1, 1, { unit: "fraction" }],
    ['"label;[h]"0.00;0.00%', 1, 1, undefined],
    ['"label;[h]"0.00;0.00%', -1, -1, { unit: "fraction" }],
    ["0.00\\%;[h]:mm", 0.25, 0.25, undefined],
    ['0.00"%";[h]:mm', 0.25, 0.25, undefined],
    ["0.00_%;[h]:mm", 0.25, 0.25, undefined],
    ["0.00*%;[h]:mm", 0.25, 0.25, undefined],
    ["[=0]0.00%;[<>0][h]:mm;0", 0, 0, { unit: "fraction" }],
    [
      "[=0]0.00%;[<>0][h]:mm;0",
      2,
      { durationSeconds: 172800 },
      { unit: "seconds" },
    ],
    ["[>1E+2][h]:mm;0.00%", 1, 1, { unit: "fraction" }],
  ] as const)(
    "uses only the selected section of %s for %s",
    (format, value, expected, meaning) => {
      expect(facts(format, value)).toEqual({
        value: expected,
        ...(meaning === undefined ? {} : { meaning }),
      });
    },
  );

  it.each([
    ["[$EUR-407]#,##0.00", "EUR"],
    ["[$USD-409]#,##0.00", "USD"],
    ["[$$-409]#,##0.00", "$"],
    ["[$¥-411]#,##0.00", "¥"],
    ["[$₩-412]#,##0.00", "₩"],
    ['"£"#,##0.00', "GBP"],
    ['" EUR "#,##0.00', "EUR"],
    ["\\€#,##0.00", "EUR"],
    ["₹#,##0.00", "INR"],
    ["₽#,##0.00", "RUB"],
    ["[$-409]#,##0.00", undefined],
    ['"retail EUR"#,##0.00', undefined],
    ['"USD"0.00"EUR"', undefined],
  ] as const)("keeps the currency actually named by %s", (format, currency) => {
    expect(facts(format, 12.375)).toEqual({
      value: 12.375,
      ...(currency === undefined ? {} : { meaning: { currency } }),
    });
  });

  it.each([
    '"[h]"0.00',
    "\\[\\h\\]0.00",
    '0.00;0.00;0.00;"[h]"@',
    "[hm]0.00",
    "[]0.00",
    "[>1e999][h]:mm;0.00",
    "[h]:mm;0;0;@;0",
    '"unterminated [h]',
    `[h]${" ".repeat(252)}`,
  ])("does not invent a duration from unsupported syntax %s", (format) => {
    expect(facts(format, 1.5)).toEqual({ value: 1.5 });
  });

  it("keeps calendar and clock interpretation confined to the active section", () => {
    expect(facts("[>=1]yyyy-mm-dd;0.00%", 2)).toEqual({ value: "1900-01-02" });
    expect(facts("0.00;h:mm:ss", 0.5)).toEqual({ value: 0.5 });
    expect(facts("h:mm:ss;0.00", 0.5)).toEqual({ value: "12:00:00" });
  });

  it("preserves the cached formula result's duration facts", () => {
    const snapshot = ooxmlSnapshot({
      value: { kind: "number", value: 1.5 },
      formula: "SUM(A1:A2)",
      numberFormat: "[h]:mm:ss",
      date1904: false,
      href: undefined,
      merged: false,
    });
    expect(snapshot.cached).toEqual({
      value: { durationSeconds: 129600 },
      meaning: { unit: "seconds" },
    });
    expect(snapshot.value).toEqual({ value: null });
  });

  it("fails explicitly if elapsed seconds exceed the finite range", () => {
    expect(() => facts("[h]:mm", Number.MAX_VALUE)).toThrowError(
      "Elapsed duration exceeds the finite number range.",
    );
  });
});
