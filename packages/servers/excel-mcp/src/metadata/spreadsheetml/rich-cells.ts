import type { CellArrayFormula } from "../../grid/cell-value.js";
import {
  formatCellRef,
  formatRange,
  type GridBounds,
} from "../../grid/range.js";
import { SezzleeExcelError } from "../../platform/errors.js";
import { positionOf, rowOf } from "./cells.js";
import type { OoxmlImage } from "./drawing.js";
import { corruptRich, metadataIndex, type RichData } from "./rich-data.js";
import { rangeOf } from "./sheet-layout.js";
import { namespaces, type PartScan } from "./xml.js";

export interface OoxmlArrayFormula extends CellArrayFormula, GridBounds {}

export interface RichCellFacts {
  readonly images: readonly OoxmlImage[];
  readonly arrays: readonly OoxmlArrayFormula[];
}

interface CellMetadata {
  readonly row: number;
  readonly column: number;
  readonly vm: number | undefined;
  readonly cm: number | undefined;
  ref?: string;
}

/**
 * Metadata-only worksheet visitor: tracks coordinates and vm/cm/array refs,
 * never reads cell text, shared strings, values or formula expressions.
 */
export function richCellScan(
  part: string,
  rich: RichData,
): PartScan<RichCellFacts> {
  const images = new Map<string, OoxmlImage>();
  const arrays = new Map<string, OoxmlArrayFormula>();
  let inSheetData = false;
  let row = 0;
  let column = 0;
  let cell: CellMetadata | undefined;
  return {
    visitor: {
      onOpen(node) {
        if (node.uri !== namespaces.spreadsheetml) return;
        if (node.local === "sheetData") inSheetData = true;
        else if (inSheetData && node.local === "row") {
          row = rowOf(node.attr("r"), row, part);
          column = 0;
        } else if (inSheetData && node.local === "c") {
          const reference = node.attr("r");
          const position =
            reference === undefined
              ? { row, column: column + 1 }
              : positionOf(reference, part);
          column = position.column;
          cell = {
            ...position,
            vm: metadataIndex(node.attr("vm"), part, "value metadata"),
            cm: metadataIndex(node.attr("cm"), part, "cell metadata"),
          };
        } else if (
          cell !== undefined &&
          node.local === "f" &&
          node.attr("t") === "array"
        ) {
          const ref = node.attr("ref");
          if (ref !== undefined) cell.ref = ref;
        }
      },
      onClose(local, uri) {
        if (uri !== namespaces.spreadsheetml) return;
        if (local === "sheetData") inSheetData = false;
        if (local !== "c" || cell === undefined) return;
        const at = formatCellRef(cell.row, cell.column);
        images.delete(at);
        arrays.delete(at);
        const value = rich.value(cell.vm);
        if (value?.kind === "image")
          images.set(at, {
            anchor: "inCell",
            cell: at,
            mediaPart: value.mediaPart,
            ...(value.altText === undefined ? {} : { altText: value.altText }),
            ...(value.decorative === undefined
              ? {}
              : { decorative: value.decorative }),
          });
        const dynamic = rich.dynamic(cell.cm);
        if (cell.ref !== undefined) {
          const bounds = rangeOf(cell.ref);
          if (
            bounds === undefined ||
            cell.row !== bounds.top ||
            cell.column !== bounds.left
          )
            throw corruptRich(
              part,
              "has an array range without its top-left anchor",
            );
          arrays.set(at, {
            ...bounds,
            anchor: at,
            ref: formatRange(bounds),
            dynamic: dynamic?.dynamic ?? false,
            ...(dynamic?.collapsed === undefined
              ? {}
              : { collapsed: dynamic.collapsed }),
          });
        }
        if (images.size + arrays.size > 100_000)
          throw new SezzleeExcelError(
            "file_too_large",
            "The worksheet exceeds the rich cell metadata budget.",
            "Split the workbook into smaller files.",
          );
        cell = undefined;
      },
    },
    finish: () => ({
      images: [...images.values()],
      arrays: [...arrays.values()],
    }),
  };
}
