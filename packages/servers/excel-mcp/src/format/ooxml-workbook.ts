import { canonical } from "@sezzlee/file-core";
import { conditionalFormatRuleCountOf } from "../metadata/conditional-formats.js";
import type { MediaEntry } from "../metadata/images.js";
import type {
  DescribedName,
  DocumentMeta,
  SheetSummary,
  WorkbookDescription,
} from "../metadata/description.js";
import type { CellStore } from "../metadata/spreadsheetml/cell-store.js";
import { formulaText } from "../metadata/spreadsheetml/formula-text.js";
import {
  readRichData,
  type RichData,
} from "../metadata/spreadsheetml/rich-data.js";
import {
  hyperlinkIndex,
  type HyperlinkIndex,
} from "../metadata/spreadsheetml/hyperlinks.js";
import {
  openPackage,
  type DefinedName,
  type WorkbookPackage,
} from "../metadata/spreadsheetml/package.js";
import { plainAreaOf } from "../metadata/spreadsheetml/plain-area.js";
import { zipSource } from "../metadata/spreadsheetml/reader.js";
import { readSharedStrings } from "../metadata/spreadsheetml/shared-strings.js";
import { declaredBounds } from "../metadata/spreadsheetml/sheet-layout.js";
import {
  readNumberFormats,
  type NumberFormats,
} from "../metadata/spreadsheetml/styles.js";
import {
  readSheetFacts,
  readWorksheet,
  type SheetFacts,
} from "../metadata/spreadsheetml/worksheet.js";
import { declaredTablesOf } from "../metadata/tables.js";
import type {
  CellArrayFormula,
  CellFacts,
  CellSnapshot,
} from "../grid/cell-value.js";
import { defaultHeaderRow, previewHeader } from "../grid/header.js";
import { formatCellRef, formatRange, type GridBounds } from "../grid/range.js";
import {
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

/** A stored cell, or an empty cell a hyperlink is anchored on. */
type Slot =
  | {
      readonly kind: "cell";
      readonly index: number;
      readonly row: number;
      readonly column: number;
    }
  | { readonly kind: "anchor"; readonly href: string };

/** The empty cells a hyperlink is anchored on, each row's columns ascending. */
interface Anchors {
  readonly rows: readonly number[];
  readonly columns: ReadonlyMap<number, readonly number[]>;
  readonly hrefs: ReadonlyMap<number, ReadonlyMap<number, string>>;
}

interface OoxmlSheet {
  readonly cells: CellStore;
  readonly anchors: Anchors;
  readonly links: HyperlinkIndex;
  readonly bounds: GridBounds | undefined;
  readonly declared: GridBounds | undefined;
  readonly merges: readonly string[];
  readonly mergeIndex: MergeIndex;
  /** The row spans of merges whose top-left cell is stored, coalesced. */
  readonly mergedRows: readonly (readonly [number, number])[];
  readonly autoFilter: string | undefined;
  readonly hiddenRows: ReadonlySet<number>;
  readonly formulaCellCount: number;
  readonly cachedFormulaValueCount: number;
  readonly facts: SheetFacts;
  readonly arrayIndex: MergeIndex;
  readonly arrays: ReadonlyMap<string, CellArrayFormula>;
}

export interface OoxmlWorkbook {
  readonly opc: WorkbookPackage;
  readonly sheetNames: readonly string[];
  readonly media: ReadonlyMap<string, MediaEntry>;
  readonly formats: NumberFormats;
  readonly richData: RichData;
  /**
   * @returns the sheet's validations, tables, conditional formats, images and
   *   panes, read on first use and kept; a sheet already read has them.
   */
  facts(name: string): SheetFacts;
  /**
   * @returns the sheet's cells and layout with its facts, read in one pass on
   *   first use and kept.
   */
  sheet(name: string): OoxmlSheet;
}

function slotAt(
  { cells, anchors }: Pick<OoxmlSheet, "cells" | "anchors">,
  row: number,
  column: number,
): Slot | undefined {
  const index = cells.indexAt(row, column);
  if (index !== undefined) return { kind: "cell", index, row, column };
  const href = anchors.hrefs.get(row)?.get(column);
  return href === undefined ? undefined : { kind: "anchor", href };
}

function snapshotOf(
  loaded: OoxmlWorkbook,
  sheet: OoxmlSheet,
  slot: Slot,
  merged: boolean,
): CellSnapshot {
  if (slot.kind === "anchor") {
    return anchorSnapshot({ href: slot.href, merged });
  }
  const { cells } = sheet;
  const source = cells.formula(slot.index);
  const rich = loaded.richData.value(cells.valueMetadata(slot.index));
  let richFacts: CellFacts | undefined;
  if (rich?.kind === "image")
    richFacts = {
      value: {
        imageId: loaded.media.get(rich.mediaPart)?.id ?? -1,
        ...(rich.altText === undefined ? {} : { altText: rich.altText }),
        ...(rich.decorative === undefined
          ? {}
          : { decorative: rich.decorative }),
      },
    };
  else if (rich?.kind === "error") richFacts = { value: { error: rich.error } };
  else if (rich?.kind === "linked")
    richFacts = { value: { linkedValue: rich.value } };
  const covering = sheet.arrayIndex.at(
    sheet.arrayIndex.covering(slot.row),
    slot.column,
  );
  const array =
    covering === undefined ? undefined : sheet.arrays.get(covering.ref);
  const snapshot = ooxmlSnapshot({
    value: cells.value(slot.index),
    formula: source === undefined ? undefined : formulaText(source, slot),
    numberFormat: loaded.formats.formatOf(cells.style(slot.index)),
    date1904: loaded.opc.date1904,
    href: sheet.links.at(slot.row, slot.column),
    merged,
    richFacts,
  });
  return {
    ...snapshot,
    ...(array === undefined ? {} : { array }),
    ...(rich?.kind === "unsupported"
      ? { unsupportedRichValue: rich.type }
      : {}),
  };
}

function anchorsOf(links: HyperlinkIndex, cells: CellStore): Anchors {
  const hrefs = new Map<number, Map<number, string>>();
  let placed = 0;
  links.forEachCell((row, column, href) => {
    if (placed >= maxAnchorSlots) return;
    if (cells.indexAt(row, column) !== undefined) return;
    const line = hrefs.get(row) ?? new Map<number, string>();
    hrefs.set(row, line);
    line.set(column, href);
    placed += 1;
  });
  const ascending = (a: number, b: number) => a - b;
  return {
    rows: [...hrefs.keys()].sort(ascending),
    columns: new Map(
      [...hrefs].map(([row, line]) => [row, [...line.keys()].sort(ascending)]),
    ),
    hrefs,
  };
}

/**
 * @returns the indices of two ascending sequences, each once, ascending; the
 *   second is filtered to `[from, to]`.
 */
function* ascendingUnion(
  stored: Iterable<number>,
  anchored: readonly number[],
  from: number,
  to: number,
): Generator<number> {
  let at = 0;
  while (at < anchored.length && (anchored[at] ?? 0) < from) at += 1;
  for (const index of stored) {
    while (at < anchored.length && (anchored[at] ?? 0) < index) {
      yield anchored[at] ?? 0;
      at += 1;
    }
    if (anchored[at] === index) at += 1;
    yield index;
  }
  while (at < anchored.length && (anchored[at] ?? 0) <= to) {
    yield anchored[at] ?? 0;
    at += 1;
  }
}

function readSheet(
  opc: WorkbookPackage,
  part: string,
  strings: readonly string[],
  known: SheetFacts | undefined,
  richData: RichData,
): OoxmlSheet {
  const { content, facts } = readWorksheet(opc, part, strings, known, richData);
  const { cells, layout } = content;
  const links = hyperlinkIndex(content.links);
  const anchors = anchorsOf(links, cells.store);
  const merges: MergeRange[] = layout.merges.map((merge) => ({
    ...merge,
    ref: `${formatCellRef(merge.top, merge.left)}:${formatCellRef(merge.bottom, merge.right)}`,
  }));
  const stored = { cells: cells.store, anchors };
  return {
    ...stored,
    links,
    bounds: cells.bounds,
    declared: declaredBounds(layout, cells.stored),
    merges: merges.map((merge) => merge.ref),
    mergeIndex: mergeIndex(part, merges),
    mergedRows: coalesced(
      merges
        .filter((merge) => slotAt(stored, merge.top, merge.left) !== undefined)
        .map((merge) => [merge.top, merge.bottom] as const),
    ),
    autoFilter: layout.autoFilter,
    hiddenRows: layout.hiddenRows,
    formulaCellCount: cells.formulaCellCount,
    cachedFormulaValueCount: cells.cachedFormulaValueCount,
    facts,
    arrayIndex: mergeIndex(part, facts.arrays, "array formulas"),
    arrays: new Map(
      facts.arrays.map(({ anchor, ref, dynamic, collapsed }) => [
        ref,
        {
          anchor,
          ref,
          dynamic,
          ...(collapsed === undefined ? {} : { collapsed }),
        },
      ]),
    ),
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
  const richData = readRichData(opc);
  const media = new Map<string, MediaEntry>();
  for (const part of [...opc.mediaParts, ...richData.mediaParts]) {
    if (media.has(part)) continue;
    const sizeBytes = opc.partSize(part);
    media.set(part, {
      id: media.size,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    });
  }
  const strings = readSharedStrings(opc);
  const sheets = new Map<string, OoxmlSheet>();
  const facts = new Map<string, SheetFacts>();
  const partOf = (name: string): string => {
    const part = opc.sheetParts.get(name);
    if (part === undefined) {
      throw new SezzleeExcelError(
        "unknown_sheet",
        `The workbook has no sheet named '${name}'.`,
        `Available sheets: ${sheetNameSummary(workbook)}.`,
      );
    }
    return part;
  };
  const workbook: OoxmlWorkbook = {
    opc,
    sheetNames,
    media,
    formats: readNumberFormats(opc),
    richData,
    facts(name) {
      const known = facts.get(name) ?? sheets.get(name)?.facts;
      if (known !== undefined) return known;
      const read = readSheetFacts(opc, partOf(name), richData);
      facts.set(name, read);
      return read;
    },
    sheet(name) {
      const cached = sheets.get(name);
      if (cached !== undefined) return cached;
      const sheet = readSheet(
        opc,
        partOf(name),
        strings,
        facts.get(name),
        richData,
      );
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

export function assertWorksheet(loaded: OoxmlWorkbook, name: string): void {
  if (!loaded.opc.chartSheets.has(name)) return;
  throw new SezzleeExcelError(
    "chart_sheet",
    `Sheet '${name}' is a chart sheet; it holds a chart, not a cell grid.`,
    "Call get_charts to read the chart on this sheet, or describe_workbook to see which sheets carry cells.",
  );
}

/**
 * @param defaultTo which sheets a call without `sheetName` may land on: a
 *   chart sheet carries no cells, tables, validations or formats, so only a
 *   chart reader defaults to one.
 */
export function selectSheetName(
  loaded: OoxmlWorkbook,
  sheetName: string | undefined,
  defaultTo: "worksheet" | "any" = "worksheet",
): string {
  if (sheetName === undefined) {
    const candidates =
      defaultTo === "any"
        ? loaded.sheetNames
        : loaded.sheetNames.filter((name) => !loaded.opc.chartSheets.has(name));
    const visible = candidates.find(
      (name) => stateOf(loaded, name) === "visible",
    );
    const fallback = visible ?? candidates[0] ?? loaded.sheetNames[0];
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
    slotAt(sheet, merge.top, merge.left) !== undefined;
  return {
    name,
    bounds: sheet.bounds,
    merges: sheet.merges,
    tables,
    autoFilter: sheet.autoFilter,
    hiddenRows: sheet.hiddenRows,
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
            const master = slotAt(sheet, merge.top, merge.left);
            if (master === undefined) return undefined;
            const isMaster = merge.top === row && merge.left === column;
            return snapshotOf(loaded, sheet, master, !isMaster);
          }
          const slot = slotAt(sheet, row, column);
          return slot === undefined
            ? undefined
            : snapshotOf(loaded, sheet, slot, false);
        },
        populatedColumns(span) {
          const stored = ascendingUnion(
            sheet.cells.columns(row, span.from, span.to),
            sheet.anchors.columns.get(row) ?? [],
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
      const stored = ascendingUnion(
        sheet.cells.rows(span.from, span.to),
        sheet.anchors.rows,
        span.from,
        span.to,
      );
      return span.withCovered
        ? repeated(stored, sheet.mergedRows, span)
        : stored;
    },
  };
}

export interface DescribeOptions {
  readonly includeDefinedNames: boolean;
}

function describedName(
  entry: DefinedName,
  sheetNames: readonly string[],
): DescribedName {
  const scopeSheet =
    entry.localSheetId === undefined
      ? undefined
      : sheetNames[entry.localSheetId];
  const area = plainAreaOf(entry.ref);
  const sheetName =
    entry.localSheetId === undefined ? area?.sheetName : scopeSheet;
  const range =
    area !== undefined &&
    sheetName !== undefined &&
    canonical(area.sheetName) === canonical(sheetName)
      ? area.range
      : undefined;
  return {
    name: entry.name,
    ranges: [entry.ref],
    scope: entry.localSheetId === undefined ? "workbook" : "sheet",
    ...(sheetName === undefined ? {} : { sheetName }),
    ...(range === undefined ? {} : { range }),
  };
}

export function describeOoxml(
  loaded: OoxmlWorkbook,
  meta: DocumentMeta,
  options: DescribeOptions,
): WorkbookDescription {
  const sheets = loaded.sheetNames.map((name, ordinal): SheetSummary => {
    if (loaded.opc.chartSheets.has(name)) {
      const facts = loaded.facts(name);
      return {
        name,
        index: ordinal + 1,
        state: stateOf(loaded, name),
        kind: "chartsheet",
        usedRange: null,
        rowCount: 0,
        columnCount: 0,
        declaredRowCount: 0,
        declaredColumnCount: 0,
        mergeCount: 0,
        dataValidationRuleCount: 0,
        dataValidationRuleCountExact: true,
        formulaCellCount: 0,
        cachedFormulaValueCount: 0,
        tableCount: 0,
        conditionalFormatRuleCount: 0,
        imageCount: facts.images.length,
        imageCountExact: false,
        chartCount: facts.charts.length,
        autoFilterRef: null,
        frozenRowCount: 0,
        frozenColumnCount: 0,
        header: null,
      };
    }
    const sheet = loaded.sheet(name);
    const view = ooxmlSheetView(
      loaded,
      name,
      declaredTablesOf(sheet.facts.tables),
    );
    const { bounds, declared } = sheet;
    return {
      name,
      index: ordinal + 1,
      state: stateOf(loaded, name),
      kind: "worksheet",
      usedRange: bounds === undefined ? null : formatRange(bounds),
      rowCount: bounds === undefined ? 0 : bounds.bottom - bounds.top + 1,
      columnCount: bounds === undefined ? 0 : bounds.right - bounds.left + 1,
      declaredRowCount: declared?.bottom ?? 0,
      declaredColumnCount: declared?.right ?? 0,
      mergeCount: sheet.merges.length,
      dataValidationRuleCount: sheet.facts.validations.rules.length,
      dataValidationRuleCountExact: true,
      formulaCellCount: sheet.formulaCellCount,
      cachedFormulaValueCount: sheet.cachedFormulaValueCount,
      tableCount: sheet.facts.tables.length,
      conditionalFormatRuleCount: conditionalFormatRuleCountOf(
        sheet.facts.conditionalFormats,
      ),
      imageCount: sheet.facts.images.length,
      imageCountExact: false,
      chartCount: sheet.facts.charts.length,
      autoFilterRef: sheet.autoFilter ?? null,
      frozenRowCount: sheet.facts.panes.rows,
      frozenColumnCount: sheet.facts.panes.columns,
      header:
        view.bounds === undefined
          ? null
          : previewHeader(view, defaultHeaderRow(view, view.bounds, "master")),
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
    limitations: [],
    ...(options.includeDefinedNames
      ? {
          definedNames: loaded.opc.definedNames.map((entry) =>
            describedName(entry, loaded.sheetNames),
          ),
        }
      : {}),
    ...(tallest > limits.guidanceRowThreshold
      ? {
          guidance: `The largest sheet has ${tallest} rows. Use aggregate_sheet for totals and rankings, find_in_sheet to locate a value, or read_sheet with a narrow range.`,
        }
      : {}),
  };
}
