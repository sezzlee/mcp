import {
  documentSheet,
  sheetSource,
  type LoadedDocument,
} from "../format/document.js";
import { selectSheetRange } from "../grid/select-sheet.js";
import {
  declaredHeaderRow,
  scanHeaderRow,
  type HeaderRowSource,
} from "../grid/header.js";
import { formatRange, resolveRange } from "../grid/range.js";
import { requireSheetBounds } from "../grid/sheet.js";

export function resolveHeaderRow(
  loaded: LoadedDocument,
  args: {
    readonly headerScan?: boolean;
    readonly headerRow?: number;
    readonly sheetName?: string;
    readonly range?: string;
    readonly table?: string;
    readonly mergedCells?: "master" | "repeat";
  },
): { headerRow: number; headerRowSource: HeaderRowSource } {
  if (args.table !== undefined) {
    const selected = selectSheetRange(sheetSource(loaded), args);
    return {
      headerRow: selected.tableHeaderRow ?? 0,
      headerRowSource: "declared",
    };
  }
  if (args.headerScan !== true) {
    return {
      headerRow: args.headerRow ?? 1,
      headerRowSource: args.headerRow === undefined ? "default" : "explicit",
    };
  }
  const sheet = documentSheet(loaded, args.sheetName);
  const bounds = resolveRange(requireSheetBounds(sheet), args.range);
  const declared = declaredHeaderRow(
    sheet,
    bounds,
    args.mergedCells ?? "master",
  );
  if (declared !== undefined) {
    return { headerRow: declared.row, headerRowSource: "declared" };
  }
  return {
    headerRow: scanHeaderRow(
      sheet,
      bounds,
      args.mergedCells ?? "master",
      `${sheet.name}!${formatRange(bounds)}`,
    ),
    headerRowSource: "scanned",
  };
}
