import { maxColumn, type GridBounds } from "../../grid/range.js";
import { SezzleeExcelError } from "../../platform/errors.js";
import type { WorkbookPackage } from "./package.js";
import { rangeOf } from "./sheet-layout.js";
import { namespaces, readXmlPart } from "./xml.js";

export interface Hyperlink extends GridBounds {
  readonly href: string;
}

/**
 * Guard: Excel keeps at most 66,530 hyperlinks on a worksheet (Excel
 * specifications and limits), so a part listing more was not written by Excel.
 * The ceiling also bounds the scan a cell outside the index falls back to.
 */
const maxHyperlinksPerSheet = 66_530;

/**
 * Guard: building the index visits every cell a link covers, and an anchor
 * such as `A1:XFD1048576` names 17 billion of them, so the visits are capped.
 * The widest sheet in the corpus covers 16,391 cells.
 */
const maxIndexedCells = 1_000_000;

/**
 * Reads the hyperlinks a worksheet anchors on its cells. The target is the
 * relationship's, followed by `#location` when the link also names a place in
 * that target; a link with a location alone points inside the workbook
 * (`#Sheet2!A1`). A link with neither, or with an anchor that names no cells,
 * carries nothing and is skipped.
 */
export function readHyperlinks(
  opc: WorkbookPackage,
  sheetPart: string,
): readonly Hyperlink[] {
  const xml = opc.part(sheetPart);
  if (xml === undefined) return [];
  const rels = opc.relationshipsFor(sheetPart);
  const links: Hyperlink[] = [];
  readXmlPart(xml, sheetPart, {
    onOpen(node) {
      if (node.uri !== namespaces.spreadsheetml) return;
      if (node.local !== "hyperlink") return;
      const ref = node.attr("ref");
      const bounds = ref === undefined ? undefined : rangeOf(ref);
      if (bounds === undefined) return;
      const id = node.attr("id", namespaces.officeRelationships);
      const target = id === undefined ? undefined : rels.get(id)?.target;
      const location = node.attr("location");
      const suffix = location === undefined ? "" : `#${location}`;
      if (target === undefined && location === undefined) return;
      if (links.length === maxHyperlinksPerSheet) {
        throw new SezzleeExcelError(
          "file_too_large",
          `'${sheetPart}' carries more than ${String(maxHyperlinksPerSheet)} hyperlinks, the most Excel keeps on one sheet.`,
          "Open the file in Excel and re-save it as .xlsx.",
        );
      }
      links.push({ ...bounds, href: `${target ?? ""}${suffix}` });
    },
  });
  return links;
}

export interface HyperlinkIndex {
  /**
   * @returns the link a cell carries; where several links cover it, the one
   *   the sheet lists last wins, as it does in SheetJS.
   */
  at(row: number, column: number): string | undefined;
  /** Visits every indexed cell once, with the link it carries. */
  forEachCell(visit: (row: number, column: number, href: string) => void): void;
}

const keyOf = (row: number, column: number): number =>
  (row - 1) * maxColumn + (column - 1);

function lastCovering(
  links: readonly Hyperlink[],
  row: number,
  column: number,
): string | undefined {
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links.at(index);
    if (
      link !== undefined &&
      link.top <= row &&
      row <= link.bottom &&
      link.left <= column &&
      column <= link.right
    ) {
      return link.href;
    }
  }
  return undefined;
}

/**
 * Indexes the cells the links cover, the last link first, until the visit
 * budget runs out. Every indexed link comes later in the sheet than every link
 * the budget did not reach (the one it ran out in counts as unreached), so an
 * indexed cell's link is final and only a cell outside the index scans the
 * links that are left.
 */
export function hyperlinkIndex(links: readonly Hyperlink[]): HyperlinkIndex {
  const indexed = new Map<number, string>();
  let visits = 0;
  let reached = links.length;
  scan: for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links.at(index);
    if (link === undefined) break;
    for (let row = link.top; row <= link.bottom; row += 1) {
      for (let column = link.left; column <= link.right; column += 1) {
        if (visits === maxIndexedCells) break scan;
        visits += 1;
        const key = keyOf(row, column);
        if (!indexed.has(key)) indexed.set(key, link.href);
      }
    }
    reached = index;
  }
  const rest = links.slice(0, reached);
  return {
    at(row, column) {
      return indexed.get(keyOf(row, column)) ?? lastCovering(rest, row, column);
    },
    forEachCell(visit) {
      for (const [key, href] of indexed) {
        visit(Math.floor(key / maxColumn) + 1, (key % maxColumn) + 1, href);
      }
    },
  };
}
