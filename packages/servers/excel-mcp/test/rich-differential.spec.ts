import * as XLSX from "@e965/xlsx";
import { describe, expect, it } from "vitest";
import { ooxmlSheetView, parseOoxml } from "../src/format/ooxml-workbook.js";
import { resolveCell, type CellSnapshot } from "../src/grid/cell-value.js";
import type { SheetView } from "../src/grid/sheet.js";
import {
  linkedWorkbook,
  richErrorsWorkbook,
  richWorkbook,
} from "./fixtures/rich-workbook.js";
import { parseSheetJs, sheetjsSheetView } from "./fixtures/sheetjs/workbook.js";

function views(bytes: Buffer, sheet: string) {
  return {
    current: ooxmlSheetView(parseOoxml(bytes, "rich.xlsx"), sheet),
    historical: sheetjsSheetView(parseSheetJs(bytes, "rich.xlsx"), sheet),
  };
}

function cell(sheet: SheetView, row: number, column: number): CellSnapshot {
  const snapshot = sheet.rowAt(row)?.cellAt(column);
  if (snapshot === undefined) throw new Error(`Missing cell ${row},${column}`);
  return snapshot;
}

const richBytes = richWorkbook();
const rich = views(richBytes, "Rich");
const linked = views(linkedWorkbook(), "Linked");
const errors = views(richErrorsWorkbook(), "Rich");
const values = { valueMode: "values", mergePolicy: "master" } as const;

/** Fixed XML answers and provenance are recorded in rich-values.PROVENANCE.md. */
describe("exact modern-value differences from the historical SheetJS adapter", () => {
  it("resolves both in-cell images where the historical adapter exposes compatibility errors", () => {
    const images = [
      { imageId: 0, altText: "店舗 — München — متجر <A&B>", decorative: false },
      { imageId: 1, decorative: true },
    ];
    for (const [index, image] of images.entries()) {
      expect(cell(rich.current, index + 2, 1)).toEqual({
        merged: false,
        numberFormat: "General",
        value: { value: image },
      });
      expect(cell(rich.historical, index + 2, 1)).toEqual({
        merged: false,
        numberFormat: "General",
        value: { value: { error: "#VALUE!" } },
      });
    }
  });

  it("reads the SDK fixture's exact cached entity label and identifiers", () => {
    expect(cell(linked.current, 1, 1)).toEqual({
      merged: false,
      numberFormat: "General",
      value: {
        value: {
          linkedValue: {
            type: "_linkedentity2",
            displayText: "Seattle",
            entityId: "5fbba6b8-85e1-4d41-9444-d9055436e473",
            entityCulture: "en-US",
            serviceId: 536870912,
          },
        },
      },
    });
    expect(cell(linked.historical, 1, 1)).toEqual({
      merged: false,
      numberFormat: "General",
      value: { value: { error: "#VALUE!" } },
    });
  });

  it("preserves array metadata discarded by the historical adapter, while keeping all saved results", () => {
    const raw = XLSX.read(richBytes, { type: "buffer", cellFormula: true });
    expect(raw.Sheets["Rich"]?.["C2"]).toMatchObject({
      f: "SEQUENCE(3,1,10,10)",
      F: "C2:C4",
      D: true,
    });
    const array = {
      anchor: "C2",
      ref: "C2:C4",
      dynamic: true,
      collapsed: false,
    };
    for (const [row, cached] of [
      [2, 10],
      [3, 20],
      [4, 30],
    ] as const) {
      const stored = {
        merged: false,
        numberFormat: "General",
        ...(row === 2
          ? {
              value: { value: null },
              formula: "SEQUENCE(3,1,10,10)",
              cached: { value: cached },
            }
          : { value: { value: cached } }),
      };
      expect(cell(rich.historical, row, 3)).toEqual(stored);
      expect(cell(rich.current, row, 3)).toEqual({ ...stored, array });
    }
  });

  it("uses independently saved day values for elapsed seconds instead of the reference's calendar dates", () => {
    const raw = XLSX.read(richBytes, {
      type: "buffer",
      cellDates: false,
      cellNF: true,
    });
    const cases = [
      {
        row: 2,
        serial: 1.5,
        seconds: 129600,
        date: "1900-01-01T12:00:00.000Z",
      },
      {
        row: 3,
        serial: 0.0625,
        seconds: 5400,
        date: "1899-12-31T01:30:00.000Z",
      },
      {
        row: 4,
        serial: 0.00001157407407407407,
        seconds: 1,
        date: "1899-12-31T00:00:01.000Z",
      },
    ];
    for (const { row, serial, seconds, date } of cases) {
      expect(raw.Sheets["Rich"]?.[`D${row}`]).toMatchObject({
        t: "n",
        v: serial,
        z: "[h]:mm:ss",
      });
      const current = cell(rich.current, row, 4);
      expect(current.value.meaning).toEqual({ unit: "seconds" });
      const duration = current.value.value;
      if (
        duration === null ||
        typeof duration !== "object" ||
        !("durationSeconds" in duration)
      ) {
        throw new Error(`D${row} did not retain elapsed duration`);
      }
      expect(duration.durationSeconds).toBeCloseTo(seconds, 12);
      expect(cell(rich.historical, row, 4)).toEqual({
        merged: false,
        numberFormat: "[h]:mm:ss",
        value: { value: date },
      });
    }
  });

  it("distinguishes rich error metadata from direct native error caches", () => {
    for (const [row, error] of [
      [5, "#SPILL!"],
      [6, "#CALC!"],
    ] as const) {
      const expected = {
        merged: false,
        numberFormat: "General",
        value: { value: { error } },
      };
      expect(cell(errors.current, row, 5)).toEqual(expected);
      expect(cell(errors.historical, row, 5)).toEqual({
        ...expected,
        value: { value: { error: "#VALUE!" } },
      });
      expect(cell(errors.current, row, 6)).toEqual(expected);
      expect(cell(errors.historical, row, 6)).toEqual(expected);
    }
  });

  it("keeps ordinary errors, booleans, identifier strings and numeric caches as exact controls", () => {
    const controls = [
      { row: 2, column: 5, value: { error: "#DIV/0!" } },
      { row: 3, column: 5, value: { error: "#N/A" } },
      { row: 4, column: 5, value: { error: "#NUM!" } },
      { row: 2, column: 6, value: true },
      { row: 3, column: 6, value: false },
      { row: 3, column: 7, value: 250 },
      { row: 2, column: 8, value: "00123" },
      { row: 3, column: 8, value: "1234567890123456789" },
    ];
    for (const { row, column, value } of controls) {
      const current = cell(rich.current, row, column);
      const historical = cell(rich.historical, row, column);
      expect(current).toEqual(historical);
      expect(resolveCell(current, values)).toEqual(value);
    }
    expect(cell(rich.current, 2, 7)).toEqual({
      merged: false,
      numberFormat: "0%",
      value: { value: 0.25, meaning: { unit: "fraction" } },
    });
    expect(cell(rich.historical, 2, 7)).toEqual({
      merged: false,
      numberFormat: "0%",
      value: { value: 0.25 },
    });
  });
});
