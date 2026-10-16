import { canonical } from "@sezzlee/file-core";
import { conditionalFormatRuleCountOf } from "../metadata/conditional-formats.js";
import type { MediaEntry } from "../metadata/images.js";
import type {
  DocumentMeta,
  SheetSummary,
  WorkbookDescription,
} from "../metadata/description.js";
import { readCells, type RawCell } from "../metadata/spreadsheetml/cells.js";
import {
  readConditionalFormats,
  type OoxmlConditionalBlock,
} from "../metadata/spreadsheetml/conditional-formats.js";
import {
  formulaSources,
  formulaText,
  type FormulaSource,
} from "../metadata/spreadsheetml/formula-text.js";
import {
  hyperlinkIndex,
  readHyperlinks,
  type HyperlinkIndex,
} from "../metadata/spreadsheetml/hyperlinks.js";
import {
  readFrozenPanes,
  readImages,
  type OoxmlImage,
  type OoxmlPanes,
} from "../metadata/spreadsheetml/images.js";
import {
  openPackage,
  type WorkbookPackage,
} from "../metadata/spreadsheetml/package.js";
import { zipSource } from "../metadata/spreadsheetml/reader.js";
import { readSharedStrings } from "../metadata/spreadsheetml/shared-strings.js";
import {
  declaredBounds,
  readSheetLayout,
} from "../metadata/spreadsheetml/sheet-layout.js";
import {
  readNumberFormats,
  type NumberFormats,
} from "../metadata/spreadsheetml/styles.js";
import {
  readTables,
  type OoxmlTable,
} from "../metadata/spreadsheetml/tables.js";
import {
  readValidations,
  type OoxmlValidations,
} from "../metadata/spreadsheetml/validations.js";
import { metadataLimitations } from "../metadata/support.js";
import type { CellSnapshot } from "../grid/cell-value.js";
import { formatCellRef, formatRange, type GridBounds } from "../grid/range.js";
import {
  presentIndices,
  type DeclaredTable,
  type Populated,
  type RowView,
  type SheetView,
} from "../grid/sheet.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import {
  coalesced,
  mergeIndex,
  type MergeIndex,
  type MergeRange,
} from "./merge-index.js";
import { anchorSnapshot, ooxmlSnapshot } from "./ooxml-cell.js";

/**
 * Guard: a hyperlink may be anchored on a range no cell is stored in, and
 * each such cell is given an empty slot carrying the link, as SheetJS does.
 * The slots are capped per sheet: an anchor such as `A1:XFD1048576` names 17
 * billion cells, and filling it would exhaust memory before the first answer.
 */
const maxAnchorSlots = 100_000;

/** A stored cell, or an empty slot a hyperlink is anchored on. */
type Slot = RawCell | { readonly anchor: string };

interface OoxmlSheet {
  readonly formulas: ReadonlyMap<RawCell, FormulaSource>;
  readonly links: HyperlinkIndex;
  readonly slots: readonly (readonly Slot[] | undefined)[];
  readonly bounds: GridBounds | undefined;
  readonly declared: GridBounds | undefined;
  readonly merges: readonly string[];
  readonly mergeIndex: MergeIndex;
  /** The row spans of merges whose top-left cell is stored, coalesced. */
  readonly mergedRows: readonly (readonly [number, number])[];
  readonly autoFilter: string | undefined;
  readonly formulaCellCount: number;
  readonly cachedFormulaValueCount: number;
}

export interface OoxmlWorkbook {
  readonly opc: WorkbookPackage;
  readonly sheetNames: readonly string[];
  readonly validations: ReadonlyMap<string, OoxmlValidations>;
  readonly tables: ReadonlyMap<string, readonly OoxmlTable[]>;
  readonly conditionalFormats: ReadonlyMap<
    string,
    readonly OoxmlConditionalBlock[]
  >;
  readonly images: ReadonlyMap<string, readonly OoxmlImage[]>;
  readonly panes: ReadonlyMap<string, OoxmlPanes>;
  readonly media: ReadonlyMap<string, MediaEntry>;
  readonly formats: NumberFormats;
  /** @returns the sheet's cells and layout, read on first use and kept. */
  sheet(name: string): OoxmlSheet;
}

function snapshotOf(
  loaded: OoxmlWorkbook,
  sheet: OoxmlSheet,
  slot: Slot,
  merged: boolean,
): CellSnapshot {
  if ("anchor" in slot) {
    return anchorSnapshot({ href: slot.anchor, merged });
  }
  const cell = slot;
  const source = sheet.formulas.get(cell);
  return ooxmlSnapshot({
    value: cell.value,
    formula: source === undefined ? undefined : formulaText(source, cell),
    numberFormat: loaded.formats.formatOf(cell.style),
    date1904: loaded.opc.date1904,
    href: sheet.links.at(cell.row, cell.column),
    merged,
  });
}

function placed(
  slots: (Slot[] | undefined)[],
  row: number,
  column: number,
  slot: Slot,
): void {
  const line = slots[row - 1] ?? [];
  slots[row - 1] = line;
  line[column - 1] = slot;
}

function grow(bounds: GridBounds | undefined, row: number, column: number) {
  return bounds === undefined
    ? { top: row, left: column, bottom: row, right: column }
    : {
        top: Math.min(bounds.top, row),
        left: Math.min(bounds.left, column),
        bottom: Math.max(bounds.bottom, row),
        right: Math.max(bounds.right, column),
      };
}

function readSheet(
  opc: WorkbookPackage,
  part: string,
  strings: readonly string[],
): OoxmlSheet {
  const cells = readCells(opc, part, strings);
  const sources = formulaSources(cells);
  const formulas = new Map<RawCell, FormulaSource>();
  const links = hyperlinkIndex(readHyperlinks(opc, part));
  const layout = readSheetLayout(opc, part);
  const slots: (Slot[] | undefined)[] = [];
  let bounds: GridBounds | undefined;
  let formulaCellCount = 0;
  let cachedFormulaValueCount = 0;
  cells.forEach((cell, index) => {
    placed(slots, cell.row, cell.column, cell);
    const source = sources.get(index);
    const formula = source !== undefined;
    if (formula) {
      formulas.set(cell, source);
      formulaCellCount += 1;
      if (cell.value.kind !== "none") cachedFormulaValueCount += 1;
    }
    if (formula || cell.value.kind !== "none") {
      bounds = grow(bounds, cell.row, cell.column);
    }
  });
  let anchors = 0;
  links.forEachCell((row, column, href) => {
    if (anchors >= maxAnchorSlots) return;
    if (slots[row - 1]?.[column - 1] !== undefined) return;
    placed(slots, row, column, { anchor: href });
    anchors += 1;
  });
  const merges: MergeRange[] = layout.merges.map((merge) => ({
    ...merge,
    ref: `${formatCellRef(merge.top, merge.left)}:${formatCellRef(merge.bottom, merge.right)}`,
  }));
  return {
    formulas,
    links,
    slots,
    bounds,
    declared: declaredBounds(layout, cells),
    merges: merges.map((merge) => merge.ref),
    mergeIndex: mergeIndex(part, merges),
    mergedRows: coalesced(
      merges
        .filter((merge) => slots[merge.top - 1]?.[merge.left - 1] !== undefined)
        .map((merge) => [merge.top, merge.bottom] as const),
    ),
    autoFilter: layout.autoFilter,
    formulaCellCount,
    cachedFormulaValueCount,
  };
}

/**
 * Opens an `.xlsx` or `.xlsm` package and reads its workbook part, styles and
 * shared strings; each sheet's cells are read the first time it is asked for.
 */
export function parseOoxml(bytes: Buffer, path: string): OoxmlWorkbook {
  const opc = openPackage(zipSource(bytes));
  if (opc.part("xl/workbook.xml") === undefined) {
    throw new SezzleeExcelError(
      "not_a_workbook",
      `'${path}' is a zip archive but carries no workbook part.`,
      "The file is probably not a spreadsheet; check what it really is before reading it.",
    );
  }
  const sheetNames = [...opc.sheetParts.keys()];
  if (sheetNames.length === 0) {
    throw new SezzleeExcelError(
      "not_a_workbook",
      `'${path}' is a zip archive but carries no worksheet.`,
      "The file is probably not a spreadsheet; check what it really is before reading it.",
    );
  }
  const validations = new Map<string, OoxmlValidations>();
  const tables = new Map<string, readonly OoxmlTable[]>();
  const conditionalFormats = new Map<
    string,
    readonly OoxmlConditionalBlock[]
  >();
  const images = new Map<string, readonly OoxmlImage[]>();
  const panes = new Map<string, OoxmlPanes>();
  const media = new Map<string, MediaEntry>();
  opc.mediaParts.forEach((part, index) => {
    const sizeBytes = opc.partSize(part);
    media.set(part, {
      id: index,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    });
  });
  for (const [name, sheetPart] of opc.sheetParts) {
    validations.set(name, readValidations(opc, sheetPart, opc.date1904));
    tables.set(name, readTables(opc, sheetPart));
    conditionalFormats.set(name, readConditionalFormats(opc, sheetPart));
    images.set(name, readImages(opc, sheetPart));
    panes.set(name, readFrozenPanes(opc, sheetPart));
  }
  const strings = readSharedStrings(opc);
  const sheets = new Map<string, OoxmlSheet>();
  const workbook: OoxmlWorkbook = {
    opc,
    sheetNames,
    validations,
    tables,
    conditionalFormats,
    images,
    panes,
    media,
    formats: readNumberFormats(opc),
    sheet(name) {
      const cached = sheets.get(name);
      if (cached !== undefined) return cached;
      const part = opc.sheetParts.get(name);
      if (part === undefined) {
        throw new SezzleeExcelError(
          "unknown_sheet",
          `The workbook has no sheet named '${name}'.`,
          `Available sheets: ${sheetNameSummary(workbook)}.`,
        );
      }
      const sheet = readSheet(opc, part, strings);
      sheets.set(name, sheet);
      return sheet;
    },
  };
  return workbook;
}

function stateOf(loaded: OoxmlWorkbook, name: string): string {
  return loaded.opc.sheetStates.get(name) ?? "visible";
}

export function sheetNameSummary(loaded: OoxmlWorkbook): string {
  return loaded.sheetNames
    .map((name) => {
      const state = stateOf(loaded, name);
      return state === "visible" ? name : `${name} (${state})`;
    })
    .join(", ");
}

export function selectSheetName(
  loaded: OoxmlWorkbook,
  sheetName: string | undefined,
): string {
  if (sheetName === undefined) {
    const visible = loaded.sheetNames.find(
      (name) => stateOf(loaded, name) === "visible",
    );
    const fallback = visible ?? loaded.sheetNames[0];
    if (fallback === undefined) {
      throw new SezzleeExcelError(
        "unknown_sheet",
        "The workbook has no worksheets.",
      );
    }
    return fallback;
  }
  const wanted = canonical(sheetName);
  const found = loaded.sheetNames.filter((name) => canonical(name) === wanted);
  if (found.length > 1) {
    throw new SezzleeExcelError(
      "ambiguous_sheet",
      `The workbook has ${found.length} sheets whose names normalise to '${sheetName}'.`,
      "Rename the sheets in the workbook; they cannot be addressed apart.",
    );
  }
  const only = found[0];
  if (only === undefined) {
    throw new SezzleeExcelError(
      "unknown_sheet",
      `The workbook has no sheet named '${sheetName}'.`,
      `Available sheets: ${sheetNameSummary(loaded)}.`,
    );
  }
  return only;
}

export function ooxmlSheetView(
  loaded: OoxmlWorkbook,
  sheetName: string | undefined,
  tables: readonly DeclaredTable[] = [],
): SheetView {
  const name = selectSheetName(loaded, sheetName);
  const sheet = loaded.sheet(name);
  const slotAt = (row: number, column: number): Slot | undefined =>
    sheet.slots[row - 1]?.[column - 1];
  /**
   * The spans are disjoint, so the walk visits each index of the span once
   * however many merges there are.
   */
  const repeated = (
    stored: Iterable<number>,
    ranges: readonly (readonly [number, number])[],
    { from, to }: Populated,
  ): Iterable<number> => {
    if (ranges.length === 0) return stored;
    const indices = new Set(stored);
    for (const [first, last] of ranges) {
      for (let at = Math.max(from, first); at <= Math.min(to, last); at += 1) {
        indices.add(at);
      }
    }
    return [...indices].sort((a, b) => a - b);
  };
  const withMaster = (merge: MergeRange): boolean =>
    slotAt(merge.top, merge.left) !== undefined;
  return {
    name,
    bounds: sheet.bounds,
    merges: sheet.merges,
    tables,
    autoFilter: sheet.autoFilter,
    rowAt(row): RowView | undefined {
      const covering = sheet.mergeIndex.covering(row);
      return {
        cellAt(column) {
          const merge = sheet.mergeIndex.at(covering, column);
          /**
           * Only the top-left cell of a merge is stored. Every other cell in
           * the range resolves to it, so the merge policy can repeat the
           * master value or blank the continuation.
           */
          if (merge !== undefined) {
            const master = slotAt(merge.top, merge.left);
            if (master === undefined) return undefined;
            const isMaster = merge.top === row && merge.left === column;
            return snapshotOf(loaded, sheet, master, !isMaster);
          }
          const slot = slotAt(row, column);
          return slot === undefined
            ? undefined
            : snapshotOf(loaded, sheet, slot, false);
        },
        populatedColumns(span) {
          const stored = presentIndices(
            sheet.slots[row - 1] ?? [],
            span.from,
            span.to,
          );
          return span.withCovered
            ? repeated(
                stored,
                covering
                  .filter(withMaster)
                  .map((merge) => [merge.left, merge.right] as const),
                span,
              )
            : stored;
        },
      };
    },
    populatedRows(span) {
      const stored = presentIndices(sheet.slots, span.from, span.to);
      return span.withCovered
        ? repeated(stored, sheet.mergedRows, span)
        : stored;
    },
  };
}

export interface DescribeOptions {
  readonly includeDefinedNames: boolean;
}

export function describeOoxml(
  loaded: OoxmlWorkbook,
  meta: DocumentMeta,
  options: DescribeOptions,
): WorkbookDescription {
  const sheets = loaded.sheetNames.map((name, ordinal): SheetSummary => {
    const sheet = loaded.sheet(name);
    const { bounds, declared } = sheet;
    return {
      name,
      index: ordinal + 1,
      state: stateOf(loaded, name),
      usedRange: bounds === undefined ? null : formatRange(bounds),
      rowCount: bounds === undefined ? 0 : bounds.bottom - bounds.top + 1,
      columnCount: bounds === undefined ? 0 : bounds.right - bounds.left + 1,
      declaredRowCount: declared?.bottom ?? 0,
      declaredColumnCount: declared?.right ?? 0,
      mergeCount: sheet.merges.length,
      dataValidationRuleCount: loaded.validations.get(name)?.rules.length ?? 0,
      dataValidationRuleCountExact: true,
      formulaCellCount: sheet.formulaCellCount,
      cachedFormulaValueCount: sheet.cachedFormulaValueCount,
      tableCount: loaded.tables.get(name)?.length ?? 0,
      conditionalFormatRuleCount: conditionalFormatRuleCountOf(
        loaded.conditionalFormats.get(name) ?? [],
      ),
      imageCount: loaded.images.get(name)?.length ?? 0,
      imageCountExact: false,
      autoFilterRef: sheet.autoFilter ?? null,
      frozenRowCount: loaded.panes.get(name)?.rows ?? 0,
      frozenColumnCount: loaded.panes.get(name)?.columns ?? 0,
    };
  });
  const tallest = sheets.reduce(
    (largest, sheet) => Math.max(largest, sheet.rowCount),
    0,
  );
  return {
    filePath: meta.filePath,
    sizeBytes: meta.sizeBytes,
    modifiedAt: meta.modifiedAt,
    dateSystem: loaded.opc.date1904 ? "1904" : "1900",
    sheets,
    limitations: options.includeDefinedNames
      ? [metadataLimitations.definedNames]
      : [],
    ...(options.includeDefinedNames
      ? {
          definedNames: loaded.opc.definedNames.map(({ name, ref }) => ({
            name,
            ranges: [ref],
          })),
          definedNamesComplete: false as const,
        }
      : {}),
    ...(tallest > limits.guidanceRowThreshold
      ? {
          guidance: `The largest sheet has ${tallest} rows. Use aggregate_sheet for totals and rankings, find_in_sheet to locate a value, or read_sheet with a narrow range.`,
        }
      : {}),
  };
}
