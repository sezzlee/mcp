import { normalizeCell, scalarText } from "./cell-value.js";
import { columnToLetters, maxRow, type GridBounds } from "./range.js";
import type { SheetView } from "./sheet.js";
import { warning, type Warning } from "./warnings.js";

const shownCells = 12;
const shownChars = 40;

export function rowLimitWarnings(
  sheet: SheetView,
  bounds: GridBounds,
  headers: readonly (string | null)[],
): Warning[] {
  if (bounds.bottom < maxRow) return [];
  const row = sheet.rowAt(maxRow);
  const cells: string[] = [];
  for (
    let column = bounds.left;
    column <= bounds.right && cells.length < shownCells;
    column += 1
  ) {
    const snapshot = row?.cellAt(column);
    if (snapshot === undefined) continue;
    const text = scalarText(
      normalizeCell(snapshot, {
        valueMode: "values",
        mergePolicy: "master",
        includeHyperlinks: false,
      }).value,
    );
    if (text === "") continue;
    const label = headers[column - bounds.left] ?? columnToLetters(column);
    cells.push(`${label}=${text.slice(0, shownChars)}`);
  }
  return [
    warning(
      "row_limit_reached",
      `The data reaches row ${maxRow}, the last row an Excel sheet holds, so the file was most likely cut there and the rows after it are missing. Every total and count over this sheet is a lower bound. Which groups lost rows depends on the order the rows were written in; row ${maxRow} holds ${cells.length === 0 ? "no values" : cells.join(", ")}.`,
    ),
  ];
}
