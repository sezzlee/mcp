import { namespaces, type PartScan, type XmlVisitor } from "./xml.js";

export interface OoxmlPanes {
  readonly rows: number;
  readonly columns: number;
}

/**
 * Only a frozen pane pins rows or columns; a plain split is a scroll divider
 * measured in points, and reporting it as frozen rows would be wrong.
 */
export function paneScan(): PartScan<OoxmlPanes> {
  let rows = 0;
  let columns = 0;
  let seen = false;
  const visitor: XmlVisitor = {
    onOpen(node) {
      if (
        seen ||
        node.uri !== namespaces.spreadsheetml ||
        node.local !== "pane"
      ) {
        return;
      }
      const state = node.attr("state") ?? "split";
      if (state !== "frozen" && state !== "frozenSplit") return;
      seen = true;
      rows = Number.parseInt(node.attr("ySplit") ?? "0", 10) || 0;
      columns = Number.parseInt(node.attr("xSplit") ?? "0", 10) || 0;
    },
  };
  return { visitor, finish: () => ({ rows, columns }) };
}
