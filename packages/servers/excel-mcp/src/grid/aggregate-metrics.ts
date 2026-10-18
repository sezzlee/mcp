import { SezzleeExcelError } from "../platform/errors.js";
import type { CellScalar } from "./cell-value.js";
import {
  classify,
  compareWithin,
  type ComparableKind,
  type Condition,
  type NumberRead,
  type TypedCell,
} from "./predicate.js";

export const metricFunctions = [
  "count",
  "countValues",
  "countDistinct",
  "countTrue",
  "countFalse",
  "trueRatio",
  "sum",
  "avg",
  "min",
  "max",
  "stddev",
  "median",
  "p50",
  "p90",
  "percentile",
] as const;

export type MetricFunction = (typeof metricFunctions)[number];

export interface MetricRequest {
  readonly fn: MetricFunction;
  readonly column?: string;
  readonly percentile?: number;
  readonly where?: readonly Condition[];
}

interface SumState {
  sum: number;
  compensation: number;
}

export interface Samples {
  readonly values: number[];
  sorted: boolean;
}

type Extreme =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "date" | "time" | "text"; readonly value: string };

interface MetricCounts {
  counted: number;
  skipped: number;
  filtered: number;
  meaning?: MetricMeaning;
}

export interface MetricMeaning {
  readonly unit: "number" | "fraction" | "seconds";
  readonly currency: string | undefined;
  readonly mixedUnits: boolean;
  readonly mixedCurrencies: boolean;
}

export type MetricState = MetricCounts &
  (
    | { readonly kind: "count" }
    | { readonly kind: "boolean"; trueCount: number }
    | { readonly kind: "distinct"; readonly values: Set<string> }
    | { readonly kind: "sum"; readonly sums: SumState }
    | { readonly kind: "extreme"; extreme: Extreme | undefined }
    | { readonly kind: "variance"; mean: number; m2: number }
    | {
        readonly kind: "quantile";
        readonly samples: Samples;
        readonly owner: boolean;
      }
  );

export function isNumericMetric(fn: MetricFunction): boolean {
  return fn === "sum" || fn === "avg" || fn === "stddev" || isQuantile(fn);
}

export function isQuantile(fn: MetricFunction): boolean {
  return fn === "median" || fn === "p50" || fn === "p90" || fn === "percentile";
}

export function isBooleanMetric(fn: MetricFunction): boolean {
  return fn === "countTrue" || fn === "countFalse" || fn === "trueRatio";
}

export function mergeMetricMeaning(
  left: MetricMeaning | undefined,
  right: MetricMeaning | undefined,
): MetricMeaning | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return {
    unit: left.unit,
    currency: left.currency,
    mixedUnits: left.mixedUnits || right.mixedUnits || left.unit !== right.unit,
    mixedCurrencies:
      left.mixedCurrencies ||
      right.mixedCurrencies ||
      left.currency !== right.currency,
  };
}

function rememberMeaning(
  state: MetricState,
  read: Extract<NumberRead, { kind: "number" }>,
): void {
  const current = state.meaning;
  const unit = read.unit ?? "number";
  if (
    current !== undefined &&
    current.unit === unit &&
    current.currency === read.currency
  )
    return;
  state.meaning = mergeMetricMeaning(current, {
    unit,
    currency: read.currency,
    mixedUnits: false,
    mixedCurrencies: false,
  });
}

export function validateMetric(metric: MetricRequest): void {
  if (metric.fn === "percentile") {
    if (
      metric.percentile === undefined ||
      !Number.isFinite(metric.percentile) ||
      metric.percentile < 0 ||
      metric.percentile > 1
    )
      throw new SezzleeExcelError(
        "invalid_argument",
        "A percentile metric needs percentile between 0 and 1, inclusive.",
      );
  } else if (metric.percentile !== undefined) {
    throw new SezzleeExcelError(
      "invalid_argument",
      "percentile is only accepted with fn 'percentile'.",
    );
  }
  if (metric.fn !== "count" && metric.column === undefined)
    throw new SezzleeExcelError(
      "invalid_argument",
      `Metric '${metric.fn}' needs a column.`,
      "Pass column, or use fn 'count' to count rows.",
    );
}

export function metricLabel(metric: MetricRequest): string {
  const operation =
    metric.fn === "percentile" ? `percentile ${metric.percentile}` : metric.fn;
  return metric.column === undefined
    ? operation
    : `${operation}(${metric.column})`;
}

export function newMetricStates(
  metrics: readonly {
    readonly request: MetricRequest;
    readonly sampleKey: string;
  }[],
): MetricState[] {
  const samples = new Map<string, Samples>();
  return metrics.map(({ request: metric, sampleKey }): MetricState => {
    const counts: MetricCounts = { counted: 0, skipped: 0, filtered: 0 };
    switch (metric.fn) {
      case "count":
      case "countValues":
        return { ...counts, kind: "count" };
      case "countTrue":
      case "countFalse":
      case "trueRatio":
        return { ...counts, kind: "boolean", trueCount: 0 };
      case "countDistinct":
        return { ...counts, kind: "distinct", values: new Set() };
      case "sum":
      case "avg":
        return { ...counts, kind: "sum", sums: { sum: 0, compensation: 0 } };
      case "min":
      case "max":
        return { ...counts, kind: "extreme", extreme: undefined };
      case "stddev":
        return { ...counts, kind: "variance", mean: 0, m2: 0 };
      case "median":
      case "p50":
      case "p90":
      case "percentile": {
        const existing = samples.get(sampleKey);
        if (existing !== undefined)
          return {
            ...counts,
            kind: "quantile",
            samples: existing,
            owner: false,
          };
        const created: Samples = { values: [], sorted: false };
        samples.set(sampleKey, created);
        return { ...counts, kind: "quantile", samples: created, owner: true };
      }
      default: {
        const exhaustive: never = metric.fn;
        return exhaustive;
      }
    }
  });
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

function extremeOf(cell: TypedCell): Extreme | undefined {
  const number = cell.number();
  if (number.kind === "number") return { kind: "number", value: number.value };
  const date = cell.as("date");
  if (typeof date === "string" && classify(date) === "date")
    return { kind: "date", value: date };
  const time = cell.as("time");
  if (typeof time === "string" && classify(time) === "time")
    return { kind: "time", value: time };
  const value = cell.value();
  return typeof value === "string" ? { kind: "text", value } : undefined;
}

export function addMetric(
  state: MetricState,
  metric: MetricRequest,
  cell: TypedCell,
  context: {
    readonly weight: number;
    readonly caseSensitive: boolean;
    readonly address: string;
    readonly sample: () => void;
    readonly distinct: () => void;
  },
): void {
  if (metric.fn === "count") {
    state.counted += context.weight;
    return;
  }
  if (cell.missing) {
    state.skipped += context.weight;
    return;
  }
  switch (state.kind) {
    case "boolean": {
      const value = cell.as("boolean");
      if (typeof value !== "boolean") {
        state.skipped += context.weight;
        return;
      }
      state.counted += context.weight;
      if (value) state.trueCount += context.weight;
      return;
    }
    case "count":
      state.counted += context.weight;
      return;
    case "distinct": {
      state.counted += context.weight;
      const key = JSON.stringify(cell.raw);
      if (!state.values.has(key)) {
        context.distinct();
        state.values.add(key);
      }
      return;
    }
    case "extreme": {
      const candidate = extremeOf(cell);
      if (candidate === undefined) {
        state.skipped += context.weight;
        return;
      }
      state.counted += context.weight;
      if (candidate.kind === "number") {
        const read = cell.number();
        if (read.kind === "number") rememberMeaning(state, read);
      }
      if (state.extreme === undefined) {
        state.extreme = candidate;
        return;
      }
      if (state.extreme.kind !== candidate.kind)
        throw new SezzleeExcelError(
          "invalid_argument",
          `Metric '${metric.fn}' mixes ${state.extreme.kind} and ${candidate.kind} at ${context.address}.`,
          "Use a homogeneous range, or filter with where isNumber.",
        );
      const order = compareWithin(
        candidate.kind,
        candidate.value,
        state.extreme.value,
        context.caseSensitive,
      );
      if (metric.fn === "min" ? order < 0 : order > 0)
        state.extreme = candidate;
      return;
    }
    default:
      break;
  }
  const number = cell.number();
  if (number.kind !== "number") {
    state.skipped += context.weight;
    return;
  }
  state.counted += context.weight;
  rememberMeaning(state, number);
  switch (state.kind) {
    case "sum":
      accumulate(state.sums, number.value);
      return;
    case "variance": {
      const delta = finite(number.value - state.mean);
      state.mean = finite(state.mean + delta / state.counted);
      state.m2 = finite(
        state.m2 + finite(delta * finite(number.value - state.mean)),
      );
      return;
    }
    case "quantile":
      if (state.owner) {
        context.sample();
        state.samples.values.push(number.value);
      }
      return;
    default: {
      const exhaustive: never = state;
      void exhaustive;
    }
  }
}

function quantile(samples: Samples, fraction: number): CellScalar {
  if (!samples.sorted) {
    samples.values.sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    samples.sorted = true;
  }
  const position = (samples.values.length - 1) * fraction;
  const low = samples.values[Math.floor(position)];
  const high = samples.values[Math.ceil(position)];
  if (low === undefined || high === undefined) return null;
  const weight = position % 1;
  if (low === high || weight === 0) return low;
  /** Guard: a weighted average of opposite finite extremes can overflow in high - low. */
  return finite(
    low < 0 && high > 0
      ? low * (1 - weight) + high * weight
      : low + (high - low) * weight,
  );
}

export function finishMetric(
  metric: MetricRequest,
  state: MetricState | undefined,
): CellScalar {
  if (state === undefined)
    return metric.fn === "count" ||
      metric.fn === "countValues" ||
      metric.fn === "countDistinct" ||
      metric.fn === "countTrue" ||
      metric.fn === "countFalse"
      ? 0
      : null;
  switch (state.kind) {
    case "boolean":
      return metric.fn === "countTrue"
        ? state.trueCount
        : metric.fn === "countFalse"
          ? state.counted - state.trueCount
          : state.counted === 0
            ? null
            : state.trueCount / state.counted;
    case "count":
      return state.counted;
    case "distinct":
      return state.values.size;
    case "sum":
      return state.counted === 0
        ? null
        : finite(state.sums.sum + state.sums.compensation) /
            (metric.fn === "avg" ? state.counted : 1);
    case "variance":
      return state.counted < 2
        ? null
        : finite(Math.sqrt(state.m2 / (state.counted - 1)));
    case "extreme":
      return state.extreme?.value ?? null;
    case "quantile":
      return quantile(
        state.samples,
        metric.fn === "p90" ? 0.9 : (metric.percentile ?? 0.5),
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function metricKind(
  state: MetricState | undefined,
): ComparableKind | undefined {
  return state?.kind === "extreme" ? state.extreme?.kind : undefined;
}
