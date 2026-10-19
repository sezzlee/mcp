import { cellStoreBuilder, type StoredCells } from "./cell-store.js";
import { cellScan } from "./cells.js";
import {
  conditionalFormatScan,
  type OoxmlConditionalBlock,
} from "./conditional-formats.js";
import { hyperlinkScan, type Hyperlink } from "./hyperlinks.js";
import {
  drawingScan,
  type OoxmlChartFrame,
  type OoxmlImage,
} from "./drawing.js";
import type { WorkbookPackage } from "./package.js";
import { paneScan, type OoxmlPanes } from "./panes.js";
import { layoutScan, type SheetLayout } from "./sheet-layout.js";
import { tableScan, type OoxmlTable } from "./tables.js";
import { validationScan, type OoxmlValidations } from "./validations.js";
import { fanOut, scanPart, type PartScan } from "./xml.js";
import { readRichData, type RichData } from "./rich-data.js";
import { richCellScan, type OoxmlArrayFormula } from "./rich-cells.js";

/** What a worksheet declares about itself, apart from its cells. */
export interface SheetFacts {
  readonly validations: OoxmlValidations;
  readonly tables: readonly OoxmlTable[];
  readonly conditionalFormats: readonly OoxmlConditionalBlock[];
  readonly images: readonly OoxmlImage[];
  readonly charts: readonly OoxmlChartFrame[];
  readonly panes: OoxmlPanes;
  readonly arrays: readonly OoxmlArrayFormula[];
}

export interface SheetContent {
  readonly cells: StoredCells;
  readonly links: readonly Hyperlink[];
  readonly layout: SheetLayout;
}

function factScan(
  opc: WorkbookPackage,
  part: string,
  rich: RichData,
): PartScan<SheetFacts> {
  const validations = validationScan(opc.date1904);
  const tables = tableScan(opc, part);
  const conditionalFormats = conditionalFormatScan();
  const drawing = drawingScan(opc, part);
  const panes = paneScan();
  const richCells = richCellScan(part, rich);
  return {
    visitor: fanOut([
      validations.visitor,
      tables.visitor,
      conditionalFormats.visitor,
      drawing.visitor,
      panes.visitor,
      richCells.visitor,
    ]),
    finish: () => {
      const drawingFacts = drawing.finish();
      const richFacts = richCells.finish();
      return {
        validations: validations.finish(),
        tables: tables.finish(),
        conditionalFormats: conditionalFormats.finish(),
        charts: drawingFacts.charts,
        images: [...drawingFacts.images, ...richFacts.images],
        arrays: richFacts.arrays,
        panes: panes.finish(),
      };
    },
  };
}

/** Reads a worksheet's facts in one pass that builds no cells. */
export function readSheetFacts(
  opc: WorkbookPackage,
  part: string,
  rich: RichData = readRichData(opc),
): SheetFacts {
  const facts = factScan(opc, part, rich);
  scanPart(opc, part, facts.visitor);
  return facts.finish();
}

/**
 * Reads a worksheet's cells, hyperlinks and layout in one pass, and its facts
 * in that same pass unless they are already `known`. The facts are finished
 * first, so a fault in a table or drawing part is reported ahead of the
 * hyperlink reader's, as it was when the facts were read on opening.
 */
export function readWorksheet(
  opc: WorkbookPackage,
  part: string,
  strings: readonly string[],
  known: SheetFacts | undefined,
  rich: RichData = readRichData(opc),
): { readonly content: SheetContent; readonly facts: SheetFacts } {
  const facts: PartScan<SheetFacts> =
    known === undefined
      ? factScan(opc, part, rich)
      : { visitor: {}, finish: () => known };
  const store = cellStoreBuilder();
  const cells = cellScan(part, strings, store.add);
  const links = hyperlinkScan(opc, part);
  const layout = layoutScan();
  scanPart(
    opc,
    part,
    fanOut([facts.visitor, cells.visitor, links.visitor, layout.visitor]),
  );
  const finished = facts.finish();
  return {
    content: {
      cells: (cells.finish(), store.finish()),
      links: links.finish(),
      layout: layout.finish(),
    },
    facts: finished,
  };
}
