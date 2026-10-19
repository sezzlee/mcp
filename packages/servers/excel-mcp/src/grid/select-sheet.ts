import { fold } from "@sezzlee/file-core";
import { SezzleeExcelError } from "../platform/errors.js";
import { readHeaderRow } from "./header.js";
import type { NormalizeOptions } from "./cell-value.js";
import {
  formatRange,
  parseCellRef,
  resolveRange,
  type GridBounds,
} from "./range.js";
import {
  requireSheetBounds,
  type DeclaredTable,
  type SheetSource,
  type SheetView,
} from "./sheet.js";

export interface SelectionOptions {
  readonly sheetName?: string;
  readonly range?: string;
  readonly table?: string;
  readonly headerRow?: number;
  readonly visibleOnly?: boolean;
}

export interface TableSelection {
  readonly name: string;
  readonly ref: string;
  readonly dataRange: string;
  readonly totalsRowExcluded: boolean;
}

export interface SheetSelection {
  readonly sheet: SheetView;
  readonly used: GridBounds;
  readonly bounds: GridBounds;
  readonly table?: TableSelection;
  readonly declared?: DeclaredTable;
  readonly tableHeaderRow?: number;
}

export interface VisibilityReport {
  readonly basis: "savedHiddenRows";
  readonly hiddenRowsSkipped: number;
  readonly filterCriteriaReevaluated: false;
  readonly autoFilterRef?: string;
}

export function selectSheetRange(
  source: SheetSource,
  options: SelectionOptions,
): SheetSelection {
  if (options.table === undefined) {
    const sheet = source.sheetFor(options.sheetName);
    const used = requireSheetBounds(sheet);
    return { sheet, used, bounds: resolveRange(used, options.range) };
  }
  if (options.range !== undefined)
    throw new SezzleeExcelError(
      "invalid_argument",
      "table cannot be combined with range.",
      "Pass table to select its data rows, or range for an explicit rectangle.",
    );
  const wanted = fold(options.table);
  if (wanted.trim() === "" || options.table.length > 255)
    throw new SezzleeExcelError(
      "invalid_argument",
      "table must be a nonblank name of at most 255 characters.",
    );
  const sheetName =
    options.sheetName === undefined
      ? undefined
      : source.sheetFor(options.sheetName).name;
  const found = [...source.tables(sheetName)].filter(
    (entry) =>
      (sheetName === undefined || entry.sheet === sheetName) &&
      (fold(entry.table.name) === wanted ||
        fold(entry.table.displayName ?? entry.table.name) === wanted),
  );
  if (found.length === 0)
    throw new SezzleeExcelError(
      "unknown_table",
      `No table named '${options.table}' was found${sheetName === undefined ? "" : ` on sheet '${sheetName}'`}.`,
      "Call get_tables on the relevant worksheet to see its declared names.",
    );
  if (found.length !== 1)
    throw new SezzleeExcelError(
      "ambiguous_table",
      `Table name '${options.table}' identifies more than one table.`,
      "Pass sheetName to select a worksheet, or repair duplicate table names.",
    );
  const match = found[0];
  if (match === undefined)
    throw new SezzleeExcelError(
      "unknown_table",
      "The requested table was not found.",
    );
  const table = match.table;
  const [start, end] = table.ref.split(":");
  if (start === undefined || table.ref.split(":").length > 2)
    throw new SezzleeExcelError(
      "corrupt_workbook",
      `Table '${table.name}' has an invalid range.`,
    );
  const first = parseCellRef(start);
  const last = parseCellRef(end ?? start);
  const headerCount = table.headerRowCount ?? (table.headerRow ? 1 : 0);
  const totalsCount = table.totalsRowCount ?? (table.totalsRow ? 1 : 0);
  if (
    (headerCount !== 0 && headerCount !== 1) ||
    (totalsCount !== 0 && totalsCount !== 1)
  )
    throw new SezzleeExcelError(
      "unsupported_object_kind",
      `Table '${table.name}' declares unsupported header or totals row counts.`,
      "Use an explicit range and headerRow instead of table.",
    );
  const bounds = {
    top: first.row + headerCount,
    bottom: last.row - totalsCount,
    left: first.column,
    right: last.column,
  };
  if (first.row > last.row || first.column > last.column)
    throw new SezzleeExcelError(
      "corrupt_workbook",
      `Table '${table.name}' has a reversed range.`,
    );
  if (bounds.top > bounds.bottom)
    throw new SezzleeExcelError(
      "empty_sheet",
      `Table '${table.name}' has no data rows.`,
      "Choose another table or read its header with an explicit range.",
    );
  if (table.columns.length !== bounds.right - bounds.left + 1)
    throw new SezzleeExcelError(
      "corrupt_workbook",
      `Table '${table.name}' has a column count that does not match its range.`,
      "Use an explicit range and columnMode='letter' to inspect stored cells.",
    );
  const tableHeaderRow = headerCount === 0 ? 0 : first.row;
  if (options.headerRow !== undefined && options.headerRow !== tableHeaderRow)
    throw new SezzleeExcelError(
      "invalid_argument",
      `headerRow conflicts with table '${table.name}', which declares ${tableHeaderRow}.`,
      "Omit headerRow when selecting a table.",
    );
  const sheet = source.sheetFor(match.sheet);
  return {
    sheet,
    used: sheet.bounds ?? {
      top: first.row,
      bottom: last.row,
      left: first.column,
      right: last.column,
    },
    bounds,
    declared: table,
    tableHeaderRow,
    table: {
      name: table.name,
      ref: table.ref,
      dataRange: formatRange(bounds),
      totalsRowExcluded: totalsCount === 1,
    },
  };
}

export function selectionHeaders(
  selection: SheetSelection,
  headerRow: number,
  options: NormalizeOptions,
): (string | null)[] {
  if (selection.declared !== undefined) return [...selection.declared.columns];
  return readHeaderRow(selection.sheet, selection.bounds, headerRow, options);
}

export function hiddenRowsIn(
  sheet: SheetView,
  first: number,
  last: number,
): number {
  let count = 0;
  for (const row of sheet.hiddenRows)
    if (row >= first && row <= last) count += 1;
  return count;
}

export function visibilityOf(
  selection: SheetSelection,
  first: number,
  last: number,
): VisibilityReport {
  const autoFilterRef =
    selection.declared?.autoFilterRef ?? selection.sheet.autoFilter;
  return {
    basis: "savedHiddenRows",
    hiddenRowsSkipped: hiddenRowsIn(selection.sheet, first, last),
    filterCriteriaReevaluated: false,
    ...(autoFilterRef === undefined ? {} : { autoFilterRef }),
  };
}

export function* visibleRows(
  rows: Iterable<number>,
  sheet: SheetView,
  visibleOnly: boolean,
): Generator<number> {
  for (const row of rows)
    if (!visibleOnly || !sheet.hiddenRows.has(row)) yield row;
}
