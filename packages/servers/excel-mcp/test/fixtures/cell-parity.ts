import { isDeepStrictEqual } from "node:util";
import * as XLSX from "@e965/xlsx";
import {
  isCellDuration,
  type CellFacts,
  type CellSnapshot,
} from "../../src/grid/cell-value.js";
import { formatCellRef, maxColumn, maxRow } from "../../src/grid/range.js";
import type { SheetView } from "../../src/grid/sheet.js";
import {
  describeOoxml,
  ooxmlSheetView,
  parseOoxml,
} from "../../src/format/ooxml-workbook.js";
import {
  describeSheetJs,
  parseSheetJs,
  sheetjsSheetView,
  type SheetJsWorkbook,
} from "./sheetjs/workbook.js";

export type CellMismatch =
  | {
      readonly kind: "sheets";
      readonly ours: readonly string[];
      readonly theirs: readonly string[];
    }
  | {
      readonly kind: "describe" | "facts" | "view";
      readonly sheet: string;
      readonly field: string;
      readonly ours: unknown;
      readonly theirs: unknown;
    }
  | {
      readonly kind: "cell";
      readonly sheet: string;
      readonly at: string;
      readonly ours: CellSnapshot | null;
      readonly theirs: CellSnapshot | null;
    };

export type CellComparison =
  | { readonly kind: "reference_refused"; readonly message: string }
  | {
      readonly kind: "compared";
      readonly mismatches: readonly CellMismatch[];
      readonly implicitFormatCells: number;
      readonly chartSheetRanges: number;
      readonly nativeMeaningCells: number;
      readonly nativeElapsedCells: number;
    };

const meta = {
  filePath: "parity.xlsx",
  sizeBytes: 1,
  modifiedAt: "2026-01-01T00:00:00.000Z",
};

/**
 * Guard: SheetJS loads a built-in format id outside its base table (5–8,
 * 23–36, 41–44, 50–81) only after formatting the first cell that names it, so
 * that one cell alone comes back without a number format. It is a SheetJS
 * defect this reader does not copy; the comparison counts it rather than
 * failing on it.
 */
function onlyMissingFormat(
  ours: CellSnapshot | null,
  theirs: CellSnapshot | null,
): boolean {
  if (ours === null || theirs === null) return false;
  if (theirs.numberFormat !== undefined || ours.numberFormat === undefined) {
    return false;
  }
  const { numberFormat: _format, ...rest } = ours;
  return isDeepStrictEqual(rest, theirs);
}

interface RawNumericCell {
  readonly serial: number;
  readonly numberFormat: string;
}

const simpleElapsed =
  /^\[(?:h{1,2}|m{1,2}|s{1,2})\](?::m{1,2})?(?::s{1,2})?(?:\.0{1,3})?$/i;

function withoutMeaning(facts: CellFacts): CellFacts {
  const { meaning: _meaning, ...rest } = facts;
  return rest;
}

function hasMeaning(snapshot: CellSnapshot): boolean {
  return (
    snapshot.value.meaning !== undefined ||
    snapshot.cached?.meaning !== undefined
  );
}

/**
 * Counts only the additional meaning field when every other snapshot fact is
 * identical; native-format-meaning and number-format-meaning tests independently
 * verify its unit and currency semantics. Elapsed differences require the raw
 * numeric serial and one simple elapsed format; dates are never inverted.
 */
export function nativeCellDifference(
  ours: CellSnapshot | null,
  theirs: CellSnapshot | null,
  raw?: RawNumericCell,
): "meaning" | "elapsed" | undefined {
  if (ours === null || theirs === null || !hasMeaning(ours)) return undefined;
  const stripped: CellSnapshot = {
    ...ours,
    value: withoutMeaning(ours.value),
    ...(ours.cached === undefined
      ? {}
      : { cached: withoutMeaning(ours.cached) }),
  };
  if (isDeepStrictEqual(stripped, theirs)) return "meaning";
  if (
    raw === undefined ||
    ours.numberFormat !== raw.numberFormat ||
    !simpleElapsed.test(raw.numberFormat) ||
    !Number.isFinite(raw.serial)
  )
    return undefined;
  const seconds = Number((raw.serial * 86400).toPrecision(15));
  if (!Number.isFinite(seconds)) return undefined;
  let converted = false;
  const translate = (
    mine: CellFacts,
    counterpart: CellFacts | undefined,
  ): CellFacts => {
    if (!isCellDuration(mine.value) || counterpart === undefined) return mine;
    if (
      mine.value.durationSeconds !== seconds ||
      (typeof counterpart.value !== "number" &&
        typeof counterpart.value !== "string")
    )
      return mine;
    converted = true;
    return { ...mine, value: counterpart.value };
  };
  const normalized: CellSnapshot = {
    ...stripped,
    value: translate(stripped.value, theirs.value),
    ...(stripped.cached === undefined
      ? {}
      : { cached: translate(stripped.cached, theirs.cached) }),
  };
  return converted && isDeepStrictEqual(normalized, theirs)
    ? "elapsed"
    : undefined;
}

function rowsOf(view: SheetView, withCovered: boolean): readonly number[] {
  return [...view.populatedRows({ from: 1, to: maxRow, withCovered })];
}

/**
 * Compares the two format adapters on the same bytes: each sheet's
 * `describe_workbook` summary; its facts (validations, tables, conditional
 * formats, images, panes), which the reader takes from one shared pass and the
 * reference from each part reader's own pass; and its view as the grid layer
 * reads it — the rows and columns it reports as populated, with and without
 * merge continuations, and the snapshot of every one of those cells.
 *
 * @returns `reference_refused` when SheetJS cannot read the bytes, otherwise
 *   at most `limit` mismatches. A failure of the OOXML reader is thrown, never
 *   folded into the result.
 */
export function compareWorkbook(bytes: Buffer, limit = 20): CellComparison {
  let reference: SheetJsWorkbook;
  try {
    reference = parseSheetJs(bytes, meta.filePath);
  } catch (error) {
    return {
      kind: "reference_refused",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const workbook = parseOoxml(bytes, meta.filePath);
  const mismatches: CellMismatch[] = [];
  const report = (mismatch: CellMismatch): void => {
    if (mismatches.length < limit) mismatches.push(mismatch);
  };
  let implicitFormatCells = 0;
  let chartSheetRanges = 0;
  let nativeMeaningCells = 0;
  let nativeElapsedCells = 0;
  let numericReference: XLSX.WorkBook | undefined;
  const rawNumericCell = (
    name: string,
    address: string,
  ): RawNumericCell | undefined => {
    numericReference ??= XLSX.read(bytes, {
      type: "buffer",
      cellDates: false,
      cellNF: true,
      cellFormula: true,
      sheetStubs: true,
    });
    const cell: unknown = numericReference.Sheets[name]?.[address];
    if (
      typeof cell !== "object" ||
      cell === null ||
      !("t" in cell) ||
      cell.t !== "n" ||
      !("v" in cell) ||
      typeof cell.v !== "number" ||
      !("z" in cell) ||
      typeof cell.z !== "string"
    )
      return undefined;
    return { serial: cell.v, numberFormat: cell.z };
  };
  if (!isDeepStrictEqual(workbook.sheetNames, reference.sheetNames)) {
    return {
      kind: "compared",
      mismatches: [
        {
          kind: "sheets",
          ours: workbook.sheetNames,
          theirs: reference.sheetNames,
        },
      ],
      implicitFormatCells,
      chartSheetRanges,
      nativeMeaningCells,
      nativeElapsedCells,
    };
  }
  const options = { includeDefinedNames: true };
  const { sheets: ourSheets, ...ourBook } = describeOoxml(
    workbook,
    meta,
    options,
  );
  const { sheets: theirSheets, ...theirBook } = describeSheetJs(
    reference,
    meta,
    options,
  );
  if (!isDeepStrictEqual(ourBook, theirBook)) {
    report({
      kind: "describe",
      sheet: "",
      field: "workbook",
      ours: ourBook,
      theirs: theirBook,
    });
  }
  ourSheets.forEach((summary, index) => {
    const other = theirSheets[index];
    for (const [field, mine] of Object.entries(summary)) {
      const counterpart: unknown =
        other === undefined
          ? undefined
          : Object.entries(other).find(([key]) => key === field)?.[1];
      if (isDeepStrictEqual(mine, counterpart)) continue;
      /**
       * Guard: SheetJS gives a chart sheet a pseudo range drawn from the
       * chart's series (seven series read as `A1:G1`). A chart sheet has no
       * cell grid, so this reader declares none, and the difference is counted.
       */
      if (
        (field === "declaredRowCount" || field === "declaredColumnCount") &&
        mine === 0 &&
        workbook.opc.chartSheets.has(summary.name)
      ) {
        chartSheetRanges += 1;
        continue;
      }
      report({
        kind: "describe",
        sheet: summary.name,
        field,
        ours: mine,
        theirs: counterpart,
      });
    }
  });
  for (const name of workbook.sheetNames) {
    const facts = workbook.facts(name);
    for (const field of [
      "validations",
      "tables",
      "conditionalFormats",
      "images",
      "panes",
    ] as const) {
      const ours = facts[field];
      const theirs = reference[field].get(name);
      if (!isDeepStrictEqual(ours, theirs)) {
        report({ kind: "facts", sheet: name, field, ours, theirs });
      }
    }
  }
  for (const name of workbook.sheetNames) {
    const view = ooxmlSheetView(workbook, name);
    const other = sheetjsSheetView(reference, name);
    for (const field of ["bounds", "merges", "autoFilter"] as const) {
      if (!isDeepStrictEqual(view[field], other[field])) {
        report({
          kind: "view",
          sheet: name,
          field,
          ours: view[field],
          theirs: other[field],
        });
      }
    }
    for (const withCovered of [false, true]) {
      const rows = rowsOf(view, withCovered);
      const otherRows = rowsOf(other, withCovered);
      if (!isDeepStrictEqual(rows, otherRows)) {
        report({
          kind: "view",
          sheet: name,
          field: `rows withCovered=${withCovered}`,
          ours: rows.slice(0, 12),
          theirs: otherRows.slice(0, 12),
        });
        continue;
      }
      const span = { from: 1, to: maxColumn, withCovered };
      for (const row of rows) {
        const line = view.rowAt(row);
        const otherLine = other.rowAt(row);
        const columns = [...(line?.populatedColumns(span) ?? [])];
        const otherColumns = [...(otherLine?.populatedColumns(span) ?? [])];
        if (!isDeepStrictEqual(columns, otherColumns)) {
          report({
            kind: "view",
            sheet: name,
            field: `columns of row ${row} withCovered=${withCovered}`,
            ours: columns.slice(0, 12),
            theirs: otherColumns.slice(0, 12),
          });
          continue;
        }
        if (withCovered) continue;
        for (const column of columns) {
          const mine = line?.cellAt(column) ?? null;
          const counterpart = otherLine?.cellAt(column) ?? null;
          if (isDeepStrictEqual(mine, counterpart)) continue;
          if (onlyMissingFormat(mine, counterpart)) {
            implicitFormatCells += 1;
            continue;
          }
          const address = formatCellRef(row, column);
          const difference = nativeCellDifference(mine, counterpart);
          if (difference === "meaning") {
            nativeMeaningCells += 1;
            continue;
          }
          if (
            mine !== null &&
            (isCellDuration(mine.value.value) ||
              (mine.cached !== undefined &&
                isCellDuration(mine.cached.value))) &&
            nativeCellDifference(
              mine,
              counterpart,
              rawNumericCell(name, address),
            ) === "elapsed"
          ) {
            nativeElapsedCells += 1;
            continue;
          }
          report({
            kind: "cell",
            sheet: name,
            at: formatCellRef(row, column),
            ours: mine,
            theirs: counterpart,
          });
        }
      }
    }
  }
  return {
    kind: "compared",
    mismatches,
    implicitFormatCells,
    chartSheetRanges,
    nativeMeaningCells,
    nativeElapsedCells,
  };
}
