import { parseCellRef, type GridBounds } from "../../grid/range.js";
import type { WorkbookPackage } from "./package.js";
import { namespaces, readXmlPart } from "./xml.js";

export interface SheetLayout {
  readonly merges: readonly GridBounds[];
  readonly autoFilter: string | undefined;
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
export function readSheetLayout(
  opc: WorkbookPackage,
  sheetPart: string,
): SheetLayout {
  const xml = opc.part(sheetPart);
  const merges: GridBounds[] = [];
  let autoFilter: string | undefined;
  let dimension: GridBounds | undefined;
  let rows: { first: number; last: number } | undefined;
  if (xml === undefined) return { merges, autoFilter, dimension, rows };
  let depth = 0;
  let inMergeCells = false;
  let inSheetData = false;
  let row = 0;
  readXmlPart(xml, sheetPart, {
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
  });
  return { merges, autoFilter, dimension, rows };
}

/**
 * The range a sheet declares: its `<dimension>`, or else the rows its `<row>`
 * elements name, empty ones included, across the columns its stored cells
 * use. A writer such as Google Sheets omits the dimension and writes its whole
 * grid as empty rows, which is the size it means. A sheet without stored cells
 * declares nothing.
 */
export function declaredBounds(
  layout: SheetLayout,
  cells: readonly { readonly row: number; readonly column: number }[],
): GridBounds | undefined {
  if (layout.dimension !== undefined) return layout.dimension;
  let bounds: GridBounds | undefined;
  for (const { row, column } of cells) {
    bounds =
      bounds === undefined
        ? { top: row, left: column, bottom: row, right: column }
        : {
            top: Math.min(bounds.top, row),
            left: Math.min(bounds.left, column),
            bottom: Math.max(bounds.bottom, row),
            right: Math.max(bounds.right, column),
          };
  }
  if (bounds === undefined || layout.rows === undefined) return bounds;
  return {
    ...bounds,
    top: Math.min(bounds.top, layout.rows.first),
    bottom: Math.max(bounds.bottom, layout.rows.last),
  };
}
