import { parseCellRef, type GridBounds } from "../../grid/range.js";
import { namespaces, type PartScan, type XmlVisitor } from "./xml.js";

export interface SheetLayout {
  readonly merges: readonly GridBounds[];
  readonly autoFilter: string | undefined;
  readonly hiddenRows: ReadonlySet<number>;
  /** The range the `<dimension>` element declares; a single cell declares none. */
  readonly dimension: GridBounds | undefined;
  /** The first and last row a `<row>` element names, empty rows included. */
  readonly rows: { readonly first: number; readonly last: number } | undefined;
}

/**
 * Parses an A1 cell or range reference as a part stores it; a malformed or
 * reversed reference names no cells.
 */
export function rangeOf(ref: string): GridBounds | undefined {
  const [start, end] = ref.split(":");
  if (start === undefined) return undefined;
  try {
    const from = parseCellRef(start);
    const to = end === undefined ? from : parseCellRef(end);
    if (from.row > to.row || from.column > to.column) return undefined;
    return {
      top: from.row,
      left: from.column,
      bottom: to.row,
      right: to.column,
    };
  } catch {
    return undefined;
  }
}

/**
 * Reads a worksheet's merged ranges, its own auto filter and its declared
 * dimension: the children of `<worksheet>` itself, so an auto filter saved
 * inside a custom sheet view is not the sheet's.
 *
 * Guard: a dimension naming one cell is ignored, as SheetJS ignores it. Excel
 * writes `A1` for an empty sheet, and reporting a declared size of one row
 * there would contradict the sheet's own empty used range.
 */
export function layoutScan(): PartScan<SheetLayout> {
  const merges: GridBounds[] = [];
  let autoFilter: string | undefined;
  const hiddenRows = new Set<number>();
  let dimension: GridBounds | undefined;
  let rows: { first: number; last: number } | undefined;
  let depth = 0;
  let inMergeCells = false;
  let inSheetData = false;
  let row = 0;
  const visitor: XmlVisitor = {
    onOpen(node) {
      depth += 1;
      if (node.uri !== namespaces.spreadsheetml) return;
      if (depth === 2 && node.local === "dimension") {
        const ref = node.attr("ref");
        if (ref?.includes(":")) dimension = rangeOf(ref);
      } else if (depth === 2 && node.local === "autoFilter") {
        autoFilter = node.attr("ref");
      } else if (depth === 2 && node.local === "sheetData") {
        inSheetData = true;
      } else if (inSheetData && depth === 3 && node.local === "row") {
        const stated = Number(node.attr("r"));
        row = Number.isInteger(stated) && stated > 0 ? stated : row + 1;
        const hidden = node.attr("hidden");
        if ((hidden === "1" || hidden === "true") && row <= 1_048_576)
          hiddenRows.add(row);
        rows =
          rows === undefined
            ? { first: row, last: row }
            : {
                first: Math.min(rows.first, row),
                last: Math.max(rows.last, row),
              };
      } else if (depth === 2 && node.local === "mergeCells") {
        inMergeCells = true;
      } else if (inMergeCells && depth === 3 && node.local === "mergeCell") {
        const ref = node.attr("ref");
        const range = ref === undefined ? undefined : rangeOf(ref);
        if (range !== undefined) merges.push(range);
      }
    },
    onClose(local, uri) {
      if (
        depth === 2 &&
        uri === namespaces.spreadsheetml &&
        local === "mergeCells"
      ) {
        inMergeCells = false;
      }
      if (
        depth === 2 &&
        uri === namespaces.spreadsheetml &&
        local === "sheetData"
      ) {
        inSheetData = false;
      }
      depth -= 1;
    },
  };
  return {
    visitor,
    finish: () => ({ merges, autoFilter, hiddenRows, dimension, rows }),
  };
}

/**
 * The range a sheet declares: its `<dimension>`, or else the rows its `<row>`
 * elements name, empty rows included, across the columns its stored cells
 * use. A writer such as Google Sheets omits the dimension and writes its whole
 * grid as empty rows, which is the size it means. A sheet without stored cells
 * declares nothing.
 *
 * @param stored the bounds of every stored cell, empty ones included.
 */
export function declaredBounds(
  layout: SheetLayout,
  stored: GridBounds | undefined,
): GridBounds | undefined {
  if (layout.dimension !== undefined) return layout.dimension;
  if (stored === undefined || layout.rows === undefined) return stored;
  return {
    ...stored,
    top: Math.min(stored.top, layout.rows.first),
    bottom: Math.max(stored.bottom, layout.rows.last),
  };
}
