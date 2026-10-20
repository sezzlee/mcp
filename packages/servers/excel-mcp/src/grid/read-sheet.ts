import type { ColumnSpec, ReadingHints } from "./column-spec.js";
import { readingHintsOf } from "./column-spec.js";
import { buildColumnIndex, type ColumnMode } from "./columns.js";
import {
  explicitPlans,
  observeTyped,
  typedValueOf,
  typedReports,
  recordTyped,
  reportTyped,
  reserveTyped,
  type TypedObservation,
  type TypedReport,
} from "./column-plans.js";
import {
  canonical,
  createPageBudget,
  fold,
  measureJson,
} from "@sezzlee/file-core";
import {
  normalizeCell,
  presentScalar,
  scalarText,
  resolveCell,
  type CellNote,
  type CellScalar,
  type NormalizeOptions,
} from "./cell-value.js";
import {
  assertFresh,
  decodeCursor,
  encodeCursor,
  type MergePolicy,
  type ValueMode,
} from "./cursor.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { headerWarnings, type HeaderRowSource } from "./header.js";
import { warning, type Warning } from "./warnings.js";
import {
  selectSheetRange,
  selectionHeaders,
  visibilityOf,
  visibleRows,
  type SelectionOptions,
  type SheetSelection,
  type TableSelection,
  type VisibilityReport,
} from "./select-sheet.js";
import { limits } from "../platform/limits.js";
import { withRegex } from "../platform/regex.js";
import { inheritCursorOptions, type CursorOptions } from "./cursor.js";
import {
  columnToLetters,
  formatCellRef,
  formatRange,
  parseCellRef,
  type GridBounds,
} from "./range.js";
import type { SheetSource } from "./sheet.js";

export interface ColumnInfo {
  readonly letter: string;
  readonly index: number;
  readonly header: string | null;
  readonly numberFormat: string | null;
}

export interface ReadSheetOptions extends ReadingHints, SelectionOptions {
  readonly columns?: readonly ColumnSpec[];
  readonly columnMode?: ColumnMode;
  readonly includeTyped?: boolean;
  readonly sheetName?: string;
  readonly range?: string;
  readonly cursor?: string;
  readonly maxCells: number;
  readonly valueMode?: ValueMode;
  readonly mergedCells?: MergePolicy;
  readonly headerRow?: number;
  readonly headerRowSource: HeaderRowSource;
  readonly includeHyperlinks?: boolean;
  readonly extraEnvelopeBytes?: number;
  readonly headerScan?: boolean;
  readonly delimiter?: CursorOptions["delimiter"];
  readonly encoding?: CursorOptions["encoding"];
}

export interface ReadSheetResult {
  readonly sheet: string;
  readonly range: string;
  readonly usedRange: string;
  readonly headerRow: number;
  readonly headerRowSource: HeaderRowSource;
  readonly columns: readonly ColumnInfo[];
  readonly values: readonly (readonly CellScalar[])[];
  /** The sheet row of each entry in `values`, so no row is found by counting. */
  readonly rowNumbers: readonly number[];
  readonly table?: TableSelection;
  readonly visibility?: VisibilityReport;
  readonly typedValues?: readonly (readonly CellScalar[])[];
  readonly typed?: {
    readonly scope: "returnedRows";
    readonly columns: readonly TypedReport[];
  };
  readonly cellNotes?: Readonly<Record<string, CellNote>>;
  readonly merges?: readonly string[];
  readonly returnedRows: number;
  readonly returnedCells: number;
  readonly truncated: boolean;
  readonly truncationReason?: "maxCells" | "maxPayloadBytes";
  readonly nextCursor?: string;
  readonly hint?: string;
  readonly warnings?: readonly Warning[];
}

interface Window extends SheetSelection {
  readonly startRow: number;
  readonly valueMode: ValueMode;
  readonly mergedCells: MergePolicy;
  readonly headerRow: number;
  readonly headerRowSource: HeaderRowSource;
}

function resolveWindow(
  source: SheetSource,
  options: ReadSheetOptions &
    Required<Pick<ReadSheetOptions, "valueMode" | "mergedCells" | "headerRow">>,
): Window {
  if (options.cursor === undefined) {
    const selected = selectSheetRange(source, options);
    const { bounds } = selected;
    const headerRow = options.headerRow;
    const startRow =
      headerRow >= bounds.top && headerRow <= bounds.bottom
        ? Math.max(bounds.top, headerRow + 1)
        : bounds.top;
    return {
      ...selected,
      startRow,
      valueMode: options.valueMode,
      mergedCells: options.mergedCells,
      headerRow,
      headerRowSource: options.headerRowSource,
    };
  }
  if (options.sheetName !== undefined || options.range !== undefined) {
    throw new SezzleeExcelError(
      "invalid_argument",
      "cursor cannot be combined with sheetName or range.",
      "Pass only the cursor to continue, or drop the cursor to start a new read.",
    );
  }
  const cursor = decodeCursor(options.cursor);
  assertFresh(cursor, source.stamp);
  const selected = selectSheetRange(source, {
    sheetName: cursor.s,
    ...(cursor.o.table === undefined
      ? {}
      : { table: cursor.o.table, headerRow: cursor.h }),
  });
  const end = parseCellRef(cursor.e);
  const bounds: GridBounds = {
    top: cursor.r,
    left: cursor.c,
    bottom: end.row,
    right: end.column,
  };
  if (bounds.bottom < bounds.top || bounds.right < bounds.left) {
    throw new SezzleeExcelError(
      "invalid_cursor",
      "The cursor points past the end of the range.",
    );
  }
  if (
    selected.table !== undefined &&
    (bounds.left !== selected.bounds.left ||
      bounds.right !== selected.bounds.right ||
      bounds.bottom !== selected.bounds.bottom ||
      bounds.top < selected.bounds.top)
  )
    throw new SezzleeExcelError(
      "invalid_cursor",
      "The cursor range conflicts with its table data range.",
      "Start a new read with table.",
    );
  return {
    ...selected,
    bounds,
    startRow: cursor.r,
    valueMode: cursor.m,
    mergedCells: cursor.g,
    headerRow: cursor.h,
    headerRowSource: "cursor",
  };
}

function overlaps(merge: string, bounds: GridBounds): boolean {
  const [start, end] = merge.split(":");
  if (start === undefined || end === undefined) {
    return false;
  }
  const topLeft = parseCellRef(start);
  const bottomRight = parseCellRef(end);
  return (
    topLeft.row <= bounds.bottom &&
    bottomRight.row >= bounds.top &&
    topLeft.column <= bounds.right &&
    bottomRight.column >= bounds.left
  );
}

function uncachedFormulaWarning(count: number): Warning {
  return warning(
    "uncached_formulas",
    `${count} formula cells have no cached value; this workbook has not been recalculated by Excel.`,
  );
}

export function readSheet(
  source: SheetSource,
  input: ReadSheetOptions,
): ReadSheetResult {
  const inherited = inheritCursorOptions(input);
  const options = {
    ...inherited,
    valueMode: inherited.valueMode ?? "values",
    mergedCells: inherited.mergedCells ?? "master",
    headerRow: inherited.headerRow ?? 1,
    headerScan: inherited.headerScan ?? false,
    includeHyperlinks: inherited.includeHyperlinks ?? false,
  };
  const window = resolveWindow(source, options);
  const normalizeOptions: NormalizeOptions = {
    valueMode: window.valueMode,
    mergePolicy: window.mergedCells,
    includeHyperlinks: options.includeHyperlinks,
  };
  const width = window.bounds.right - window.bounds.left + 1;
  const headers = selectionHeaders(window, window.headerRow, normalizeOptions);
  const plans = explicitPlans(
    buildColumnIndex(
      window.sheet.name,
      window.bounds,
      window.headerRow,
      headers,
    ),
    options.columns,
    options.columnMode ?? "auto",
    options,
  );
  if (options.includeTyped === true && plans.size === 0)
    throw new SezzleeExcelError(
      "invalid_argument",
      "includeTyped requires explicit columns.",
      "Use profile_sheet to obtain reusable columns, then pass them to read_sheet.",
    );
  const reports = typedReports(plans);
  const typedValues: CellScalar[][] = [];
  const numberFormats: (string | null)[] = new Array(width).fill(null);
  const values: CellScalar[][] = [];
  const rowNumbers: number[] = [];
  const cellNotes: Record<string, CellNote> = {};

  let returnedCells = 0;
  let uncachedFormulas = 0;
  let truncationReason: "maxCells" | "maxPayloadBytes" | undefined;
  let nextRow = window.startRow;

  const merges = window.sheet.merges.filter((merge) =>
    overlaps(merge, window.bounds),
  );
  const headerNotices =
    options.cursor === undefined
      ? headerWarnings(
          window.sheet,
          window.bounds,
          window.headerRow,
          headers,
          options.range !== undefined || window.table !== undefined,
          window.mergedCells,
        )
      : [];
  const columnsFrom = (formats: readonly (string | null)[]): ColumnInfo[] => {
    const built: ColumnInfo[] = [];
    for (let offset = 0; offset < width; offset += 1) {
      const index = window.bounds.left + offset;
      built.push({
        letter: columnToLetters(index),
        index,
        header: headers[offset] ?? null,
        numberFormat: formats[offset] ?? null,
      });
    }
    return built;
  };
  const encodedCursor = (row: number): string =>
    encodeCursor({
      v: 2,
      f: source.stamp,
      s: window.sheet.name,
      r: row,
      c: window.bounds.left,
      e: formatCellRef(window.bounds.bottom, window.bounds.right),
      m: window.valueMode,
      g: window.mergedCells,
      h: window.headerRow,
      o: {
        ...readingHintsOf(options),
        ...(options.columns === undefined ? {} : { columns: options.columns }),
        ...(options.columnMode === undefined
          ? {}
          : { columnMode: options.columnMode }),
        ...(options.includeTyped === undefined
          ? {}
          : { includeTyped: options.includeTyped }),
        ...(options.table === undefined ? {} : { table: options.table }),
        ...(options.visibleOnly === undefined
          ? {}
          : { visibleOnly: options.visibleOnly }),
        valueMode: window.valueMode,
        mergedCells: window.mergedCells,
        headerRow: window.headerRow,
        headerScan: options.headerScan,
        includeHyperlinks: options.includeHyperlinks,
        ...(options.delimiter === undefined
          ? {}
          : { delimiter: options.delimiter }),
        ...(options.encoding === undefined
          ? {}
          : { encoding: options.encoding }),
      },
    });
  const cursorAt = (row: number): string => {
    const token = encodedCursor(row);
    if (token.length > limits.maxCursorChars)
      throw new SezzleeExcelError(
        "resource_limit",
        "The column interpretation exceeds the cursor budget.",
        "Use fewer column specifications or shorter literal token lists.",
      );
    return token;
  };
  const hintFor = (rows: number): string =>
    `${rows} rows remain. Prefer aggregate_sheet for totals, find_in_sheet to locate a value, or a narrower range over paging.`;

  const rowLimit = Math.min(
    window.bounds.bottom - window.startRow + 1,
    Math.max(1, Math.floor(options.maxCells / width)),
  );
  const parallelSeparators =
    Math.max(0, rowLimit - 1) * (1 + Number(options.includeTyped === true));
  const reserveBytes =
    measureJson({
      sheet: window.sheet.name,
      range: formatRange({ ...window.bounds, top: window.startRow }),
      usedRange: formatRange(window.used),
      headerRow: window.headerRow,
      headerRowSource: window.headerRowSource,
      columns: columnsFrom(new Array<string | null>(width).fill(null)),
      values: [],
      rowNumbers: [],
      ...(window.table === undefined ? {} : { table: window.table }),
      ...(options.visibleOnly === true
        ? {
            visibility: visibilityOf(
              window,
              window.startRow,
              window.bounds.bottom,
            ),
          }
        : {}),
      ...(options.includeTyped === true
        ? {
            typedValues: [],
            typed: {
              scope: "returnedRows",
              columns: reserveTyped(reports, options.maxCells),
            },
          }
        : {}),
      cellNotes: {},
      merges,
      returnedRows: options.maxCells,
      returnedCells: options.maxCells,
      truncated: true,
      truncationReason: "maxPayloadBytes",
      nextCursor: encodedCursor(window.bounds.bottom + 1).slice(
        0,
        limits.maxCursorChars,
      ),
      hint: hintFor(Math.max(0, window.bounds.bottom - window.startRow + 1)),
      warnings: [...headerNotices, uncachedFormulaWarning(options.maxCells)],
    }) +
    (options.extraEnvelopeBytes ?? 0) +
    parallelSeparators;
  const budget = createPageBudget({
    maxBytes: limits.maxPayloadBytes,
    reserveBytes,
  });

  for (
    let rowNumber = window.startRow;
    rowNumber <= window.bounds.bottom;
    rowNumber += 1
  ) {
    if (
      options.visibleOnly === true &&
      window.sheet.hiddenRows.has(rowNumber)
    ) {
      nextRow = rowNumber + 1;
      continue;
    }
    if (values.length > 0 && returnedCells + width > options.maxCells) {
      truncationReason = "maxCells";
      break;
    }
    const row = window.sheet.rowAt(rowNumber);
    const line: CellScalar[] = [];
    const typedLine: CellScalar[] = [];
    const observations: {
      readonly column: number;
      readonly raw: CellScalar;
      readonly observation: TypedObservation;
    }[] = [];
    const rowNotes: Record<string, CellNote> = {};
    const discovered: { readonly offset: number; readonly format: string }[] =
      [];
    for (
      let column = window.bounds.left;
      column <= window.bounds.right;
      column += 1
    ) {
      const snapshot = row?.cellAt(column);
      if (options.includeTyped === true) {
        const raw =
          snapshot === undefined
            ? null
            : resolveCell(snapshot, normalizeOptions);
        const plan = plans.get(column);
        if (plan === undefined)
          typedLine.push(
            snapshot === undefined
              ? null
              : normalizeCell(snapshot, normalizeOptions).value,
          );
        else {
          const observation = observeTyped(raw, plan);
          typedLine.push(presentScalar(typedValueOf(observation)));
          observations.push({ column, raw, observation });
        }
      }
      if (snapshot === undefined) {
        line.push(null);
        continue;
      }
      const offset = column - window.bounds.left;
      if (
        numberFormats[offset] === null &&
        typeof snapshot.numberFormat === "string"
      ) {
        discovered.push({ offset, format: snapshot.numberFormat });
      }
      const normalized = normalizeCell(snapshot, normalizeOptions);
      line.push(normalized.value);
      if (normalized.note !== undefined) {
        rowNotes[formatCellRef(rowNumber, column)] = normalized.note;
      }
    }
    const notes = Object.keys(rowNotes).length > 0 ? [rowNotes] : [];
    const formats = discovered.map((found) => found.format);
    if (
      !budget.admit(
        line,
        rowNumber,
        ...(options.includeTyped === true ? [typedLine] : []),
        ...notes,
        ...formats,
      )
    ) {
      truncationReason = "maxPayloadBytes";
      break;
    }
    for (const found of discovered) {
      numberFormats[found.offset] = found.format;
    }
    for (const [reference, note] of Object.entries(rowNotes)) {
      cellNotes[reference] = note;
      if (note.kind === "formula" && !note.cached) {
        uncachedFormulas += 1;
      }
    }
    values.push(line);
    rowNumbers.push(rowNumber);
    if (options.includeTyped === true) {
      typedValues.push(typedLine);
      for (const item of observations)
        recordTyped(
          reports.get(item.column),
          item.observation,
          formatCellRef(rowNumber, item.column),
          item.raw,
        );
    }
    returnedCells += width;
    nextRow = rowNumber + 1;
  }

  if (budget.refused && budget.admitted === 0) {
    throw new SezzleeExcelError(
      "resource_limit",
      `The first row of the requested range does not fit in the ${limits.maxPayloadBytes} byte response budget.`,
      "Read a narrower range with the range argument, or use aggregate_sheet for totals.",
    );
  }

  const columns = columnsFrom(numberFormats);
  const truncated = truncationReason !== undefined;
  const remaining = window.bounds.bottom - nextRow + 1;

  const headerOnly = window.startRow > window.bounds.bottom;
  const warnings: Warning[] = [];
  if (uncachedFormulas > 0) {
    warnings.push(uncachedFormulaWarning(uncachedFormulas));
  }
  if (headerOnly)
    warnings.push(
      warning(
        "header_only_range",
        `The requested rows hold only header row ${window.headerRow}; its texts are in columns[].header and no data row was read.`,
      ),
    );
  warnings.push(...headerNotices);

  return {
    sheet: window.sheet.name,
    range: formatRange(
      headerOnly
        ? window.bounds
        : {
            top: window.startRow,
            left: window.bounds.left,
            bottom: Math.max(window.startRow, nextRow - 1),
            right: window.bounds.right,
          },
    ),
    usedRange: formatRange(window.used),
    headerRow: window.headerRow,
    headerRowSource: window.headerRowSource,
    columns,
    values,
    rowNumbers,
    ...(window.table === undefined ? {} : { table: window.table }),
    ...(options.visibleOnly === true
      ? {
          visibility: visibilityOf(window, window.startRow, nextRow - 1),
        }
      : {}),
    ...(options.includeTyped === true
      ? {
          typedValues,
          typed: {
            scope: "returnedRows" as const,
            columns: reportTyped(reports),
          },
        }
      : {}),
    ...(Object.keys(cellNotes).length > 0 ? { cellNotes } : {}),
    ...(merges.length > 0 ? { merges } : {}),
    returnedRows: values.length,
    returnedCells,
    truncated,
    ...(truncationReason === undefined ? {} : { truncationReason }),
    ...(truncated
      ? { nextCursor: cursorAt(nextRow), hint: hintFor(remaining) }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export interface FindOptions extends ReadingHints, SelectionOptions {
  readonly extraEnvelopeBytes?: number;
  readonly columns?: readonly ColumnSpec[];
  readonly columnMode?: ColumnMode;
  readonly headerRow?: number;
  readonly headerRowSource?: HeaderRowSource;
  readonly signal?: AbortSignal;
  readonly query: string;
  readonly sheetName?: string;
  readonly matchMode: "contains" | "exact" | "regex";
  readonly caseSensitive: boolean;
  readonly searchIn: "values" | "formulas" | "both";
  readonly range?: string;
  readonly maxResults: number;
}

export interface FindMatch {
  readonly address: string;
  readonly row: number;
  readonly column: number;
  readonly value: CellScalar;
  readonly typedValue?: CellScalar;
}

export interface FindResult {
  readonly sheet: string;
  readonly range: string;
  readonly total: number;
  readonly truncated: boolean;
  readonly scannedCells: number;
  readonly matching: Matching;
  readonly matches: readonly FindMatch[];
  readonly table?: TableSelection;
  readonly visibility?: VisibilityReport;
  readonly truncationReason?: "maxPayloadBytes";
  readonly typed?: {
    readonly scope: "scannedCells";
    readonly columns: readonly TypedReport[];
  };
}

export type Matching = "exact" | "canonical" | "folded" | "regex";

interface Matcher {
  readonly matching: Matching;
  readonly test: (text: string) => boolean;
}

function createMatcher(options: FindOptions): Matcher {
  if (options.matchMode === "regex") {
    throw new SezzleeExcelError(
      "internal_error",
      "Regex evaluation requires an isolated worker.",
    );
  }
  const prepare = options.caseSensitive ? canonical : fold;
  const matching: Matching = options.caseSensitive ? "canonical" : "folded";
  const needle = prepare(options.query);
  if (options.matchMode === "exact") {
    return { matching, test: (text) => prepare(text) === needle };
  }
  return { matching, test: (text) => prepare(text).includes(needle) };
}

export async function findInSheet(
  source: SheetSource,
  options: FindOptions,
): Promise<FindResult> {
  if (options.matchMode === "regex")
    return withRegex(
      options.query,
      options.caseSensitive,
      (test) => findWithMatcher(source, options, test),
      options.signal,
    );
  return findWithMatcher(source, options);
}

async function findWithMatcher(
  source: SheetSource,
  options: FindOptions,
  regexTest?: (texts: readonly string[]) => Promise<readonly boolean[]>,
): Promise<FindResult> {
  const selected = selectSheetRange(source, options);
  const { sheet, bounds } = selected;
  const visibility =
    options.visibleOnly === true
      ? visibilityOf(selected, bounds.top, bounds.bottom)
      : undefined;
  const matcher = regexTest === undefined ? createMatcher(options) : undefined;
  const normalizeOptions: NormalizeOptions = {
    valueMode: "values",
    mergePolicy: "master",
    includeHyperlinks: false,
  };
  const headers = selectionHeaders(
    selected,
    options.headerRow ?? 1,
    normalizeOptions,
  );
  const plans = explicitPlans(
    buildColumnIndex(sheet.name, bounds, options.headerRow ?? 1, headers),
    options.columns,
    options.columnMode ?? "auto",
    options,
  );
  const reports = typedReports(plans);
  const budget = createPageBudget({
    maxBytes: limits.maxPayloadBytes,
    reserveBytes:
      measureJson({
        sheet: sheet.name,
        range: formatRange(bounds),
        total: 17_179_869_184,
        scannedCells: 17_179_869_184,
        truncated: true,
        matching: "canonical",
        matches: [],
        ...(selected.table === undefined ? {} : { table: selected.table }),
        ...(visibility === undefined ? {} : { visibility }),
        ...(plans.size === 0 || options.searchIn === "formulas"
          ? {}
          : {
              typed: {
                scope: "scannedCells",
                columns: reserveTyped(reports, 17_179_869_184),
              },
            }),
      }) + (options.extraEnvelopeBytes ?? 0),
  });
  const found: FindMatch[] = [];
  const admitMatch = (match: FindMatch): void => {
    if (found.length < options.maxResults && budget.admit(match))
      found.push(match);
  };
  let total = 0;
  let scannedCells = 0;
  let batch: {
    readonly match: FindMatch;
    readonly texts: readonly string[];
  }[] = [];
  let batchBytes = 2;
  const flush = async (): Promise<void> => {
    if (regexTest === undefined || batch.length === 0) return;
    const hits = await regexTest(batch.flatMap((entry) => entry.texts));
    let offset = 0;
    for (const entry of batch) {
      const matched = hits
        .slice(offset, offset + entry.texts.length)
        .some(Boolean);
      offset += entry.texts.length;
      if (matched) {
        total += 1;
        admitMatch(entry.match);
      }
    }
    batch = [];
    batchBytes = 2;
  };

  const withCovered =
    normalizeOptions.mergePolicy === "repeat" || options.searchIn !== "values";
  let visitedRows = 0;
  for (const rowNumber of visibleRows(
    sheet.populatedRows({
      from: bounds.top,
      to: bounds.bottom,
      withCovered,
    }),
    sheet,
    options.visibleOnly === true,
  )) {
    if (regexTest !== undefined && visitedRows % 128 === 0) await regexTest([]);
    visitedRows += 1;
    const row = sheet.rowAt(rowNumber);
    if (row === undefined) {
      continue;
    }
    for (const column of row.populatedColumns({
      from: bounds.left,
      to: bounds.right,
      withCovered,
    })) {
      const snapshot = row.cellAt(column);
      if (snapshot === undefined) {
        continue;
      }
      scannedCells += 1;
      const haystacks: string[] = [];
      const plan =
        rowNumber === (options.headerRow ?? 1) ? undefined : plans.get(column);
      const raw = resolveCell(snapshot, normalizeOptions);
      const observation =
        plan === undefined || options.searchIn === "formulas"
          ? undefined
          : observeTyped(raw, plan);
      if (observation !== undefined)
        recordTyped(
          reports.get(column),
          observation,
          formatCellRef(rowNumber, column),
          raw,
        );
      if (options.searchIn !== "formulas")
        haystacks.push(
          renderScalar(
            observation === undefined ? raw : typedValueOf(observation),
          ),
        );
      const match: FindMatch = {
        address: formatCellRef(rowNumber, column),
        row: rowNumber,
        column,
        value: normalizeCell(snapshot, normalizeOptions).value,
        ...(observation === undefined
          ? {}
          : { typedValue: presentScalar(typedValueOf(observation)) }),
      };
      if (
        options.searchIn !== "values" &&
        typeof snapshot.formula === "string"
      ) {
        haystacks.push(`=${snapshot.formula}`);
      }
      if (regexTest !== undefined) {
        const bytes = Buffer.byteLength(JSON.stringify(haystacks)) + 1;
        if (bytes > 65530)
          throw new SezzleeExcelError(
            "resource_limit",
            "A cell exceeds the regex message budget.",
          );
        if (batchBytes + bytes > 65530) await flush();
        batch.push({
          match,
          texts: haystacks,
        });
        batchBytes += bytes;
        if (batch.length >= 128) await flush();
        continue;
      }
      if (!haystacks.some((text) => text !== "" && matcher?.test(text))) {
        continue;
      }
      total += 1;
      admitMatch(match);
    }
  }
  await flush();
  return {
    sheet: sheet.name,
    range: formatRange(bounds),
    total,
    truncated: total > found.length,
    scannedCells,
    matching: matcher?.matching ?? "regex",
    matches: found,
    ...(selected.table === undefined ? {} : { table: selected.table }),
    ...(visibility === undefined ? {} : { visibility }),
    ...(budget.refused ? { truncationReason: "maxPayloadBytes" as const } : {}),
    ...(plans.size === 0 || options.searchIn === "formulas"
      ? {}
      : {
          typed: {
            scope: "scannedCells" as const,
            columns: reportTyped(reports),
          },
        }),
  };
}

function renderScalar(value: CellScalar): string {
  return scalarText(value);
}
