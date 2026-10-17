import { formatCellRef, formatRectangle } from "../grid/range.js";
import type {
  AnchorCell,
  AnchorKind,
  AnchorPlacement,
} from "./spreadsheetml/drawing.js";

/** Where a picture or chart sits, as `get_images` and `get_charts` report it. */
export interface ReportedPlacement {
  readonly anchor: AnchorKind;
  /** The cells a two-cell anchor spans. */
  readonly range?: string;
  /** The top-left cell of a one-cell anchor; its size is in pixels. */
  readonly cell?: string;
  readonly widthPx?: number;
  readonly heightPx?: number;
}

/**
 * A `to` anchor sitting exactly on a cell boundary stops at the previous cell;
 * any offset into the cell means the object covers it.
 */
function spannedRange(from: AnchorCell, to: AnchorCell): string {
  const top = from.row + 1;
  const left = from.column + 1;
  const bottom = to.rowOffset === 0 ? to.row : to.row + 1;
  const right = to.columnOffset === 0 ? to.column : to.column + 1;
  return formatRectangle(
    top,
    left,
    Math.max(top, bottom),
    Math.max(left, right),
  );
}

/**
 * Guard: only a two-cell anchor names the cells an object covers. A one-cell
 * anchor names its top-left cell and a size in pixels, and how many cells that
 * size spans depends on column widths and row heights this reader does not
 * apply, so it is reported as the cell and the size, never as a one-cell
 * range. An absolute anchor names no cell at all.
 */
export function reportedPlacement(
  placement: AnchorPlacement,
): ReportedPlacement {
  const { anchor, from, to, widthPx, heightPx } = placement;
  const size = {
    ...(widthPx === undefined ? {} : { widthPx }),
    ...(heightPx === undefined ? {} : { heightPx }),
  };
  if (anchor === "twoCell" && from !== undefined && to !== undefined) {
    return { anchor, range: spannedRange(from, to), ...size };
  }
  if (anchor === "oneCell" && from !== undefined) {
    return {
      anchor,
      cell: formatCellRef(from.row + 1, from.column + 1),
      ...size,
    };
  }
  return { anchor, ...size };
}
