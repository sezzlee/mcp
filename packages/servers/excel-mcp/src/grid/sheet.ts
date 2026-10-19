import type { Fingerprint } from "@sezzlee/file-core";
import type { CellSnapshot } from "./cell-value.js";
import { SezzleeExcelError } from "../platform/errors.js";
import type { GridBounds } from "./range.js";

export interface DeclaredTable {
  readonly name: string;
  readonly displayName?: string;
  readonly ref: string;
  readonly headerRow: boolean;
  readonly totalsRow?: boolean;
  readonly headerRowCount?: number;
  readonly totalsRowCount?: number;
  readonly autoFilterRef?: string;
  readonly columns: readonly (string | null)[];
}

/**
 * `withCovered` adds the cells a merge covers without storing; they read as
 * the master's value only under the `repeat` policy.
 */
export interface Populated {
  readonly from: number;
  readonly to: number;
  readonly withCovered: boolean;
}

export interface RowView {
  cellAt(column: number): CellSnapshot | undefined;
  /** @returns the columns in range that can carry a snapshot, ascending. */
  populatedColumns(span: Populated): Iterable<number>;
}

export interface SheetView {
  readonly name: string;
  readonly bounds: GridBounds | undefined;
  readonly merges: readonly string[];
  readonly tables: readonly DeclaredTable[];
  readonly autoFilter: string | undefined;
  readonly hiddenRows: ReadonlySet<number>;
  rowAt(row: number): RowView | undefined;
  /** @returns the rows in range that can carry a snapshot, ascending. */
  populatedRows(span: Populated): Iterable<number>;
}

export interface SheetSource {
  readonly stamp: Fingerprint;
  sheetFor(sheetName: string | undefined): SheetView;
  tables(
    sheetName?: string,
  ): Iterable<{ readonly sheet: string; readonly table: DeclaredTable }>;
}

export interface BoundedSheet {
  readonly name: string;
  readonly bounds: GridBounds | undefined;
}

export function requireSheetBounds(sheet: BoundedSheet): GridBounds {
  if (sheet.bounds === undefined) {
    throw new SezzleeExcelError(
      "empty_sheet",
      `Sheet '${sheet.name}' has no cells with values.`,
      "Call describe_workbook to see which sheets carry data.",
    );
  }
  return sheet.bounds;
}

export function* presentIndices(
  items: readonly unknown[],
  from: number,
  to: number,
): Generator<number> {
  const last = Math.min(to, items.length);
  for (let index = Math.max(from, 1); index <= last; index += 1) {
    if (items[index - 1] != null) yield index;
  }
}
