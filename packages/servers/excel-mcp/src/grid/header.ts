import { fold } from "@sezzlee/file-core";
import {
  normalizeCell,
  type CellScalar,
  type NormalizeOptions,
} from "./cell-value.js";
import type { MergePolicy } from "./cursor.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import { classify } from "./predicate.js";
import {
  columnToLetters,
  parseCellRef,
  type CellRef,
  type GridBounds,
} from "./range.js";
import type { DeclaredTable, SheetView } from "./sheet.js";

export type HeaderRowSource =
  "explicit" | "declared" | "scanned" | "default" | "cursor";

export interface DeclaredHeader {
  readonly row: number;
  readonly source: string;
}

export interface RowFacts {
  readonly row: number;
  readonly width: number;
  readonly naming: number;
  readonly disqualifying: number;
  readonly filled: number;
  readonly mergedSpan: number;
  readonly texts: readonly string[];
}

function mergedSpanAt(
  merges: readonly string[],
  row: number,
  bounds: GridBounds,
): number {
  let widest = 0;
  for (const merge of merges) {
    const [start, end] = merge.split(":");
    if (start === undefined || end === undefined) {
      continue;
    }
    const topLeft = parseCellRef(start);
    const bottomRight = parseCellRef(end);
    if (topLeft.row > row || bottomRight.row < row) {
      continue;
    }
    const left = Math.max(topLeft.column, bounds.left);
    const right = Math.min(bottomRight.column, bounds.right);
    if (right >= left) {
      widest = Math.max(widest, right - left + 1);
    }
  }
  return widest;
}

function namesTheRowBelow(
  sheet: SheetView,
  table: DeclaredTable,
  topLeft: CellRef,
  mergePolicy: MergePolicy,
): boolean {
  const view = sheet.rowAt(topLeft.row);
  let compared = 0;
  let matched = 0;
  for (let offset = 0; offset < table.columns.length; offset += 1) {
    const name = table.columns[offset];
    if (name === undefined || name === null || name === "") {
      continue;
    }
    compared += 1;
    const snapshot = view?.cellAt(topLeft.column + offset);
    if (snapshot === undefined) {
      continue;
    }
    const value = normalizeCell(snapshot, {
      valueMode: "values",
      mergePolicy,
      includeHyperlinks: false,
    }).value;
    if (typeof value === "string" && fold(value) === fold(name)) {
      matched += 1;
    }
  }
  return compared > 0 && matched === compared;
}

export function declaresHeaderRow(
  sheet: SheetView,
  table: DeclaredTable,
  topLeft: CellRef,
  mergePolicy: MergePolicy,
): boolean {
  return (
    table.headerRow || namesTheRowBelow(sheet, table, topLeft, mergePolicy)
  );
}

export function declaredHeaderRow(
  sheet: SheetView,
  bounds: GridBounds,
  mergePolicy: MergePolicy,
): DeclaredHeader | undefined {
  const candidates: DeclaredHeader[] = [];
  for (const table of sheet.tables) {
    const [start, end] = table.ref.split(":");
    if (start === undefined) {
      continue;
    }
    const topLeft = parseCellRef(start);
    const bottomRight = parseCellRef(end ?? start);
    if (topLeft.column > bounds.left || bottomRight.column < bounds.right)
      continue;
    if (topLeft.row < bounds.top || topLeft.row > bounds.bottom) {
      continue;
    }
    if (!declaresHeaderRow(sheet, table, topLeft, mergePolicy)) {
      continue;
    }
    candidates.push({ row: topLeft.row, source: `table ${table.name}` });
  }
  if (candidates.length > 1)
    throw new SezzleeExcelError(
      "ambiguous_header_row",
      "Multiple tables can provide the header for this range.",
      "Pass headerRow explicitly.",
    );
  if (candidates.length === 1) return candidates[0];
  const filter = sheet.autoFilter;
  if (filter !== undefined) {
    const [start, end] = filter.split(":");
    if (start !== undefined) {
      const topLeft = parseCellRef(start);
      const bottomRight = parseCellRef(end ?? start);
      if (
        topLeft.row >= bounds.top &&
        topLeft.row <= bounds.bottom &&
        topLeft.column <= bounds.left &&
        bottomRight.column >= bounds.right
      ) {
        return { row: topLeft.row, source: "the sheet autofilter" };
      }
    }
  }
  return undefined;
}

export function readHeaderRow(
  sheet: SheetView,
  bounds: GridBounds,
  headerRow: number,
  options: NormalizeOptions,
): (string | null)[] {
  const headers: (string | null)[] = [];
  const view = headerRow > 0 ? sheet.rowAt(headerRow) : undefined;
  for (let column = bounds.left; column <= bounds.right; column += 1) {
    const snapshot = view?.cellAt(column);
    if (snapshot === undefined) {
      headers.push(null);
      continue;
    }
    headers.push(headerText(normalizeCell(snapshot, options).value));
  }
  return headers;
}

/**
 * A header cell's text. A year, a number or a boolean names its column as
 * well as a word does, so it is kept as the text Excel shows for it instead
 * of becoming null; a date already arrives as its ISO text.
 */
function headerText(value: CellScalar): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return null;
}

export function rowFacts(
  sheet: SheetView,
  bounds: GridBounds,
  row: number,
  mergePolicy: MergePolicy,
): RowFacts {
  const view = sheet.rowAt(row);
  const texts: string[] = [];
  let naming = 0;
  let disqualifying = 0;
  let filled = 0;
  for (let column = bounds.left; column <= bounds.right; column += 1) {
    const snapshot = view?.cellAt(column);
    if (snapshot === undefined) {
      continue;
    }
    const value = normalizeCell(snapshot, {
      valueMode: "values",
      mergePolicy,
      includeHyperlinks: false,
    }).value;
    const kind = classify(value);
    if (kind === "empty") {
      continue;
    }
    filled += 1;
    if (kind === "text") {
      if (value !== "") {
        naming += 1;
        texts.push(String(value));
      }
      continue;
    }
    disqualifying += 1;
  }
  return {
    row,
    width: bounds.right - bounds.left + 1,
    naming,
    disqualifying,
    filled,
    mergedSpan: mergedSpanAt(sheet.merges, row, bounds),
    texts,
  };
}

export function isHeaderCandidate(facts: RowFacts): boolean {
  return (
    facts.disqualifying === 0 &&
    facts.mergedSpan <= 1 &&
    facts.naming >= Math.min(2, facts.width)
  );
}

function scanWindow(bounds: GridBounds): { first: number; last: number } {
  return {
    first: bounds.top,
    last: Math.min(bounds.top + limits.headerScanRows - 1, bounds.bottom),
  };
}

function preview(facts: RowFacts): string {
  return facts.texts.slice(0, 8).join(", ");
}

export function scanHeaderRow(
  sheet: SheetView,
  bounds: GridBounds,
  mergePolicy: MergePolicy,
  label: string,
): number {
  const declared = declaredHeaderRow(sheet, bounds, mergePolicy);
  if (declared !== undefined) {
    return declared.row;
  }
  const { first, last } = scanWindow(bounds);
  const facts: RowFacts[] = [];
  for (let row = first; row <= last; row += 1) {
    facts.push(rowFacts(sheet, bounds, row, mergePolicy));
  }
  const headerAt = facts.findIndex(isHeaderCandidate);
  if (headerAt === -1) {
    throw new SezzleeExcelError(
      "unknown_header_row",
      `No row in rows ${first}-${last} of ${label} is a header row; every row holds a number, date, boolean or error cell, or carries fewer than two header texts.`,
      "Pass headerRow 0 to read without headers, or widen the range to include the header row.",
    );
  }
  const header = facts[headerAt] as RowFacts;
  const next = facts.slice(headerAt + 1).find((entry) => entry.filled > 0);
  if (next !== undefined && isHeaderCandidate(next)) {
    throw new SezzleeExcelError(
      "ambiguous_header_row",
      `Rows ${header.row} and ${next.row} of ${label} are both header rows by text; the header row cannot be proven.`,
      `Pass headerRow explicitly. Row ${header.row}: ${preview(header)}. Row ${next.row}: ${preview(next)}. headerRow 0 disables headers.`,
    );
  }
  return header.row;
}

export type DefaultHeaderSource = "declared" | "scanned" | "default";

/**
 * The header row a call that names none reads by: the row a table or the
 * autofilter declares, else the first of the top rows of the used range that
 * names its columns by text alone, else row 1.
 *
 * Guard: the scan always covers the whole used range, never the requested
 * window, so every tool and describe_workbook name the same row whatever rows
 * or columns a call asks for. A window that starts below the header would
 * otherwise elect a text-only data row, and a single column would elect a
 * title sitting above it.
 */
export function defaultHeaderRow(
  sheet: SheetView,
  requested: GridBounds,
  mergePolicy: MergePolicy,
): { readonly row: number; readonly source: DefaultHeaderSource } {
  const declared = declaredUnlessAmbiguous(sheet, requested, mergePolicy);
  if (declared !== undefined) return { row: declared.row, source: "declared" };
  const used = sheet.bounds;
  if (used === undefined) return { row: 1, source: "default" };
  const { first, last } = scanWindow(used);
  for (let row = first; row <= last; row += 1) {
    if (isHeaderCandidate(rowFacts(sheet, used, row, mergePolicy)))
      return { row, source: "scanned" };
  }
  return { row: 1, source: "default" };
}

function declaredUnlessAmbiguous(
  sheet: SheetView,
  bounds: GridBounds,
  mergePolicy: MergePolicy,
): DeclaredHeader | undefined {
  try {
    return declaredHeaderRow(sheet, bounds, mergePolicy);
  } catch (error) {
    if (
      error instanceof SezzleeExcelError &&
      error.code === "ambiguous_header_row"
    )
      return undefined;
    throw error;
  }
}

export function headerWarnings(
  sheet: SheetView,
  bounds: GridBounds,
  headerRow: number,
  headers: readonly (string | null)[],
  hasExplicitRange: boolean,
  mergePolicy: MergePolicy,
): string[] {
  const malformed = sheet.tables.filter((table) =>
    table.columns.some((name) => name === null),
  );
  if (malformed.length > 0)
    return [
      `Table metadata has missing column names (${malformed.map((table) => table.name).join(", ")}); column positions were preserved.`,
    ];
  const width = bounds.right - bounds.left + 1;
  if (headerRow <= 0 || width < 2 || hasExplicitRange) {
    return [];
  }
  const named = headers.filter(
    (header) => header !== null && header !== "",
  ).length;
  const declared = declaredHeaderRow(sheet, bounds, mergePolicy);
  if (declared !== undefined && declared.row !== headerRow) {
    return [
      `headerRow ${headerRow} is not the header row declared by ${declared.source}, which declares row ${declared.row}; pass headerRow ${declared.row}, or headerScan true.`,
    ];
  }
  if (named > 1 || declared !== undefined) {
    return [];
  }
  const { first, last } = scanWindow(bounds);
  const candidates: RowFacts[] = [];
  for (let row = first; row <= last; row += 1) {
    if (row === headerRow) {
      continue;
    }
    const facts = rowFacts(sheet, bounds, row, mergePolicy);
    if (facts.filled > 0 && isHeaderCandidate(facts)) {
      candidates.push(facts);
    }
  }
  if (candidates.length === 0) {
    return [];
  }
  const span = `${columnToLetters(bounds.left)}..${columnToLetters(bounds.right)}`;
  const rows = candidates.map((facts) => facts.row);
  const only = candidates[0] as RowFacts;
  const where =
    rows.length === 1
      ? `Row ${only.row} is the only row in rows ${first}-${last} that qualifies as a header row by text`
      : `Rows ${rows.join(", ")} qualify as header rows by text`;
  return [
    `headerRow ${headerRow} produced no usable header text across columns ${span}. ${where}; pass headerRow ${only.row}, or headerScan true.`,
  ];
}
