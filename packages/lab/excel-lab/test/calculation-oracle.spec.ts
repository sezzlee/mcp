import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { checkCalculationOutput } from "../src/calculation-oracle.ts";

const bytes = (cell: string) =>
  zipSync({
    "xl/worksheets/sheet1.xml": strToU8(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cell}</row></sheetData></worksheet>`,
    ),
  });
const expected = {
  part: "xl/worksheets/sheet1.xml",
  cells: { A1: { formula: "2+3", value: 5 } },
};

describe("independent calculation cache oracle", () => {
  it("accepts a manually specified numeric cache", () => {
    expect(() =>
      checkCalculationOutput(
        bytes('<c r="A1"><f>2+3</f><v>5</v></c>'),
        expected,
      ),
    ).not.toThrow();
  });
  it.each([
    '<c r="A1"><f>2+3</f><v>6</v></c>',
    '<c r="A1"><f>2+3</f></c>',
    '<c r="A1"><f>2+4</f><v>5</v></c>',
    '<c r="A1" t="str"><f>2+3</f><v>5</v></c>',
    '<c r="B1"><f>2+3</f><v>5</v></c>',
    '<c r="A1"><f>2+3</f><v>5</v></c><c r="A1"><f>2+3</f><v>6</v></c>',
  ])("rejects corrupted output independently of the evaluator: %s", (cell) => {
    expect(() => checkCalculationOutput(bytes(cell), expected)).toThrow();
  });
  it("rejects a stale cached value for an explicitly unavailable formula", () => {
    expect(() =>
      checkCalculationOutput(bytes('<c r="A1"><f>SIN(1)</f><v>999</v></c>'), {
        part: expected.part,
        cells: { A1: { formula: "SIN(1)", value: { unavailable: true } } },
      }),
    ).toThrow(/Stale cache/);
  });
});
