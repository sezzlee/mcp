import { fold } from "@sezzlee/file-core";
import type { CellScalar } from "./cell-value.js";
import {
  buildColumnIndex,
  resolveColumn,
  type ColumnIndex,
  type ColumnMode,
} from "./columns.js";
import { SezzleeExcelError } from "../platform/errors.js";
import {
  headerWarnings,
  readHeaderRow,
  type HeaderRowSource,
} from "./header.js";
import { limits } from "../platform/limits.js";
import {
  explicitReading,
  rawReading,
  readAsOf,
  readingWarnings,
  sniffedReading,
  typedCell,
  type ColumnReading,
  type ColumnSpec,
  type ReadAs,
} from "./column-reading.js";
import {
  classify,
  compareWithin,
  emptyCensus,
  evaluate,
  kindPrecedence,
  kindsRead,
  majorityKind,
  record,
  reportCensus,
  validateCondition,
  type Census,
  type ComparableKind,
  type Condition,
  type PredicateOptions,
} from "./predicate.js";
import { columnToLetters, formatRange, resolveRange } from "./range.js";
import { isUncachedFormula, presentScalar, resolveCell } from "./cell-value.js";
import type { RowView } from "./sheet.js";
import { requireSheetBounds, type SheetSource } from "./sheet.js";

export type MetricFunction =
  | "count"
  | "countValues"
  | "countDistinct"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "stddev";

export interface MetricRequest {
  readonly fn: MetricFunction;
  readonly column?: string;
}

export interface AggregateOptions {
  readonly sheetName?: string;
  readonly range?: string;
  readonly groupBy?: readonly string[];
  readonly metrics: readonly MetricRequest[];
  readonly where?: readonly Condition[];
  readonly match: "all" | "any";
  readonly headerRow: number;
  readonly columnMode: ColumnMode;
  readonly caseSensitive: boolean;
  readonly columns?: readonly ColumnSpec[];
  readonly mergedCells: "master" | "repeat";
  readonly orderBy: "group" | "metric";
  readonly orderByMetric?: number;
  readonly descending: boolean;
  readonly maxGroups: number;
  readonly headerRowSource: HeaderRowSource;
}

export interface AggregateColumn {
  readonly label: string;
  readonly letter?: string;
  readonly role: "group" | "metric";
  readonly fn?: MetricFunction;
  readonly counted?: number;
  readonly skipped?: number;
  readonly kindUsed?: ComparableKind;
}

export interface AggregateResult {
  readonly sheet: string;
  readonly range: string;
  readonly usedRange: string;
  readonly headerRow: number;
  readonly headerRowSource: HeaderRowSource;
  readonly columns: readonly AggregateColumn[];
  readonly rows: readonly (readonly CellScalar[])[];
  readonly groupCount: number;
  readonly returnedGroups: number;
  readonly scannedRows: number;
  readonly matchedRows: number;
  readonly returnedMatchedRows: number;
  readonly omittedMatchedRows: number;
  readonly firstScannedRow: number;
  readonly blankRows: number;
  readonly columnStats?: Readonly<Record<string, Partial<Census>>>;
  readonly readAs?: Readonly<Record<string, readonly ReadAs[]>>;
  readonly truncated: boolean;
  readonly truncationReason?: "maxGroups";
  readonly hint?: string;
  readonly warnings?: readonly string[];
}

interface SumState {
  sum: number;
  compensation: number;
}

interface MetricState {
  counted: number;
  skipped: number;
  readonly sums: SumState;
  distinct: Set<string> | undefined;
  extreme:
    | { readonly kind: "number"; readonly value: number }
    | { readonly kind: "date" | "time" | "text"; readonly value: string }
    | undefined;
  mean: number;
  m2: number;
}

interface GroupState {
  readonly key: readonly CellScalar[];
  readonly metrics: MetricState[];
  rows: number;
}

function accumulate(state: SumState, value: number): void {
  const total = finite(state.sum + value);
  state.compensation = finite(
    state.compensation +
      (Math.abs(state.sum) >= Math.abs(value)
        ? state.sum - total + value
        : value - total + state.sum),
  );
  state.sum = total;
}

function sumOf(state: SumState): number {
  return finite(state.sum + state.compensation);
}

function finite(value: number): number {
  if (!Number.isFinite(value))
    throw new SezzleeExcelError(
      "numeric_overflow",
      "A metric calculation exceeded the finite number range.",
      "Narrow the range or scale the numeric values.",
    );
  return value;
}

function newMetricState(fn: MetricFunction): MetricState {
  return {
    counted: 0,
    skipped: 0,
    sums: { sum: 0, compensation: 0 },
    distinct: fn === "countDistinct" ? new Set<string>() : undefined,
    extreme: undefined,
    mean: 0,
    m2: 0,
  };
}

interface GridRead {
  readonly value: CellScalar;
  readonly uncachedFormula: boolean;
}

function readGrid(
  rowView: RowView | undefined,
  column: number,
  mergedCells: "master" | "repeat",
): GridRead {
  const snapshot = rowView?.cellAt(column);
  if (snapshot === undefined) {
    return { value: null, uncachedFormula: false };
  }
  const merged = snapshot.merged && mergedCells === "master";
  return {
    value: resolveCell(snapshot, {
      valueMode: "values",
      mergePolicy: mergedCells,
    }),
    uncachedFormula: !merged && isUncachedFormula(snapshot),
  };
}

function keyOf(values: readonly CellScalar[]): string {
  return JSON.stringify(values);
}

function compareKeys(
  left: readonly CellScalar[],
  right: readonly CellScalar[],
  caseSensitive: boolean,
): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? null;
    const b = right[index] ?? null;
    const ka = classify(a);
    const kb = classify(b);
    if (ka !== kb) {
      return kindPrecedence.indexOf(ka) - kindPrecedence.indexOf(kb);
    }
    if (ka === "number" || ka === "date" || ka === "text") {
      const order = compareWithin(ka, a, b, caseSensitive);
      if (order !== 0) {
        return order;
      }
      continue;
    }
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

function metricLabel(metric: MetricRequest): string {
  return metric.column === undefined
    ? metric.fn
    : `${metric.fn}(${metric.column})`;
}

function finish(metric: MetricRequest, state: MetricState): CellScalar {
  switch (metric.fn) {
    case "count":
      return state.counted;
    case "countValues":
      return state.counted;
    case "countDistinct":
      return state.distinct?.size ?? 0;
    case "sum":
      return state.counted === 0 ? null : sumOf(state.sums);
    case "avg":
      return state.counted === 0 ? null : sumOf(state.sums) / state.counted;
    case "stddev":
      return state.counted < 2
        ? null
        : finite(Math.sqrt(state.m2 / (state.counted - 1)));
    default:
      return state.extreme?.value ?? null;
  }
}

const maxSamples = 3;

interface Tally {
  count: number;
  readonly samples: Set<string>;
}

function tallyOf(): Tally {
  return { count: 0, samples: new Set() };
}

function note(tally: Tally, value: CellScalar): void {
  tally.count += 1;
  if (tally.samples.size < maxSamples)
    tally.samples.add(
      typeof value === "string" ? value : JSON.stringify(value),
    );
}

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

function samplesOf(tally: Tally): string {
  return [...tally.samples].map((sample) => `'${sample}'`).join(", ");
}

const numericMetrics = new Set<MetricFunction>(["sum", "avg", "stddev"]);
const extremeMetrics = new Set<MetricFunction>(["min", "max"]);

export function aggregateSheet(
  source: SheetSource,
  options: AggregateOptions,
): AggregateResult {
  if (options.metrics.length === 0) {
    throw new SezzleeExcelError(
      "invalid_argument",
      "At least one metric is required.",
      'Pass metrics, for example [{"fn":"count"}].',
    );
  }
  if (
    options.orderByMetric !== undefined &&
    (!Number.isSafeInteger(options.orderByMetric) ||
      options.orderByMetric < 1 ||
      options.orderByMetric > options.metrics.length)
  ) {
    throw new SezzleeExcelError(
      "invalid_argument",
      "orderByMetric must identify an entry in metrics.",
    );
  }
  const sheet = source.sheetFor(options.sheetName);
  const used = requireSheetBounds(sheet);
  const bounds = resolveRange(used, options.range);

  const headers = readHeaderRow(sheet, bounds, options.headerRow, {
    valueMode: "values",
    mergePolicy: options.mergedCells,
    includeHyperlinks: false,
  });
  const index: ColumnIndex = buildColumnIndex(
    `${sheet.name}!${formatRange(bounds)}`,
    bounds,
    options.headerRow,
    headers,
  );

  const groupColumns = (options.groupBy ?? []).map((reference) => ({
    reference,
    column: resolveColumn(index, reference, options.columnMode),
  }));
  const metricColumns = options.metrics.map((metric) => ({
    metric,
    column:
      metric.column === undefined
        ? undefined
        : resolveColumn(index, metric.column, options.columnMode),
  }));
  for (const entry of metricColumns) {
    if (entry.metric.fn !== "count" && entry.column === undefined) {
      throw new SezzleeExcelError(
        "invalid_argument",
        `Metric '${entry.metric.fn}' needs a column.`,
        "Pass column, or use fn 'count' to count rows.",
      );
    }
  }
  const conditions = (options.where ?? []).map((condition) => {
    validateCondition(condition, options.caseSensitive);
    return {
      condition,
      column: resolveColumn(index, condition.column, options.columnMode),
    };
  });

  const predicateOptions: PredicateOptions = {
    caseSensitive: options.caseSensitive,
  };
  const census = new Map<number, Census>();
  const censusFor = (column: number): Census => {
    const existing = census.get(column);
    if (existing !== undefined) {
      return existing;
    }
    const fresh = emptyCensus();
    census.set(column, fresh);
    return fresh;
  };

  const groups = new Map<string, GroupState>();
  const groupFor = (key: readonly CellScalar[]): GroupState => {
    const id = keyOf(key);
    const existing = groups.get(id);
    if (existing !== undefined) {
      return existing;
    }
    if (groups.size >= limits.maxAggregateGroups) {
      throw new SezzleeExcelError(
        "resource_limit",
        `The rows form more than ${limits.maxAggregateGroups} groups.`,
        "Group by fewer or coarser columns, or add where conditions.",
      );
    }
    const fresh: GroupState = {
      key,
      rows: 0,
      metrics: options.metrics.map((metric) => newMetricState(metric.fn)),
    };
    groups.set(id, fresh);
    return fresh;
  };
  let visits = 0;
  const visit = (): void => {
    visits += 1;
    if (visits > limits.maxAggregateCellVisits) {
      throw new SezzleeExcelError(
        "resource_limit",
        `Aggregating this range reads more than ${limits.maxAggregateCellVisits} cells.`,
        "Pass a narrower range, or split the aggregate into several ranges.",
      );
    }
  };
  const startRow =
    options.headerRow >= bounds.top && options.headerRow <= bounds.bottom
      ? Math.max(bounds.top, options.headerRow + 1)
      : bounds.top;
  const withCovered = options.mergedCells === "repeat";
  const rowsInRange = (): Iterable<number> =>
    sheet.populatedRows({ from: startRow, to: bounds.bottom, withCovered });

  const readings = new Map<number, ColumnReading>();
  for (const spec of options.columns ?? []) {
    const column = resolveColumn(index, spec.column, options.columnMode);
    if (readings.has(column))
      throw new SezzleeExcelError(
        "invalid_argument",
        `columns names ${columnToLetters(column)} twice.`,
        "Give each column one entry.",
      );
    readings.set(column, explicitReading(spec));
  }
  const needs = new Map<number, { number: boolean; date: boolean }>();
  const need = (column: number, kinds: readonly ComparableKind[]): void => {
    const current = needs.get(column) ?? { number: false, date: false };
    needs.set(column, {
      number: current.number || kinds.includes("number"),
      date: current.date || kinds.includes("date"),
    });
  };
  for (const entry of conditions)
    need(entry.column, kindsRead(entry.condition));
  for (const entry of metricColumns) {
    if (entry.column === undefined) continue;
    if (numericMetrics.has(entry.metric.fn)) need(entry.column, ["number"]);
    if (extremeMetrics.has(entry.metric.fn))
      need(entry.column, ["number", "date"]);
  }
  const sniffed = [...needs].filter(
    ([column, wanted]) =>
      !readings.has(column) && (wanted.number || wanted.date),
  );
  if (sniffed.length > 0) {
    const texts = new Map<number, string[]>(
      sniffed.map(([column]) => [column, []]),
    );
    for (const row of rowsInRange()) {
      const rowView = sheet.rowAt(row);
      for (const [column, values] of texts) {
        visit();
        const value = readGrid(rowView, column, options.mergedCells).value;
        if (typeof value === "string" && classify(value) === "text")
          values.push(value);
      }
    }
    for (const [column, wanted] of sniffed)
      readings.set(column, sniffedReading(texts.get(column) ?? [], wanted));
  }
  const readingOf = (column: number): ColumnReading =>
    readings.get(column) ?? rawReading;

  const extremeCounts = new Map<number, Record<ComparableKind, number>>();
  const extremeCountsFor = (column: number): Record<ComparableKind, number> => {
    const existing = extremeCounts.get(column);
    if (existing !== undefined) return existing;
    const fresh = { number: 0, date: 0, time: 0, text: 0 };
    extremeCounts.set(column, fresh);
    return fresh;
  };

  const incomparable = conditions.map(() => tallyOf());
  const unreadable = new Map<number, Tally>();
  const identifiers = new Map<number, Tally>();
  const currencies = new Map<number, Set<string>>();
  const numericOwner = new Map<number, number>();
  metricColumns.forEach((entry, slot) => {
    if (
      entry.column !== undefined &&
      numericMetrics.has(entry.metric.fn) &&
      !numericOwner.has(entry.column)
    )
      numericOwner.set(entry.column, slot);
  });

  let scannedRows = 0;
  let matchedRows = 0;
  let uncachedFormulas = 0;
  let blankRows = 0;

  const matches = (cellAt: (column: number) => CellScalar): boolean => {
    let matched = conditions.length === 0 ? true : options.match === "all";
    conditions.forEach((entry, at) => {
      const raw = cellAt(entry.column);
      const outcome = evaluate(
        entry.condition,
        typedCell(raw, readingOf(entry.column)),
        predicateOptions,
      );
      if (outcome === "incomparable") {
        const tally = incomparable[at];
        if (tally !== undefined) note(tally, raw);
      }
      const hit = outcome === "match";
      matched = options.match === "all" ? matched && hit : matched || hit;
    });
    return matched;
  };

  for (const row of rowsInRange()) {
    scannedRows += 1;
    visit();
    const rowView = sheet.rowAt(row);
    let blank = true;
    for (const column of rowView?.populatedColumns({
      from: bounds.left,
      to: bounds.right,
      withCovered,
    }) ?? []) {
      visit();
      const snapshot = rowView?.cellAt(column);
      if (
        snapshot !== undefined &&
        resolveCell(snapshot, {
          valueMode: "values",
          mergePolicy: options.mergedCells,
        }) !== null
      ) {
        blank = false;
        break;
      }
    }
    if (blank) {
      blankRows += 1;
    }
    const cellAt = (column: number): CellScalar => {
      visit();
      const read = readGrid(rowView, column, options.mergedCells);
      if (read.uncachedFormula) {
        uncachedFormulas += 1;
      }
      return read.value;
    };

    if (!matches(cellAt)) {
      continue;
    }
    matchedRows += 1;

    const group = groupFor(groupColumns.map((entry) => cellAt(entry.column)));
    group.rows += 1;

    for (let slot = 0; slot < metricColumns.length; slot += 1) {
      const entry = metricColumns[slot];
      const state = group.metrics[slot];
      if (entry === undefined || state === undefined) {
        continue;
      }
      if (entry.metric.fn === "count") {
        state.counted += 1;
        continue;
      }
      const column = entry.column as number;
      const cell = typedCell(cellAt(column), readingOf(column));
      const kind = record(censusFor(column), cell);
      if (kind === "empty") {
        state.skipped += 1;
        continue;
      }
      if (entry.metric.fn === "countValues") {
        state.counted += 1;
        continue;
      }
      if (entry.metric.fn === "countDistinct") {
        state.counted += 1;
        state.distinct?.add(JSON.stringify(cell.raw));
        continue;
      }
      if (entry.metric.fn === "min" || entry.metric.fn === "max") {
        const read = cell.number();
        const date = cell.as("date");
        const candidate =
          read.kind === "number"
            ? { kind: "number" as const, value: read.value }
            : typeof date === "string" && classify(date) === "date"
              ? { kind: "date" as const, value: date }
              : typeof cell.raw === "string"
                ? {
                    kind:
                      classify(cell.raw) === "time"
                        ? ("time" as const)
                        : ("text" as const),
                    value: cell.raw,
                  }
                : undefined;
        if (candidate === undefined) {
          state.skipped += 1;
          continue;
        }
        state.counted += 1;
        extremeCountsFor(column)[candidate.kind] += 1;
        if (state.extreme === undefined) {
          state.extreme = candidate;
          continue;
        }
        if (state.extreme.kind !== candidate.kind)
          throw new SezzleeExcelError(
            "invalid_argument",
            `Metric '${entry.metric.fn}' mixes ${state.extreme.kind} and ${candidate.kind} at ${columnToLetters(column)}${row}.`,
            "Use a homogeneous range, or filter with where isNumber.",
          );
        const order = compareWithin(
          candidate.kind,
          candidate.value,
          state.extreme.value,
          options.caseSensitive,
        );
        if (entry.metric.fn === "min" ? order < 0 : order > 0) {
          state.extreme = candidate;
        }
        continue;
      }
      const read = cell.number();
      if (read.kind !== "number") {
        state.skipped += 1;
        if (numericOwner.get(column) === slot) {
          const tallies =
            read.kind === "unreadable"
              ? unreadable
              : read.kind === "identifier"
                ? identifiers
                : undefined;
          if (tallies !== undefined) {
            const tally = tallies.get(column) ?? tallyOf();
            tallies.set(column, tally);
            note(tally, cell.raw);
          }
        }
        continue;
      }
      if (read.currency !== undefined && numericOwner.get(column) === slot) {
        const seen = currencies.get(column) ?? new Set<string>();
        currencies.set(column, seen.add(read.currency));
      }
      const numeric = read.value;
      state.counted += 1;
      if (entry.metric.fn === "sum" || entry.metric.fn === "avg")
        accumulate(state.sums, numeric);
      if (entry.metric.fn === "stddev") {
        const delta = finite(numeric - state.mean);
        state.mean = finite(state.mean + delta / state.counted);
        state.m2 = finite(
          state.m2 + finite(delta * finite(numeric - state.mean)),
        );
      }
    }
  }

  /**
   * A row with no stored cell reads null in every column, so those rows fold
   * in one step weighted by their count; query-values.spec.ts pins the
   * counts.
   */
  const absent = Math.max(0, bounds.bottom - startRow + 1) - scannedRows;
  if (absent > 0) {
    scannedRows += absent;
    blankRows += absent;
    if (matches(() => null)) {
      matchedRows += absent;
      const group = groupFor(groupColumns.map(() => null));
      group.rows += absent;
      metricColumns.forEach((entry, slot) => {
        const state = group.metrics[slot];
        if (state === undefined) return;
        if (entry.metric.fn === "count") {
          state.counted += absent;
          return;
        }
        censusFor(entry.column as number).nulls += absent;
        state.skipped += absent;
      });
    }
  }

  const ordered = [...groups.values()];
  const metricSlot = (options.orderByMetric ?? 1) - 1;
  ordered.sort((left, right) => {
    if (options.orderBy === "metric") {
      const a = finish(
        options.metrics[metricSlot] as MetricRequest,
        left.metrics[metricSlot] as MetricState,
      );
      const b = finish(
        options.metrics[metricSlot] as MetricRequest,
        right.metrics[metricSlot] as MetricState,
      );
      const av = typeof a === "number" ? a : Number.NEGATIVE_INFINITY;
      const bv = typeof b === "number" ? b : Number.NEGATIVE_INFINITY;
      if (av !== bv) {
        return options.descending ? bv - av : av - bv;
      }
      return compareKeys(left.key, right.key, options.caseSensitive);
    }
    const order = compareKeys(left.key, right.key, options.caseSensitive);
    if (order !== 0) {
      return options.descending ? -order : order;
    }
    return 0;
  });

  const truncated = ordered.length > options.maxGroups;
  const page = ordered.slice(0, options.maxGroups);

  const columns: AggregateColumn[] = [
    ...groupColumns.map((entry): AggregateColumn => {
      const header = headers[entry.column - bounds.left];
      return {
        label: header ?? columnToLetters(entry.column),
        letter: columnToLetters(entry.column),
        role: "group",
      };
    }),
    ...metricColumns.map((entry, slot): AggregateColumn => {
      const counted = page.reduce(
        (total, group) => total + (group.metrics[slot]?.counted ?? 0),
        0,
      );
      const skipped = page.reduce(
        (total, group) => total + (group.metrics[slot]?.skipped ?? 0),
        0,
      );
      const kindUsed = extremeMetrics.has(entry.metric.fn)
        ? majorityKind(extremeCountsFor(entry.column as number))
        : undefined;
      return {
        label: metricLabel(entry.metric),
        ...(entry.column === undefined
          ? {}
          : { letter: columnToLetters(entry.column) }),
        role: "metric",
        fn: entry.metric.fn,
        counted,
        skipped,
        ...(kindUsed === undefined ? {} : { kindUsed }),
      };
    }),
  ];

  const rows =
    page.length === 0 && groupColumns.length === 0
      ? [
          [
            ...options.metrics.map((metric) =>
              metric.fn === "count" ? 0 : null,
            ),
          ] as CellScalar[],
        ]
      : page.map((group) => [
          ...group.key.map(presentScalar),
          ...options.metrics.map((metric, slot) =>
            presentScalar(finish(metric, group.metrics[slot] as MetricState)),
          ),
        ]);

  const stats: Record<string, Partial<Census>> = {};
  for (const [column, counted] of census) {
    const reported = reportCensus(counted);
    if (Object.keys(reported).length > 0) {
      stats[columnToLetters(column)] = reported;
    }
  }

  const readAs: Record<string, readonly ReadAs[]> = {};
  for (const [column, reading] of readings) {
    const described = readAsOf(reading);
    if (described.length > 0) readAs[columnToLetters(column)] = described;
  }

  const warnings: string[] = [
    ...headerWarnings(
      sheet,
      bounds,
      options.headerRow,
      headers,
      options.range !== undefined,
      options.mergedCells,
    ),
  ];
  const collisions = new Map<string, Set<string>>();
  for (const group of ordered) {
    const label = group.key
      .map((value) =>
        typeof value === "string" ? fold(value) : JSON.stringify(value),
      )
      .join("\u0000");
    const bucket = collisions.get(label) ?? new Set<string>();
    bucket.add(
      group.key
        .map((value) =>
          typeof value === "string"
            ? String(presentScalar(value))
            : JSON.stringify(value),
        )
        .join(" / "),
    );
    collisions.set(label, bucket);
  }
  for (const bucket of collisions.values()) {
    if (bucket.size > 1) {
      warnings.push(
        `Groups ${[...bucket].map((entry) => `'${entry}'`).join(" and ")} differ only by case or accent.`,
      );
    }
  }
  for (const [column, reading] of readings)
    warnings.push(...readingWarnings(reading, columnToLetters(column)));
  conditions.forEach((entry, at) => {
    const tally = incomparable[at];
    if (tally === undefined || tally.count === 0) return;
    const kinds = kindsRead(entry.condition);
    const as = kinds.length === 0 ? "the operand" : `a ${kinds.join(" or ")}`;
    warnings.push(
      `where ${entry.condition.column} ${entry.condition.op}: ${count(tally.count, "cell", "cells")} in ${columnToLetters(entry.column)} could not be compared with ${as}, such as ${samplesOf(tally)}; they did not match.`,
    );
  });
  for (const [column, seen] of currencies)
    if (seen.size > 1)
      warnings.push(
        `${columnToLetters(column)}: amounts are written in more than one currency (${[...seen].sort().join(", ")}); the totals add them as written, without conversion.`,
      );
  for (const [column, tally] of unreadable)
    warnings.push(
      `${columnToLetters(column)}: ${count(tally.count, "text cell does", "text cells do")} not read as a number, such as ${samplesOf(tally)}; the totals exclude them.`,
    );
  for (const [column, tally] of identifiers)
    warnings.push(
      `${columnToLetters(column)}: ${count(tally.count, "cell looks like an identifier", "cells look like identifiers")} (a leading zero or more than 15 digits), such as ${samplesOf(tally)}; the totals exclude them. If they are quantities, pass columns [{"column":"${columnToLetters(column)}","type":"number","decimal":"."}].`,
    );
  if (uncachedFormulas > 0) {
    warnings.push(
      `${uncachedFormulas} formula cells in the aggregated columns have no cached value; the totals exclude them.`,
    );
  }

  return {
    sheet: sheet.name,
    range: formatRange(bounds),
    usedRange: formatRange(used),
    headerRow: options.headerRow,
    headerRowSource: options.headerRowSource,
    columns,
    rows,
    groupCount: ordered.length,
    returnedGroups: page.length,
    scannedRows,
    matchedRows,
    returnedMatchedRows: page.reduce((sum, group) => sum + group.rows, 0),
    omittedMatchedRows:
      matchedRows - page.reduce((sum, group) => sum + group.rows, 0),
    firstScannedRow: startRow,
    blankRows,
    ...(Object.keys(stats).length > 0 ? { columnStats: stats } : {}),
    ...(Object.keys(readAs).length > 0 ? { readAs } : {}),
    truncated,
    ...(truncated ? { truncationReason: "maxGroups" as const } : {}),
    ...(truncated
      ? {
          hint:
            options.orderBy === "metric"
              ? `${ordered.length} distinct groups; the top ${page.length} in metric order were returned. Raise maxGroups (at most ${limits.maxGroupsHard}) for more, or add a where clause.`
              : `${ordered.length} distinct groups; the first ${page.length} in group order were returned. Set orderBy to "metric" with orderByMetric to get the top groups, or add a where clause.`,
        }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export const aggregateLimits = {
  maxGroupsDefault: limits.maxGroupsDefault,
  maxGroupsHard: limits.maxGroupsHard,
} as const;
