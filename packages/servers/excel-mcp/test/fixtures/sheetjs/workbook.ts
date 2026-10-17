import { canonical } from "@sezzlee/file-core";
import * as XLSX from "@e965/xlsx";
import { conditionalFormatRuleCountOf } from "../../../src/metadata/conditional-formats.js";
import type { MediaEntry } from "../../../src/metadata/images.js";
import { SezzleeExcelError } from "../../../src/platform/errors.js";
import { openPackage } from "../../../src/metadata/spreadsheetml/package.js";
import { zipSource } from "../../../src/metadata/spreadsheetml/reader.js";
import {
  conditionalFormatScan,
  type OoxmlConditionalBlock,
} from "../../../src/metadata/spreadsheetml/conditional-formats.js";
import {
  imageScan,
  paneScan,
  type OoxmlImage,
  type OoxmlPanes,
} from "../../../src/metadata/spreadsheetml/images.js";
import {
  tableScan,
  type OoxmlTable,
} from "../../../src/metadata/spreadsheetml/tables.js";
import {
  validationScan,
  type OoxmlValidations,
} from "../../../src/metadata/spreadsheetml/validations.js";
import { limits } from "../../../src/platform/limits.js";
import { metadataLimitations } from "../../../src/metadata/support.js";
import {
  formatCellRef,
  formatRange,
  parseCellRef,
  type GridBounds,
} from "../../../src/grid/range.js";
import { scanAlone } from "../scan-alone.js";
import { sheetjsSnapshot, type SheetJsCell } from "./cell.js";
import {
  presentIndices,
  type DeclaredTable,
  type Populated,
  type RowView,
  type SheetView,
} from "../../../src/grid/sheet.js";
import type {
  DocumentMeta,
  SheetSummary,
  WorkbookDescription,
} from "../../../src/metadata/description.js";

export interface SheetJsWorkbook {
  readonly book: XLSX.WorkBook;
  readonly sheetNames: readonly string[];
  readonly validations: ReadonlyMap<string, OoxmlValidations>;
  readonly tables: ReadonlyMap<string, readonly OoxmlTable[]>;
  readonly conditionalFormats: ReadonlyMap<
    string,
    readonly OoxmlConditionalBlock[]
  >;
  readonly images: ReadonlyMap<string, readonly OoxmlImage[]>;
  readonly panes: ReadonlyMap<string, OoxmlPanes>;
  readonly media: ReadonlyMap<string, MediaEntry>;
}

interface MergeRange extends GridBounds {
  readonly ref: string;
}

/**
 * `cellStyles` is off: it resolves the theme and style tables for every cell
 * and no tool reads a style. `sheetStubs` is on because without it a formula
 * cell that carries no cached result is dropped from the grid entirely; the
 * price is that blank cells arrive as `t: "z"` stubs, which every value test
 * below has to exclude. `dense` keeps each sheet as row arrays rather than one
 * property per cell. `bookFiles` is off: the OOXML readers reach their parts
 * through ooxml-core's own archive reader, so retaining SheetJS's decompressed
 * table would hold the package a second time for nothing. Measured on a 24 MiB
 * workbook of incompressible media: `arrayBuffers` 48.4 MiB with it on, 24.1 MiB
 * off, wall time about 215 ms either way — SheetJS inflates every entry
 * regardless and the flag only decides whether the table is kept.
 */
const readOptions = {
  type: "buffer",
  cellDates: true,
  cellFormula: true,
  cellNF: true,
  sheetStubs: true,
  dense: true,
} as const;

export function parseSheetJs(bytes: Buffer, path: string): SheetJsWorkbook {
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(bytes, readOptions);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    /**
     * SheetJS reports a well-formed zip holding no recognised workbook part
     * with this exact message. It is the only signal separating "a .docx named
     * .xlsx" from bytes that are genuinely damaged, and the two need different
     * recovery advice.
     */
    if (detail === "Unsupported ZIP file") {
      throw new SezzleeExcelError(
        "not_a_workbook",
        `'${path}' is a zip archive but carries no workbook part.`,
        "The file is probably not a spreadsheet; check what it really is before reading it.",
      );
    }
    throw new SezzleeExcelError(
      "corrupt_workbook",
      `'${path}' could not be parsed as .xlsx: ${detail}`,
      "Open the file in Excel and re-save it as .xlsx.",
    );
  }
  if (book.SheetNames.length === 0) {
    throw new SezzleeExcelError(
      "not_a_workbook",
      `'${path}' is a zip archive but carries no worksheet.`,
      "The file is probably not a spreadsheet; check what it really is before reading it.",
    );
  }
  /**
   * Guard: XLSX.read runs first and keeps the error precedence. A workbook it
   * refuses must never reach the archive reader, or "a .docx named .xlsx" would
   * come back as a container failure instead of not_a_workbook, with the wrong
   * recovery advice.
   */
  const opc = openPackage(zipSource(bytes));
  const date1904 = book.Workbook?.WBProps?.date1904 === true;
  const validations = new Map<string, OoxmlValidations>();
  const tables = new Map<string, readonly OoxmlTable[]>();
  const conditionalFormats = new Map<
    string,
    readonly OoxmlConditionalBlock[]
  >();
  const images = new Map<string, readonly OoxmlImage[]>();
  const panes = new Map<string, OoxmlPanes>();
  const media = new Map<string, MediaEntry>();
  opc.mediaParts.forEach((part, index) => {
    const sizeBytes = opc.partSize(part);
    media.set(part, {
      id: index,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    });
  });
  for (const name of book.SheetNames) {
    const sheetPart = opc.sheetParts.get(name);
    if (sheetPart === undefined) continue;
    validations.set(name, scanAlone(opc, sheetPart, validationScan(date1904)));
    tables.set(name, scanAlone(opc, sheetPart, tableScan(opc, sheetPart)));
    conditionalFormats.set(
      name,
      scanAlone(opc, sheetPart, conditionalFormatScan()),
    );
    images.set(name, scanAlone(opc, sheetPart, imageScan(opc, sheetPart)));
    panes.set(name, scanAlone(opc, sheetPart, paneScan()));
  }
  return {
    book,
    sheetNames: book.SheetNames,
    validations,
    tables,
    conditionalFormats,
    images,
    panes,
    media,
  };
}

function stateOf(book: XLSX.WorkBook, name: string): string {
  const entry = book.Workbook?.Sheets?.find((sheet) => sheet.name === name);
  switch (entry?.Hidden) {
    case 1:
      return "hidden";
    case 2:
      return "veryHidden";
    default:
      return "visible";
  }
}

function sheetNameSummary(loaded: SheetJsWorkbook): string {
  return loaded.sheetNames
    .map((name) => {
      const state = stateOf(loaded.book, name);
      return state === "visible" ? name : `${name} (${state})`;
    })
    .join(", ");
}

function selectSheetName(
  loaded: SheetJsWorkbook,
  sheetName: string | undefined,
): string {
  if (sheetName === undefined) {
    const visible = loaded.sheetNames.find(
      (name) => stateOf(loaded.book, name) === "visible",
    );
    const fallback = visible ?? loaded.sheetNames[0];
    if (fallback === undefined) {
      throw new SezzleeExcelError(
        "unknown_sheet",
        "The workbook has no worksheets.",
      );
    }
    return fallback;
  }
  const wanted = canonical(sheetName);
  const found = loaded.sheetNames.filter((name) => canonical(name) === wanted);
  if (found.length > 1) {
    throw new SezzleeExcelError(
      "ambiguous_sheet",
      `The workbook has ${found.length} sheets whose names normalise to '${sheetName}'.`,
      "Rename the sheets in the workbook; they cannot be addressed apart.",
    );
  }
  const only = found[0];
  if (only === undefined) {
    throw new SezzleeExcelError(
      "unknown_sheet",
      `The workbook has no sheet named '${sheetName}'.`,
      `Available sheets: ${sheetNameSummary(loaded)}.`,
    );
  }
  return only;
}

function sheetOf(loaded: SheetJsWorkbook, name: string): XLSX.WorkSheet {
  const sheet = loaded.book.Sheets[name];
  if (sheet === undefined) {
    throw new SezzleeExcelError(
      "unknown_sheet",
      `The workbook has no sheet named '${name}'.`,
      `Available sheets: ${sheetNameSummary(loaded)}.`,
    );
  }
  return sheet;
}

function denseRows(sheet: XLSX.WorkSheet): readonly (readonly unknown[])[] {
  const dense = (sheet as { "!data"?: unknown[][] })["!data"];
  return dense ?? [];
}

function carriesValue(cell: SheetJsCell | undefined | null): boolean {
  if (cell == null) return false;
  return cell.f !== undefined || (cell.t !== "z" && cell.v !== undefined);
}

const boundsCache = new WeakMap<
  XLSX.WorkSheet,
  { readonly bounds: GridBounds | undefined }
>();

/**
 * `!ref` is the dimension the writer declared, which routinely spans rows that
 * were formatted and never filled. Every range this server reports is the
 * value-derived one, so the grid is scanned once per sheet instead.
 */
function boundsOf(sheet: XLSX.WorkSheet): GridBounds | undefined {
  const cached = boundsCache.get(sheet);
  if (cached !== undefined) {
    return cached.bounds;
  }
  let top = 0;
  let left = 0;
  let bottom = 0;
  let right = 0;
  const rows = denseRows(sheet);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    for (let column = 0; column < row.length; column += 1) {
      if (!carriesValue(row[column] as SheetJsCell | undefined)) continue;
      const rowNumber = index + 1;
      const columnNumber = column + 1;
      if (top === 0) {
        top = rowNumber;
        left = columnNumber;
        right = columnNumber;
      }
      bottom = rowNumber;
      if (columnNumber < left) left = columnNumber;
      if (columnNumber > right) right = columnNumber;
    }
  }
  const bounds = top === 0 ? undefined : { top, left, bottom, right };
  boundsCache.set(sheet, { bounds });
  return bounds;
}

function declaredBoundsOf(sheet: XLSX.WorkSheet): GridBounds | undefined {
  const ref = sheet["!ref"];
  if (typeof ref !== "string" || ref === "") {
    return undefined;
  }
  const [start, end] = ref.split(":");
  if (start === undefined) {
    return undefined;
  }
  const from = parseCellRef(start);
  const to = end === undefined ? from : parseCellRef(end);
  return { top: from.row, left: from.column, bottom: to.row, right: to.column };
}

function mergesOf(sheet: XLSX.WorkSheet): readonly MergeRange[] {
  const raw = sheet["!merges"];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((range) => {
    const top = range.s.r + 1;
    const left = range.s.c + 1;
    const bottom = range.e.r + 1;
    const right = range.e.c + 1;
    return {
      top,
      left,
      bottom,
      right,
      ref: `${formatCellRef(top, left)}:${formatCellRef(bottom, right)}`,
    };
  });
}

function autoFilterOf(sheet: XLSX.WorkSheet): string | undefined {
  const ref = sheet["!autofilter"]?.ref;
  return typeof ref === "string" ? ref : undefined;
}

export function sheetjsSheetView(
  loaded: SheetJsWorkbook,
  sheetName: string | undefined,
  tables: readonly DeclaredTable[] = [],
): SheetView {
  const name = selectSheetName(loaded, sheetName);
  const sheet = sheetOf(loaded, name);
  const merges = mergesOf(sheet);
  const rows = denseRows(sheet);
  const cellAt = (row: number, column: number) =>
    (rows[row - 1]?.[column - 1] ?? undefined) as SheetJsCell | undefined;
  const repeated = (
    stored: Iterable<number>,
    ranges: readonly (readonly [number, number])[],
    { from, to }: Populated,
  ): Iterable<number> => {
    if (ranges.length === 0) return stored;
    const indices = new Set(stored);
    for (const [first, last] of ranges) {
      for (let at = Math.max(from, first); at <= Math.min(to, last); at += 1) {
        indices.add(at);
      }
    }
    return [...indices].sort((a, b) => a - b);
  };
  const withMaster = (merge: MergeRange): boolean =>
    cellAt(merge.top, merge.left) !== undefined;
  return {
    name,
    bounds: boundsOf(sheet),
    merges: merges.map((merge) => merge.ref),
    tables,
    autoFilter: autoFilterOf(sheet),
    rowAt(row): RowView | undefined {
      const covering = merges.filter(
        (merge) => merge.top <= row && row <= merge.bottom,
      );
      return {
        cellAt(column) {
          const merge = covering.find(
            (range) => range.left <= column && column <= range.right,
          );
          /**
           * Only the top-left cell of a merge is stored. Every other cell in
           * the range resolves to it, so the merge policy can repeat the
           * master value or blank the continuation.
           */
          if (merge !== undefined) {
            const master = cellAt(merge.top, merge.left);
            if (master === undefined) {
              return undefined;
            }
            const isMaster = merge.top === row && merge.left === column;
            return sheetjsSnapshot(master, !isMaster);
          }
          const cell = cellAt(row, column);
          return cell === undefined ? undefined : sheetjsSnapshot(cell, false);
        },
        populatedColumns(span) {
          const stored = presentIndices(
            rows[row - 1] ?? [],
            span.from,
            span.to,
          );
          return span.withCovered
            ? repeated(
                stored,
                covering
                  .filter(withMaster)
                  .map((merge) => [merge.left, merge.right] as const),
                span,
              )
            : stored;
        },
      };
    },
    populatedRows(span) {
      const stored = presentIndices(rows, span.from, span.to);
      return span.withCovered
        ? repeated(
            stored,
            merges
              .filter(withMaster)
              .map((merge) => [merge.top, merge.bottom] as const),
            span,
          )
        : stored;
    },
  };
}

function formulaStats(sheet: XLSX.WorkSheet): {
  readonly formulaCellCount: number;
  readonly cachedFormulaValueCount: number;
} {
  let formulaCellCount = 0;
  let cachedFormulaValueCount = 0;
  for (const row of denseRows(sheet)) {
    for (const raw of row ?? []) {
      const cell = raw as SheetJsCell | undefined | null;
      if (cell?.f === undefined || cell.f === "") {
        continue;
      }
      formulaCellCount += 1;
      if (cell.t !== "z" && cell.v !== undefined) {
        cachedFormulaValueCount += 1;
      }
    }
  }
  return { formulaCellCount, cachedFormulaValueCount };
}

function definedNamesOf(
  book: XLSX.WorkBook,
): readonly { readonly name: string; readonly ranges: readonly string[] }[] {
  return (book.Workbook?.Names ?? [])
    .filter((entry) => typeof entry.Name === "string")
    .map((entry) => ({
      name: entry.Name,
      ranges: typeof entry.Ref === "string" ? [entry.Ref] : [],
    }));
}

export interface DescribeOptions {
  readonly includeDefinedNames: boolean;
}

export function describeSheetJs(
  loaded: SheetJsWorkbook,
  meta: DocumentMeta,
  options: DescribeOptions,
): WorkbookDescription {
  const sheets = loaded.sheetNames.map((name, ordinal): SheetSummary => {
    const sheet = sheetOf(loaded, name);
    const bounds = boundsOf(sheet);
    const declared = declaredBoundsOf(sheet);
    const stats = formulaStats(sheet);
    return {
      name,
      index: ordinal + 1,
      state: stateOf(loaded.book, name),
      usedRange: bounds === undefined ? null : formatRange(bounds),
      rowCount: bounds === undefined ? 0 : bounds.bottom - bounds.top + 1,
      columnCount: bounds === undefined ? 0 : bounds.right - bounds.left + 1,
      declaredRowCount: declared?.bottom ?? 0,
      declaredColumnCount: declared?.right ?? 0,
      mergeCount: mergesOf(sheet).length,
      dataValidationRuleCount: loaded.validations.get(name)?.rules.length ?? 0,
      dataValidationRuleCountExact: true,
      formulaCellCount: stats.formulaCellCount,
      cachedFormulaValueCount: stats.cachedFormulaValueCount,
      tableCount: loaded.tables.get(name)?.length ?? 0,
      conditionalFormatRuleCount: conditionalFormatRuleCountOf(
        loaded.conditionalFormats.get(name) ?? [],
      ),
      imageCount: loaded.images.get(name)?.length ?? 0,
      imageCountExact: false,
      autoFilterRef: autoFilterOf(sheet) ?? null,
      frozenRowCount: loaded.panes.get(name)?.rows ?? 0,
      frozenColumnCount: loaded.panes.get(name)?.columns ?? 0,
    };
  });
  const tallest = sheets.reduce(
    (largest, sheet) => Math.max(largest, sheet.rowCount),
    0,
  );
  return {
    filePath: meta.filePath,
    sizeBytes: meta.sizeBytes,
    modifiedAt: meta.modifiedAt,
    dateSystem:
      loaded.book.Workbook?.WBProps?.date1904 === true ? "1904" : "1900",
    sheets,
    limitations: options.includeDefinedNames
      ? [metadataLimitations.definedNames]
      : [],
    ...(options.includeDefinedNames
      ? {
          definedNames: definedNamesOf(loaded.book),
          definedNamesComplete: false as const,
        }
      : {}),
    ...(tallest > limits.guidanceRowThreshold
      ? {
          guidance: `The largest sheet has ${tallest} rows. Use aggregate_sheet for totals and rankings, find_in_sheet to locate a value, or read_sheet with a narrow range.`,
        }
      : {}),
  };
}
