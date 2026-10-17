import { cellScan, type RawCell } from "./cells.js";
import {
  conditionalFormatScan,
  type OoxmlConditionalBlock,
} from "./conditional-formats.js";
import { hyperlinkScan, type Hyperlink } from "./hyperlinks.js";
import {
  imageScan,
  paneScan,
  type OoxmlImage,
  type OoxmlPanes,
} from "./images.js";
import type { WorkbookPackage } from "./package.js";
import { layoutScan, type SheetLayout } from "./sheet-layout.js";
import { tableScan, type OoxmlTable } from "./tables.js";
import { validationScan, type OoxmlValidations } from "./validations.js";
import { fanOut, scanPart } from "./xml.js";

/** What a worksheet declares about itself, apart from its cells. */
export interface SheetFacts {
  readonly validations: OoxmlValidations;
  readonly tables: readonly OoxmlTable[];
  readonly conditionalFormats: readonly OoxmlConditionalBlock[];
  readonly images: readonly OoxmlImage[];
  readonly panes: OoxmlPanes;
}

export interface SheetContent {
  readonly cells: readonly RawCell[];
  readonly links: readonly Hyperlink[];
  readonly layout: SheetLayout;
}

/**
 * Reads a worksheet's facts in one pass that builds no cells.
 *
 * Guard: each reader is finished in the order the readers once scanned the
 * part one by one, so a part with two faults reports the same one first.
 */
export function readSheetFacts(opc: WorkbookPackage, part: string): SheetFacts {
  const validations = validationScan(opc.date1904);
  const tables = tableScan(opc, part);
  const conditionalFormats = conditionalFormatScan();
  const images = imageScan(opc, part);
  const panes = paneScan();
  scanPart(
    opc,
    part,
    fanOut([
      validations.visitor,
      tables.visitor,
      conditionalFormats.visitor,
      images.visitor,
      panes.visitor,
    ]),
  );
  return {
    validations: validations.finish(),
    tables: tables.finish(),
    conditionalFormats: conditionalFormats.finish(),
    images: images.finish(),
    panes: panes.finish(),
  };
}

/**
 * Reads a worksheet's cells, hyperlinks and layout in one pass, finished in
 * the order the readers once scanned the part one by one.
 */
export function readSheetContent(
  opc: WorkbookPackage,
  part: string,
  strings: readonly string[],
): SheetContent {
  const cells = cellScan(part, strings);
  const links = hyperlinkScan(opc, part);
  const layout = layoutScan();
  scanPart(opc, part, fanOut([cells.visitor, links.visitor, layout.visitor]));
  return {
    cells: cells.finish(),
    links: links.finish(),
    layout: layout.finish(),
  };
}
