import type { OpcPackage } from "./package.js";
import { namespaces, scanPart, type PartScan, type XmlVisitor } from "./xml.js";

export type AnchorKind = "oneCell" | "twoCell" | "absolute";

export interface AnchorCell {
  readonly column: number;
  readonly columnOffset: number;
  readonly row: number;
  readonly rowOffset: number;
}

export interface OoxmlImage {
  readonly mediaPart?: string;
  readonly anchor: AnchorKind;
  readonly from?: AnchorCell;
  readonly to?: AnchorCell;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly editAs?: string;
  readonly hyperlink?: string;
  readonly tooltip?: string;
}

const anchorKinds: Readonly<Record<string, AnchorKind>> = {
  oneCellAnchor: "oneCell",
  twoCellAnchor: "twoCell",
  absoluteAnchor: "absolute",
};

/** DrawingML measures in EMU; this is the count per pixel at 96 DPI. */
const emuPerPixel = 9525;

interface CellDraft {
  column: number;
  columnOffset: number;
  row: number;
  rowOffset: number;
}

interface AnchorDraft {
  kind: AnchorKind;
  editAs?: string;
  from?: CellDraft;
  to?: CellDraft;
  cx?: number;
  cy?: number;
  embedId?: string;
  hyperlinkId?: string;
  tooltip?: string;
  isPicture: boolean;
}

function emptyCell(): CellDraft {
  return { column: 0, columnOffset: 0, row: 0, rowOffset: 0 };
}

export function imageScan(
  opc: OpcPackage,
  sheetPart: string,
): PartScan<readonly OoxmlImage[]> {
  let relationshipId: string | undefined;
  const visitor: XmlVisitor = {
    onOpen(node) {
      if (node.uri !== namespaces.spreadsheetml || node.local !== "drawing") {
        return;
      }
      relationshipId ??= node.attr("id", namespaces.officeRelationships);
    },
  };
  const finish = (): readonly OoxmlImage[] => {
    if (relationshipId === undefined) return [];
    const relationship = opc.relationshipsFor(sheetPart).get(relationshipId);
    return relationship?.kind === "internal"
      ? imagesIn(opc, relationship.target)
      : [];
  };
  return { visitor, finish };
}

/**
 * Every anchor kind carries a picture the same way, so the walk collects one
 * draft per anchor and keeps it only if an `xdr:pic` appeared inside it —
 * charts, shapes and graphic frames use the identical anchor elements.
 *
 * The extent is matched as `(spreadsheetDrawing, ext)`. A picture also carries
 * `<a:ext>` inside `spPr/xfrm` and again inside `extLst`, both in the drawing
 * namespace and both meaning something else; matching the tag name alone would
 * silently read the wrong one.
 */
function imagesIn(opc: OpcPackage, drawingPart: string): readonly OoxmlImage[] {
  const anchors: AnchorDraft[] = [];
  let anchor: AnchorDraft | undefined;
  let target: "from" | "to" | undefined;
  let text: string | undefined;
  let field: string | undefined;

  const found = scanPart(opc, drawingPart, {
    onOpen(node) {
      if (node.uri === namespaces.spreadsheetDrawing) {
        const kind = anchorKinds[node.local];
        if (kind !== undefined) {
          anchor = {
            kind,
            editAs: node.attr("editAs"),
            isPicture: false,
          };
          return;
        }
        if (anchor === undefined) return;
        switch (node.local) {
          case "from":
            anchor.from = emptyCell();
            target = "from";
            break;
          case "to":
            anchor.to = emptyCell();
            target = "to";
            break;
          case "ext":
            anchor.cx = Number.parseInt(node.attr("cx") ?? "", 10);
            anchor.cy = Number.parseInt(node.attr("cy") ?? "", 10);
            break;
          case "pic":
            anchor.isPicture = true;
            break;
          case "col":
          case "colOff":
          case "row":
          case "rowOff":
            if (target !== undefined) {
              field = node.local;
              text = "";
            }
            break;
          default:
            break;
        }
        return;
      }
      if (node.uri !== namespaces.drawing || anchor === undefined) return;
      if (node.local === "blip") {
        anchor.embedId ??= node.attr("embed", namespaces.officeRelationships);
        return;
      }
      if (node.local === "hlinkClick") {
        anchor.hyperlinkId ??= node.attr("id", namespaces.officeRelationships);
        anchor.tooltip ??= node.attr("tooltip");
      }
    },
    onText(chunk) {
      if (text !== undefined) text += chunk;
    },
    onClose(local, uri) {
      if (uri !== namespaces.spreadsheetDrawing) return;
      if (field !== undefined && local === field) {
        const cell = target === "from" ? anchor?.from : anchor?.to;
        const value = Number.parseInt(text ?? "", 10);
        if (cell !== undefined && Number.isFinite(value)) {
          if (field === "col") cell.column = value;
          else if (field === "colOff") cell.columnOffset = value;
          else if (field === "row") cell.row = value;
          else cell.rowOffset = value;
        }
        field = undefined;
        text = undefined;
        return;
      }
      if (local === "from" || local === "to") {
        target = undefined;
        return;
      }
      if (anchorKinds[local] !== undefined) {
        if (anchor !== undefined && anchor.isPicture) anchors.push(anchor);
        anchor = undefined;
      }
    },
  });
  if (!found) return [];

  const rels = opc.relationshipsFor(drawingPart);
  return anchors.map((draft): OoxmlImage => {
    const media =
      draft.embedId === undefined ? undefined : rels.get(draft.embedId);
    const link =
      draft.hyperlinkId === undefined ? undefined : rels.get(draft.hyperlinkId);
    const width =
      draft.cx === undefined || !Number.isFinite(draft.cx)
        ? undefined
        : draft.cx / emuPerPixel;
    const height =
      draft.cy === undefined || !Number.isFinite(draft.cy)
        ? undefined
        : draft.cy / emuPerPixel;
    return {
      ...(media?.kind === "internal" ? { mediaPart: media.target } : {}),
      anchor: draft.kind,
      ...(draft.from === undefined ? {} : { from: draft.from }),
      ...(draft.to === undefined ? {} : { to: draft.to }),
      ...(width === undefined ? {} : { widthPx: width }),
      ...(height === undefined ? {} : { heightPx: height }),
      ...(draft.editAs === undefined ? {} : { editAs: draft.editAs }),
      ...(link === undefined ? {} : { hyperlink: link.target }),
      ...(draft.tooltip === undefined ? {} : { tooltip: draft.tooltip }),
    };
  });
}

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
