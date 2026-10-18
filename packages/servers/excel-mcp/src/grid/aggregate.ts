import { fold } from "@sezzlee/file-core";
import type { CellScalar } from "./cell-value.js";
import { buildColumnIndex, resolveColumn, type ColumnMode } from "./columns.js";
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
  record,
  reportCensus,
  validateCondition,
  type Census,
  type ComparableKind,
  type Condition,
  type TypedCell,
} from "./predicate.js";
import { columnToLetters, formatRange, resolveRange } from "./range.js";
import { isUncachedFormula, presentScalar, resolveCell } from "./cell-value.js";
import type { RowView } from "./sheet.js";
import { requireSheetBounds, type SheetSource } from "./sheet.js";
import {
  addMetric,
  finishMetric,
  isNumericMetric,
  metricKind,
  metricLabel,
  newMetricStates,
  validateMetric,
  type MetricFunction,
  type MetricRequest,
  type MetricState,
} from "./aggregate-metrics.js";
import {
  compileGroup,
  groupNeeds,
  groupValue,
  type DatePart,
  type GroupPlan,
  type GroupRequest,
  type GroupValue,
} from "./grouping.js";

export type { MetricFunction, MetricRequest } from "./aggregate-metrics.js";

export interface AggregateOptions {
  readonly sheetName?: string;
  readonly range?: string;
  readonly groupBy?: readonly GroupRequest[];
  readonly pivotBy?: readonly GroupRequest[];
  readonly groupingSets?: readonly {
    readonly groupBy: readonly GroupRequest[];
  }[];
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
  readonly filtered?: number;
  readonly kindUsed?: ComparableKind;
  readonly percentile?: number;
  readonly method?: "linear";
  readonly pivotKey?: readonly CellScalar[];
  readonly by?: DatePart;
  readonly bins?: readonly number[];
  readonly width?: number;
  readonly origin?: number;
  readonly interval?: "[lower, upper)";
}

export interface GroupingResult {
  readonly columns: readonly AggregateColumn[];
  readonly rows: readonly (readonly CellScalar[])[];
  readonly groupCount: number;
  readonly returnedGroups: number;
  readonly returnedMatchedRows: number;
  readonly omittedMatchedRows: number;
  readonly ungroupedRows?: number;
  readonly pivotBy?: readonly AggregateColumn[];
  readonly truncated: boolean;
  readonly truncationReason?: "maxGroups";
  readonly hint?: string;
}

export interface AggregateResult extends GroupingResult {
  readonly sheet: string;
  readonly range: string;
  readonly usedRange: string;
  readonly headerRow: number;
  readonly headerRowSource: HeaderRowSource;
  readonly groupingSets?: readonly GroupingResult[];
  readonly scannedRows: number;
  readonly matchedRows: number;
  readonly firstScannedRow: number;
  readonly blankRows: number;
  readonly columnStats?: Readonly<Record<string, Partial<Census>>>;
  readonly readAs?: Readonly<Record<string, readonly ReadAs[]>>;
  readonly warnings?: readonly string[];
}

interface GroupKey {
  readonly values: readonly CellScalar[];
  readonly order: readonly CellScalar[];
}

interface GroupState {
  readonly key: GroupKey;
  readonly metrics: MetricState[];
  readonly pivots: Map<string, MetricState[]>;
  rows: number;
}

interface Grouping {
  readonly columns: readonly GroupPlan[];
  readonly groups: Map<string, GroupState>;
  readonly pivotKeys: Map<string, GroupKey>;
  ungroupedRows: number;
}

interface ResolvedCondition {
  readonly condition: Condition;
  readonly column: number;
  readonly tally: Tally;
}

interface Tally {
  count: number;
  readonly samples: Set<string>;
}

function tallyOf(): Tally {
  return { count: 0, samples: new Set() };
}

function note(tally: Tally, value: CellScalar, weight = 1): void {
  tally.count += weight;
  if (tally.samples.size < 3) {
    const sample = presentScalar(value);
    tally.samples.add(
      typeof sample === "string" ? sample : JSON.stringify(sample),
    );
  }
}

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

function samplesOf(tally: Tally): string {
  return [...tally.samples].map((sample) => `'${sample}'`).join(", ");
}

function readGrid(
  rowView: RowView | undefined,
  column: number,
  mergedCells: "master" | "repeat",
): { readonly value: CellScalar; readonly uncachedFormula: boolean } {
  const snapshot = rowView?.cellAt(column);
  if (snapshot === undefined) return { value: null, uncachedFormula: false };
  const merged = snapshot.merged && mergedCells === "master";
  return {
    value: resolveCell(snapshot, {
      valueMode: "values",
      mergePolicy: mergedCells,
    }),
    uncachedFormula: !merged && isUncachedFormula(snapshot),
  };
}

function compareKeys(
  left: readonly CellScalar[],
  right: readonly CellScalar[],
  caseSensitive: boolean,
): number {
  for (let at = 0; at < left.length; at += 1) {
    const a = left[at] ?? null;
    const b = right[at] ?? null;
    const kind = classify(a);
    const other = classify(b);
    if (kind !== other)
      return kindPrecedence.indexOf(kind) - kindPrecedence.indexOf(other);
    if (
      kind === "number" ||
      kind === "date" ||
      kind === "time" ||
      kind === "text"
    ) {
      const order = compareWithin(kind, a, b, caseSensitive);
      if (order !== 0) return order;
    } else {
      const text = JSON.stringify(a);
      const otherText = JSON.stringify(b);
      if (text !== otherText) return text < otherText ? -1 : 1;
    }
  }
  return 0;
}

function keyFor(
  plans: readonly GroupPlan[],
  values: ReadonlyMap<GroupPlan, GroupValue>,
): GroupKey | undefined {
  const key: CellScalar[] = [];
  const order: CellScalar[] = [];
  for (const plan of plans) {
    const value = values.get(plan);
    if (value === undefined || value.kind === "unreadable") return undefined;
    key.push(value.value);
    order.push(value.order);
  }
  return { values: key, order };
}

function conditionWarnings(
  conditions: readonly ResolvedCondition[],
  prefix: string,
): string[] {
  return conditions.flatMap(({ condition, column, tally }) => {
    if (tally.count === 0) return [];
    const kinds = kindsRead(condition);
    const as = kinds.length === 0 ? "the operand" : `a ${kinds.join(" or ")}`;
    return [
      `${prefix} ${condition.column} ${condition.op}: ${count(tally.count, "cell", "cells")} in ${columnToLetters(column)} could not be compared with ${as}, such as ${samplesOf(tally)}; they did not match.`,
    ];
  });
}

export function aggregateSheet(
  source: SheetSource,
  options: AggregateOptions,
): AggregateResult {
  const firstMetric = options.metrics[0];
  if (firstMetric === undefined || options.metrics.length > limits.maxMetrics)
    throw new SezzleeExcelError(
      "invalid_argument",
      `Pass between 1 and ${limits.maxMetrics} metrics.`,
    );
  options.metrics.forEach(validateMetric);
  if (
    options.orderByMetric !== undefined &&
    (!Number.isSafeInteger(options.orderByMetric) ||
      options.orderByMetric < 1 ||
      options.orderByMetric > options.metrics.length)
  )
    throw new SezzleeExcelError(
      "invalid_argument",
      "orderByMetric must identify an entry in metrics.",
    );
  if ((options.groupingSets?.length ?? 0) > limits.maxGroupingSets)
    throw new SezzleeExcelError(
      "invalid_argument",
      `At most ${limits.maxGroupingSets} additional grouping sets are accepted.`,
    );

  const sheet = source.sheetFor(options.sheetName);
  const used = requireSheetBounds(sheet);
  const bounds = resolveRange(used, options.range);
  const headers = readHeaderRow(sheet, bounds, options.headerRow, {
    valueMode: "values",
    mergePolicy: options.mergedCells,
    includeHyperlinks: false,
  });
  const index = buildColumnIndex(
    `${sheet.name}!${formatRange(bounds)}`,
    bounds,
    options.headerRow,
    headers,
  );

  const plans = new Map<string, GroupPlan>();
  const compile = (requests: readonly GroupRequest[]): readonly GroupPlan[] => {
    if (requests.length > limits.maxMetrics)
      throw new SezzleeExcelError(
        "invalid_argument",
        `At most ${limits.maxMetrics} columns are accepted on a grouping axis.`,
      );
    return requests.map((request) => {
      const compiled = compileGroup(index, request, options.columnMode);
      const id = JSON.stringify(compiled.description);
      const existing = plans.get(id);
      if (existing !== undefined) return existing;
      plans.set(id, compiled);
      return compiled;
    });
  };
  const grouping = (requests: readonly GroupRequest[]): Grouping => ({
    columns: compile(requests),
    groups: new Map(),
    pivotKeys: new Map(),
    ungroupedRows: 0,
  });
  const primary = grouping(options.groupBy ?? []);
  const additional = (options.groupingSets ?? []).map((set) =>
    grouping(set.groupBy),
  );
  const groupings = [primary, ...additional];
  const pivotColumns = compile(options.pivotBy ?? []);
  const hasPivot = pivotColumns.length > 0;
  const resolveConditions = (
    conditions: readonly Condition[],
  ): readonly ResolvedCondition[] =>
    conditions.map((condition) => {
      validateCondition(condition, options.caseSensitive);
      return {
        condition,
        column: resolveColumn(index, condition.column, options.columnMode),
        tally: tallyOf(),
      };
    });
  const conditions = resolveConditions(options.where ?? []);
  const metricColumns = options.metrics.map((metric) => ({
    metric,
    column:
      metric.column === undefined
        ? undefined
        : resolveColumn(index, metric.column, options.columnMode),
    conditions: resolveConditions(metric.where ?? []),
  }));
  const metricStates = metricColumns.map((entry) => ({
    request: entry.metric,
    sampleKey: JSON.stringify([
      entry.column,
      entry.conditions.map(({ column, condition }) => [
        column,
        condition.op,
        condition.value,
        condition.values,
      ]),
    ]),
  }));

  let visits = 0;
  const visit = (): void => {
    visits += 1;
    if (visits > limits.maxAggregateCellVisits)
      throw new SezzleeExcelError(
        "resource_limit",
        `Aggregating this range reads more than ${limits.maxAggregateCellVisits} cells.`,
        "Pass a narrower range, or split the aggregate into several ranges.",
      );
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
  for (const plan of plans.values()) need(plan.column, groupNeeds(plan));
  for (const entry of conditions)
    need(entry.column, kindsRead(entry.condition));
  for (const entry of metricColumns) {
    for (const condition of entry.conditions)
      need(condition.column, kindsRead(condition.condition));
    if (entry.column === undefined) continue;
    if (isNumericMetric(entry.metric.fn)) need(entry.column, ["number"]);
    if (entry.metric.fn === "min" || entry.metric.fn === "max")
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

  let storedGroups = 0;
  let storedMetricStates = 0;
  let storedSamples = 0;
  let storedDistinct = 0;
  let denseCells = 0;
  const newStates = (): MetricState[] => {
    storedMetricStates += options.metrics.length;
    if (storedMetricStates > limits.maxAggregateMetricStates)
      throw new SezzleeExcelError(
        "resource_limit",
        `Aggregation needs more than ${limits.maxAggregateMetricStates} metric states.`,
        "Use fewer metrics, grouping sets or distinct group keys.",
      );
    return newMetricStates(metricStates);
  };
  const reserveGroup = (): void => {
    storedGroups += 1;
    if (storedGroups > limits.maxAggregateGroups)
      throw new SezzleeExcelError(
        "resource_limit",
        `The rows form more than ${limits.maxAggregateGroups} groups.`,
        "Group by fewer or coarser columns, or add where conditions.",
      );
  };
  const reserveCells = (cells: number): void => {
    denseCells += cells;
    if (denseCells > limits.maxPivotCells)
      throw new SezzleeExcelError(
        "resource_limit",
        `The dense pivots require more than ${limits.maxPivotCells} cells across all grouping sets.`,
        "Use fewer row or pivot keys, fewer metrics, or add where conditions. maxGroups does not shrink this bound.",
      );
  };
  const sample = (): void => {
    storedSamples += 1;
    if (storedSamples > limits.maxAggregateSamples)
      throw new SezzleeExcelError(
        "resource_limit",
        `Exact percentiles need more than ${limits.maxAggregateSamples} stored numeric values across all metrics and grouping sets.`,
        "Narrow the range or request fewer independent percentiles or grouping sets. No approximation is returned.",
      );
  };
  const distinct = (): void => {
    storedDistinct += 1;
    if (storedDistinct > limits.maxAggregateDistinctValues)
      throw new SezzleeExcelError(
        "resource_limit",
        `Exact distinct counts need more than ${limits.maxAggregateDistinctValues} retained values across all metrics and grouping sets.`,
        "Narrow the range or request fewer distinct-count metrics or grouping sets. No approximation is returned.",
      );
  };
  const groupFor = (
    set: Grouping,
    key: GroupKey,
    pivot: GroupKey,
  ): GroupState => {
    const id = JSON.stringify(key.values);
    let group = set.groups.get(id);
    if (group === undefined) {
      reserveGroup();
      if (hasPivot) reserveCells(set.pivotKeys.size * options.metrics.length);
      group = { key, metrics: newStates(), pivots: new Map(), rows: 0 };
      set.groups.set(id, group);
    }
    if (hasPivot) {
      const pivotId = JSON.stringify(pivot.values);
      if (!set.pivotKeys.has(pivotId)) {
        reserveCells(set.groups.size * options.metrics.length);
        set.pivotKeys.set(pivotId, pivot);
      }
      if (!group.pivots.has(pivotId)) {
        reserveGroup();
        group.pivots.set(pivotId, newStates());
      }
    }
    return group;
  };

  const census = new Map<number, Census>();
  const unreadable = new Map<number, Tally>();
  const identifiers = new Map<number, Tally>();
  const currencies = new Map<number, Set<string>>();
  const groupFailures = new Map<GroupPlan, Tally>();
  let scannedRows = 0;
  let matchedRows = 0;
  let blankRows = 0;
  let uncachedFormulas = 0;

  const matches = (
    tests: readonly ResolvedCondition[],
    cellAt: (column: number) => TypedCell,
    match: "all" | "any",
    weight: number,
  ): boolean => {
    let matched = tests.length === 0 || match === "all";
    for (const { condition, column, tally } of tests) {
      const cell = cellAt(column);
      const outcome = evaluate(condition, cell, {
        caseSensitive: options.caseSensitive,
      });
      if (outcome === "incomparable") note(tally, cell.raw, weight);
      matched =
        match === "all"
          ? matched && outcome === "match"
          : matched || outcome === "match";
    }
    return matched;
  };

  const processRow = (
    rowView: RowView | undefined,
    row: number,
    weight: number,
  ): void => {
    const rowCells = new Map<number, TypedCell>();
    const cellAt = (column: number): TypedCell => {
      visit();
      const existing = rowCells.get(column);
      if (existing !== undefined) return existing;
      const read = readGrid(rowView, column, options.mergedCells);
      if (read.uncachedFormula) uncachedFormulas += weight;
      const cell = typedCell(read.value, readings.get(column) ?? rawReading);
      rowCells.set(column, cell);
      return cell;
    };
    if (!matches(conditions, cellAt, options.match, weight)) return;
    matchedRows += weight;
    const values = new Map<GroupPlan, GroupValue>();
    for (const plan of plans.values()) {
      const cell = cellAt(plan.column);
      const value = groupValue(plan, cell);
      values.set(plan, value);
      if (value.kind === "unreadable") {
        const tally = groupFailures.get(plan) ?? tallyOf();
        groupFailures.set(plan, tally);
        note(tally, cell.raw, weight);
      }
    }
    const pivot = keyFor(pivotColumns, values);
    const targets: GroupState[] = [];
    for (const set of groupings) {
      const key = keyFor(set.columns, values);
      if (key === undefined || pivot === undefined) {
        set.ungroupedRows += weight;
        continue;
      }
      const group = groupFor(set, key, pivot);
      group.rows += weight;
      targets.push(group);
    }
    const enabled = metricColumns.map((entry) =>
      matches(entry.conditions, cellAt, "all", weight),
    );
    if (targets.length === 0) return;
    const countedColumns = new Set<number>();
    const numericColumns = new Set<number>();
    const pivotId = JSON.stringify(pivot?.values ?? []);
    const absent = typedCell(null, rawReading);
    metricColumns.forEach((entry, slot) => {
      const include = enabled[slot] ?? false;
      const cell =
        include && entry.column !== undefined && entry.metric.fn !== "count"
          ? cellAt(entry.column)
          : absent;
      if (
        include &&
        entry.column !== undefined &&
        entry.metric.fn !== "count" &&
        !countedColumns.has(entry.column)
      ) {
        const tally = census.get(entry.column) ?? emptyCensus();
        census.set(entry.column, tally);
        if (weight > 1) tally.nulls += weight;
        else record(tally, cell);
        countedColumns.add(entry.column);
      }
      if (
        include &&
        entry.column !== undefined &&
        isNumericMetric(entry.metric.fn) &&
        !numericColumns.has(entry.column)
      ) {
        numericColumns.add(entry.column);
        const read = cell.number();
        if (read.kind === "number" && read.currency !== undefined) {
          const seen = currencies.get(entry.column) ?? new Set<string>();
          currencies.set(entry.column, seen.add(read.currency));
        }
        const tallies =
          read.kind === "identifier"
            ? identifiers
            : read.kind === "unreadable"
              ? unreadable
              : undefined;
        if (tallies !== undefined) {
          const tally = tallies.get(entry.column) ?? tallyOf();
          tallies.set(entry.column, tally);
          note(tally, cell.raw, weight);
        }
      }
      for (const group of targets) {
        const targetStates = hasPivot
          ? [group.metrics, group.pivots.get(pivotId) ?? []]
          : [group.metrics];
        for (const states of targetStates) {
          visit();
          const state = states[slot];
          if (state === undefined) continue;
          if (!include) state.filtered += weight;
          else
            addMetric(state, entry.metric, cell, {
              weight,
              caseSensitive: options.caseSensitive,
              sample,
              distinct,
              address:
                entry.column === undefined
                  ? String(row)
                  : `${columnToLetters(entry.column)}${row}`,
            });
        }
      }
    });
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
      if (readGrid(rowView, column, options.mergedCells).value !== null) {
        blank = false;
        break;
      }
    }
    if (blank) blankRows += 1;
    processRow(rowView, row, 1);
  }
  /** Guard: absent rows are all null; weighting them avoids walking a sparse sheet's rectangle. */
  const absent = Math.max(0, bounds.bottom - startRow + 1) - scannedRows;
  if (absent > 0) {
    scannedRows += absent;
    blankRows += absent;
    processRow(undefined, startRow, absent);
  }

  const warnings = [
    ...headerWarnings(
      sheet,
      bounds,
      options.headerRow,
      headers,
      options.range !== undefined,
      options.mergedCells,
    ),
  ];
  const metricSlot = (options.orderByMetric ?? 1) - 1;
  const sortMetric = options.metrics[metricSlot] ?? firstMetric;
  const finishGrouping = (set: Grouping): GroupingResult => {
    const ordered = [...set.groups.values()];
    ordered.sort((left, right) => {
      if (options.orderBy === "metric") {
        const a = finishMetric(sortMetric, left.metrics[metricSlot]);
        const b = finishMetric(sortMetric, right.metrics[metricSlot]);
        const av = typeof a === "number" ? a : Number.NEGATIVE_INFINITY;
        const bv = typeof b === "number" ? b : Number.NEGATIVE_INFINITY;
        if (av !== bv)
          return (av < bv ? -1 : 1) * (options.descending ? -1 : 1);
      }
      const order = compareKeys(
        left.key.order,
        right.key.order,
        options.caseSensitive,
      );
      return (
        order * (options.orderBy === "group" && options.descending ? -1 : 1)
      );
    });
    const page = ordered.slice(0, options.maxGroups);
    const truncated = ordered.length > page.length;
    const pivots = [...set.pivotKeys].sort((left, right) =>
      compareKeys(left[1].order, right[1].order, options.caseSensitive),
    );
    const descriptors = (
      pivot?: readonly [string, GroupKey],
    ): AggregateColumn[] =>
      metricColumns.map((entry, slot) => {
        let counted = 0;
        let skipped = 0;
        let filtered = 0;
        let kindUsed: ComparableKind | undefined;
        for (const group of page) {
          const state = (
            pivot === undefined ? group.metrics : group.pivots.get(pivot[0])
          )?.[slot];
          counted += state?.counted ?? 0;
          skipped += state?.skipped ?? 0;
          filtered += state?.filtered ?? 0;
          kindUsed ??= metricKind(state);
        }
        return {
          label:
            pivot === undefined
              ? metricLabel(entry.metric)
              : `${pivot[1].values.map((value) => String(presentScalar(value))).join(" / ")}: ${metricLabel(entry.metric)}`,
          ...(entry.column === undefined
            ? {}
            : { letter: columnToLetters(entry.column) }),
          role: "metric",
          fn: entry.metric.fn,
          counted,
          skipped,
          ...(filtered === 0 ? {} : { filtered }),
          ...(kindUsed === undefined ? {} : { kindUsed }),
          ...(entry.metric.percentile === undefined
            ? {}
            : { percentile: entry.metric.percentile }),
          ...(entry.metric.fn === "median" ||
          entry.metric.fn === "p50" ||
          entry.metric.fn === "p90" ||
          entry.metric.fn === "percentile"
            ? { method: "linear" as const }
            : {}),
          ...(pivot === undefined
            ? {}
            : { pivotKey: pivot[1].values.map(presentScalar) }),
        };
      });
    const columns: AggregateColumn[] = [
      ...set.columns.map((entry) => entry.description),
      ...(hasPivot
        ? pivots.flatMap((pivot) => descriptors(pivot))
        : descriptors()),
    ];
    const rows = page.map((group) => [
      ...group.key.values.map(presentScalar),
      ...(hasPivot
        ? pivots.flatMap(([id]) =>
            options.metrics.map((metric, slot) =>
              presentScalar(finishMetric(metric, group.pivots.get(id)?.[slot])),
            ),
          )
        : options.metrics.map((metric, slot) =>
            presentScalar(finishMetric(metric, group.metrics[slot])),
          )),
    ]);
    if (rows.length === 0 && set.columns.length === 0 && !hasPivot)
      rows.push(
        options.metrics.map((metric) => finishMetric(metric, undefined)),
      );
    const returnedMatchedRows = page.reduce(
      (sum, group) => sum + group.rows,
      0,
    );
    const collisions = new Map<string, Set<string>>();
    for (const group of ordered) {
      const label = JSON.stringify(
        group.key.values.map((value) =>
          typeof value === "string" ? fold(value) : value,
        ),
      );
      const bucket = collisions.get(label) ?? new Set<string>();
      bucket.add(
        group.key.values
          .map((value) => String(presentScalar(value)))
          .join(" / "),
      );
      collisions.set(label, bucket);
    }
    for (const bucket of collisions.values())
      if (bucket.size > 1)
        warnings.push(
          `Groups ${[...bucket].map((entry) => `'${entry}'`).join(" and ")} differ only by case or accent.`,
        );
    return {
      columns,
      rows,
      groupCount: ordered.length,
      returnedGroups: page.length,
      returnedMatchedRows,
      omittedMatchedRows: matchedRows - returnedMatchedRows,
      ...(set.ungroupedRows === 0 ? {} : { ungroupedRows: set.ungroupedRows }),
      ...(hasPivot
        ? { pivotBy: pivotColumns.map((entry) => entry.description) }
        : {}),
      truncated,
      ...(truncated
        ? {
            truncationReason: "maxGroups" as const,
            hint:
              options.orderBy === "metric"
                ? `${ordered.length} distinct groups; the top ${page.length} in metric order were returned. Raise maxGroups (at most ${limits.maxGroupsHard}) for more, or add a where clause.`
                : `${ordered.length} distinct groups; the first ${page.length} in group order were returned. Set orderBy to "metric" with orderByMetric to get the top groups, or add a where clause.`,
          }
        : {}),
    };
  };
  const main = finishGrouping(primary);
  const sets = additional.map(finishGrouping);
  const stats: Record<string, Partial<Census>> = {};
  for (const [column, tally] of census) {
    const reported = reportCensus(tally);
    if (Object.keys(reported).length > 0)
      stats[columnToLetters(column)] = reported;
  }
  const readAs: Record<string, readonly ReadAs[]> = {};
  for (const [column, reading] of readings) {
    const described = readAsOf(reading);
    if (described.length > 0) readAs[columnToLetters(column)] = described;
    warnings.push(...readingWarnings(reading, columnToLetters(column)));
  }
  warnings.push(...conditionWarnings(conditions, "where"));
  metricColumns.forEach((entry, at) =>
    warnings.push(
      ...conditionWarnings(entry.conditions, `metrics[${at + 1}].where`),
    ),
  );
  for (const [plan, tally] of groupFailures)
    warnings.push(
      `Grouping ${plan.description.label}: ${count(tally.count, "cell", "cells")} in ${columnToLetters(plan.column)} could not be read for this key, such as ${samplesOf(tally)}; these rows are counted in ungroupedRows for each affected grouping.`,
    );
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
  if (uncachedFormulas > 0)
    warnings.push(
      `${uncachedFormulas} formula cells in the aggregated columns have no cached value; the totals exclude them.`,
    );
  return {
    sheet: sheet.name,
    range: formatRange(bounds),
    usedRange: formatRange(used),
    headerRow: options.headerRow,
    headerRowSource: options.headerRowSource,
    ...main,
    ...(sets.length === 0 ? {} : { groupingSets: sets }),
    scannedRows,
    matchedRows,
    firstScannedRow: startRow,
    blankRows,
    ...(Object.keys(stats).length === 0 ? {} : { columnStats: stats }),
    ...(Object.keys(readAs).length === 0 ? {} : { readAs }),
    ...(warnings.length === 0 ? {} : { warnings: [...new Set(warnings)] }),
  };
}

export const aggregateLimits = {
  maxGroupsDefault: limits.maxGroupsDefault,
  maxGroupsHard: limits.maxGroupsHard,
} as const;
