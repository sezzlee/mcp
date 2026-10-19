import { describe, expect, it } from "vitest";
import {
  compareWorkbook,
  nativeCellDifference,
} from "./fixtures/cell-parity.js";
import type { CellSnapshot } from "../src/grid/cell-value.js";
import { rawWorkbook } from "./fixtures/raw-workbook.js";

describe("intentional native cell parity differences", () => {
  it("retains raw elapsed serials in a separate reference pass under both date systems", async () => {
    for (const date1904 of [false, true]) {
      const bytes = await rawWorkbook({
        styles:
          '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="46"/><xf numFmtId="9"/></cellXfs>',
        sheetData: [
          '<row r="1"><c r="A1" s="1"><v>1.5</v></c><c r="B1" s="2"><v>0.25</v></c></row>',
          '<row r="2"><c r="A2" s="1"><f>SUM(A1)</f><v>1.5</v></c></row>',
          '<row r="3"><c r="A3" s="1"><v>-0.125</v></c></row>',
          '<row r="4"><c r="A4" s="1"><v>60</v></c></row>',
          '<row r="5"><c r="A5" s="1"><v>0.00000095367431640625</v></c></row>',
        ].join(""),
        parts: {
          "[Content_Types].xml": [
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
            '<Default Extension="xml" ContentType="application/xml"/>',
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
            '<Override PartName="/xl/looks.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
            "</Types>",
          ].join(""),
          ...(date1904
            ? {
                "xl/workbook.xml":
                  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
              }
            : {}),
        },
      });
      expect(compareWorkbook(Buffer.from(bytes))).toMatchObject({
        kind: "compared",
        mismatches: [],
        nativeMeaningCells: 1,
        nativeElapsedCells: 5,
      });
    }
  });

  const amount: CellSnapshot = {
    merged: false,
    value: { value: 12.5, meaning: { currency: "EUR" } },
    numberFormat: '"EUR"0.00',
  };
  const oldAmount: CellSnapshot = {
    ...amount,
    value: { value: 12.5 },
  };

  it("counts additional numeric meaning while retaining scalar, hyperlink and formula checks", () => {
    expect(nativeCellDifference(amount, oldAmount)).toBe("meaning");
    expect(
      nativeCellDifference(amount, { ...oldAmount, value: { value: 13 } }),
    ).toBeUndefined();
    expect(
      nativeCellDifference(amount, {
        ...oldAmount,
        value: { value: 12.5, href: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      nativeCellDifference(amount, { ...oldAmount, formula: "1+1" }),
    ).toBeUndefined();
    expect(
      nativeCellDifference(amount, { ...oldAmount, merged: true }),
    ).toBeUndefined();
  });

  const elapsed: CellSnapshot = {
    merged: false,
    value: { value: { durationSeconds: 129600 }, meaning: { unit: "seconds" } },
    numberFormat: "[h]:mm:ss",
  };
  const oldElapsed: CellSnapshot = {
    ...elapsed,
    value: { value: "1900-01-01T12:00:00.000Z" },
  };

  it("requires independently retained raw serial and format for elapsed differences", () => {
    expect(
      nativeCellDifference(elapsed, oldElapsed, {
        serial: 1.5,
        numberFormat: "[h]:mm:ss",
      }),
    ).toBe("elapsed");
    expect(nativeCellDifference(elapsed, oldElapsed)).toBeUndefined();
    expect(
      nativeCellDifference(elapsed, oldElapsed, {
        serial: 0.5,
        numberFormat: "[h]:mm:ss",
      }),
    ).toBeUndefined();
    expect(
      nativeCellDifference(elapsed, oldElapsed, {
        serial: 1.5,
        numberFormat: "h:mm:ss",
      }),
    ).toBeUndefined();
    expect(
      nativeCellDifference(
        {
          ...elapsed,
          value: {
            value: { durationSeconds: 43200 },
            meaning: { unit: "seconds" },
          },
        },
        oldElapsed,
        { serial: 1.5, numberFormat: "[h]:mm:ss" },
      ),
    ).toBeUndefined();
  });

  it("keeps exact formula and cached-result checks for native elapsed cells", () => {
    const mine: CellSnapshot = {
      ...elapsed,
      value: { value: null },
      cached: elapsed.value,
      formula: "SUM(A1:A2)",
    };
    const theirs: CellSnapshot = {
      ...oldElapsed,
      value: { value: null },
      cached: oldElapsed.value,
      formula: "SUM(A1:A2)",
    };
    expect(
      nativeCellDifference(mine, theirs, {
        serial: 1.5,
        numberFormat: "[h]:mm:ss",
      }),
    ).toBe("elapsed");
    expect(
      nativeCellDifference(
        mine,
        { ...theirs, formula: "SUM(A1:A3)" },
        { serial: 1.5, numberFormat: "[h]:mm:ss" },
      ),
    ).toBeUndefined();
  });
});
