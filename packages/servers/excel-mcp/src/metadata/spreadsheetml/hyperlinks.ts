import type { GridBounds } from "../../grid/range.js";
import type { WorkbookPackage } from "./package.js";
import { rangeOf } from "./sheet-layout.js";
import { namespaces, readXmlPart } from "./xml.js";

export interface Hyperlink extends GridBounds {
  readonly href: string;
}

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
      links.push({ ...bounds, href: `${target ?? ""}${suffix}` });
    },
  });
  return links;
}

/**
 * @returns the link a cell carries; where several links cover it, the one the
 *   sheet lists last wins, as it does in SheetJS.
 */
export function hyperlinkAt(
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
