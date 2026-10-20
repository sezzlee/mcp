import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import { resolveCell } from "./cell-value.js";
import { buildColumnIndex, resolveColumn, type ColumnMode } from "./columns.js";
import { memberKey } from "./predicate.js";
import { formatRange } from "./range.js";
import { selectSheetRange, selectionHeaders } from "./select-sheet.js";
import type { SheetSource } from "./sheet.js";

export interface MemberColumn {
  readonly sheetName?: string;
  readonly range?: string;
  readonly column: string;
  readonly headerRow: number;
  readonly columnMode: ColumnMode;
  readonly mergedCells: "master" | "repeat";
  readonly caseSensitive: boolean;
}

/**
 * The `memberKey` of every value below the header row of one column, which
 * inSet and notInSet test a row's cell against.
 */
export function columnMembers(
  source: SheetSource,
  request: MemberColumn,
): ReadonlySet<string> {
  const selected = selectSheetRange(source, request);
  const { sheet, bounds } = selected;
  const index = buildColumnIndex(
    `${sheet.name}!${formatRange(bounds)}`,
    bounds,
    request.headerRow,
    selectionHeaders(selected, request.headerRow, {
      valueMode: "values",
      mergePolicy: request.mergedCells,
      includeHyperlinks: false,
    }),
  );
  const column = resolveColumn(index, request.column, request.columnMode);
  const first =
    request.headerRow >= bounds.top && request.headerRow <= bounds.bottom
      ? request.headerRow + 1
      : bounds.top;
  const members = new Set<string>();
  for (let row = first; row <= bounds.bottom; row += 1) {
    const snapshot = sheet.rowAt(row)?.cellAt(column);
    if (snapshot === undefined) continue;
    const key = memberKey(
      resolveCell(snapshot, {
        valueMode: "values",
        mergePolicy: request.mergedCells,
      }),
      request.caseSensitive,
    );
    if (key === undefined) continue;
    members.add(key);
    if (members.size > limits.maxSourceValues)
      throw new SezzleeExcelError(
        "resource_limit",
        `The source column holds more than ${limits.maxSourceValues} distinct values.`,
        "Narrow the source with range, or compare a coarser column.",
      );
  }
  return members;
}
