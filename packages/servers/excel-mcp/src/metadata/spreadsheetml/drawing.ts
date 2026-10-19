import { selectAlternateContent } from "@sezzlee/ooxml-core";
import type { OpcPackage } from "./package.js";
import { transitionalNamespace } from "./reader.js";
import {
  isChartExNamespace,
  namespaces,
  scanPart,
  type PartScan,
  type XmlVisitor,
} from "./xml.js";

export type AnchorKind = "oneCell" | "twoCell" | "absolute";

export interface AnchorCell {
  readonly column: number;
  readonly columnOffset: number;
  readonly row: number;
  readonly rowOffset: number;
}

/** Where a drawing object sits on its sheet. */
export interface AnchorPlacement {
  readonly anchor: AnchorKind;
  readonly from?: AnchorCell;
  readonly to?: AnchorCell;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly editAs?: string;
}

interface ImageContent {
  readonly mediaPart?: string;
  readonly hyperlink?: string;
  readonly tooltip?: string;
  readonly altText?: string;
  readonly decorative?: boolean;
}

export type OoxmlImage = ImageContent &
  (
    | AnchorPlacement
    | {
        readonly anchor: "inCell";
        readonly cell: string;
        readonly from?: never;
        readonly to?: never;
        readonly widthPx?: never;
        readonly heightPx?: never;
        readonly editAs?: never;
      }
  );

/**
 * The part a chart frame points at. `missing` is a frame whose relationship
 * names no part inside the package.
 */
export type ChartTarget =
  | { readonly kind: "chart"; readonly part: string }
  | { readonly kind: "chartEx"; readonly part: string }
  | { readonly kind: "missing"; readonly format: "chart" | "chartEx" };

export interface OoxmlChartFrame extends AnchorPlacement {
  readonly name?: string;
  readonly target: ChartTarget;
}

export interface SheetDrawing {
  readonly images: readonly OoxmlImage[];
  readonly charts: readonly OoxmlChartFrame[];
}

const noDrawing: SheetDrawing = { images: [], charts: [] };

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

interface FrameDraft {
  name?: string;
  format?: "chart" | "chartEx";
  relationshipId?: string;
}

interface ChartFrameDraft {
  readonly name: string | undefined;
  readonly format: "chart" | "chartEx";
  readonly relationshipId: string | undefined;
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
  altText?: string;
  decorative?: boolean;
  isPicture: boolean;
  frames: ChartFrameDraft[];
}

function emptyCell(): CellDraft {
  return { column: 0, columnOffset: 0, row: 0, rowOffset: 0 };
}

/**
 * Guard: a `Requires` namespace counts as understood only when this reader
 * reads it. Excel wraps a chartEx frame in a `Choice` whose `Fallback` is a
 * placeholder shape, and an ink drawing in one whose `Fallback` is its picture;
 * reading the chartEx `Choice` and the ink `Fallback` reports each object once,
 * as what it is.
 */
function readsNamespace(uri: string): boolean {
  const name = transitionalNamespace(uri);
  return (
    name === namespaces.spreadsheetDrawing ||
    name === namespaces.drawing ||
    name === namespaces.chart ||
    isChartExNamespace(name)
  );
}

export function drawingScan(
  opc: OpcPackage,
  sheetPart: string,
): PartScan<SheetDrawing> {
  let relationshipId: string | undefined;
  const visitor: XmlVisitor = {
    onOpen(node) {
      if (node.uri !== namespaces.spreadsheetml || node.local !== "drawing") {
        return;
      }
      relationshipId ??= node.attr("id", namespaces.officeRelationships);
    },
  };
  const finish = (): SheetDrawing => {
    if (relationshipId === undefined) return noDrawing;
    const relationship = opc.relationshipsFor(sheetPart).get(relationshipId);
    return relationship?.kind === "internal"
      ? readDrawing(opc, relationship.target)
      : noDrawing;
  };
  return { visitor, finish };
}

function placementOf(draft: AnchorDraft): AnchorPlacement {
  const width =
    draft.cx === undefined || !Number.isFinite(draft.cx)
      ? undefined
      : Math.round(draft.cx / emuPerPixel);
  const height =
    draft.cy === undefined || !Number.isFinite(draft.cy)
      ? undefined
      : Math.round(draft.cy / emuPerPixel);
  return {
    anchor: draft.kind,
    ...(draft.from === undefined ? {} : { from: draft.from }),
    ...(draft.to === undefined ? {} : { to: draft.to }),
    ...(width === undefined ? {} : { widthPx: width }),
    ...(height === undefined ? {} : { heightPx: height }),
    ...(draft.editAs === undefined ? {} : { editAs: draft.editAs }),
  };
}

/**
 * Every anchor kind carries a picture or a chart the same way, so the walk
 * collects one draft per anchor and keeps it if an `xdr:pic` or a chart frame
 * appeared inside it; shapes use the identical anchor elements. A group can
 * hold several frames, and each one is a chart at the group's anchor.
 *
 * The extent is matched as `(spreadsheetDrawing, ext)`. A picture also carries
 * `<a:ext>` inside `spPr/xfrm` and again inside `extLst`, both in the drawing
 * namespace and both meaning something else; matching the tag name alone would
 * silently read the wrong one.
 */
function readDrawing(opc: OpcPackage, drawingPart: string): SheetDrawing {
  const anchors: AnchorDraft[] = [];
  let anchor: AnchorDraft | undefined;
  let frame: FrameDraft | undefined;
  let target: "from" | "to" | undefined;
  let text: string | undefined;
  let field: string | undefined;

  const visitor: XmlVisitor = {
    onOpen(node) {
      if (node.uri === namespaces.spreadsheetDrawing) {
        const kind = anchorKinds[node.local];
        if (kind !== undefined) {
          anchor = {
            kind,
            editAs: node.attr("editAs"),
            isPicture: false,
            frames: [],
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
          case "graphicFrame":
            frame = {};
            break;
          case "cNvPr":
            if (frame !== undefined) frame.name ??= node.attr("name");
            else if (anchor.isPicture) anchor.altText ??= node.attr("descr");
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
      if (anchor === undefined) return;
      if (
        anchor.isPicture &&
        node.uri ===
          "http://schemas.microsoft.com/office/drawing/2017/decorative" &&
        node.local === "decorative"
      ) {
        const flag = node.attr("val");
        if (flag === "1" || flag === "true") anchor.decorative = true;
        else if (flag === "0" || flag === "false") anchor.decorative = false;
        return;
      }
      if (node.local === "chart" && frame !== undefined) {
        const format =
          node.uri === namespaces.chart
            ? "chart"
            : isChartExNamespace(node.uri)
              ? "chartEx"
              : undefined;
        if (format !== undefined && frame.format === undefined) {
          frame.format = format;
          frame.relationshipId = node.attr(
            "id",
            namespaces.officeRelationships,
          );
        }
        return;
      }
      if (node.uri !== namespaces.drawing) return;
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
      if (local === "graphicFrame") {
        if (frame?.format !== undefined) {
          anchor?.frames.push({
            name: frame.name,
            format: frame.format,
            relationshipId: frame.relationshipId,
          });
        }
        frame = undefined;
        return;
      }
      if (anchorKinds[local] !== undefined) {
        if (
          anchor !== undefined &&
          (anchor.isPicture || anchor.frames.length > 0)
        ) {
          anchors.push(anchor);
        }
        anchor = undefined;
      }
    },
  };
  const found = scanPart(
    opc,
    drawingPart,
    selectAlternateContent(visitor, readsNamespace),
  );
  if (!found) return noDrawing;

  const rels = opc.relationshipsFor(drawingPart);
  const images: OoxmlImage[] = [];
  const charts: OoxmlChartFrame[] = [];
  for (const draft of anchors) {
    const placement = placementOf(draft);
    if (draft.isPicture) {
      const media =
        draft.embedId === undefined ? undefined : rels.get(draft.embedId);
      const link =
        draft.hyperlinkId === undefined
          ? undefined
          : rels.get(draft.hyperlinkId);
      images.push({
        ...(media?.kind === "internal" ? { mediaPart: media.target } : {}),
        ...placement,
        ...(link === undefined ? {} : { hyperlink: link.target }),
        ...(draft.tooltip === undefined ? {} : { tooltip: draft.tooltip }),
        ...(draft.altText === undefined ? {} : { altText: draft.altText }),
        ...(draft.decorative === undefined
          ? {}
          : { decorative: draft.decorative }),
      });
    }
    for (const chartFrame of draft.frames) {
      const { format } = chartFrame;
      const relationship =
        chartFrame.relationshipId === undefined
          ? undefined
          : rels.get(chartFrame.relationshipId);
      charts.push({
        ...placement,
        ...(chartFrame.name === undefined ? {} : { name: chartFrame.name }),
        target:
          relationship?.kind === "internal"
            ? { kind: format, part: relationship.target }
            : { kind: "missing", format },
      });
    }
  }
  return { images, charts };
}
