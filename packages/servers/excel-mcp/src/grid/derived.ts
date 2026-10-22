import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import type { MetricFunction, MetricRequest } from "./aggregate-metrics.js";

export interface DerivedTerm {
  /** One-based index into metrics. */
  readonly metric: number;
  readonly factor?: number;
  readonly scope?: "group" | "total";
}

export interface DerivedMetric {
  readonly name: string;
  readonly numerator: readonly DerivedTerm[];
  readonly denominator?: readonly DerivedTerm[];
  readonly scale?: number;
  readonly round?: number;
}

export type DerivedOutcome =
  | { readonly kind: "value"; readonly value: number | null }
  | { readonly kind: "divisionByZero" };

/**
 * Guard: a total is the metric summed over every group, which is the metric
 * over all matched rows only when the metric adds up; an average or a
 * percentile summed over groups means nothing, so it is refused.
 */
const additive = new Set<MetricFunction>([
  "count",
  "countValues",
  "countTrue",
  "countFalse",
  "sum",
]);

export function validateDerived(
  derived: readonly DerivedMetric[],
  metrics: readonly MetricRequest[],
  pivoted: boolean,
): void {
  if (derived.length === 0) return;
  if (derived.length > limits.maxDerivedMetrics)
    throw new SezzleeExcelError(
      "invalid_argument",
      `Pass at most ${limits.maxDerivedMetrics} derived metrics.`,
    );
  if (pivoted)
    throw new SezzleeExcelError(
      "invalid_argument",
      "derived cannot be combined with pivotBy.",
      "Drop pivotBy, or compute the ratio per pivot key with groupBy instead.",
    );
  const names = new Set<string>();
  for (const entry of derived) {
    if (names.has(entry.name))
      throw new SezzleeExcelError(
        "invalid_argument",
        `Two derived metrics are named '${entry.name}'.`,
      );
    names.add(entry.name);
    for (const term of [...entry.numerator, ...(entry.denominator ?? [])]) {
      const metric = metrics[term.metric - 1];
      if (metric === undefined)
        throw new SezzleeExcelError(
          "invalid_argument",
          `Derived metric '${entry.name}' names metric ${term.metric}; metrics has ${metrics.length}.`,
        );
      if (term.scope === "total" && !additive.has(metric.fn))
        throw new SezzleeExcelError(
          "invalid_argument",
          `Derived metric '${entry.name}' takes the total of ${metric.fn}, which does not add up across groups.`,
          "Use scope total only with count, countValues, countTrue, countFalse or sum.",
        );
    }
  }
}

/**
 * Rounds half away from zero at a decimal digit, as Excel's ROUND does,
 * shifting the decimal text instead of multiplying so 1.005 rounds to 1.01.
 */
export function roundTo(value: number, digits: number): number {
  const text = Math.abs(value).toString();
  if (text.includes("e")) return Number(value.toFixed(digits));
  const shifted = Math.round(Number(`${text}e${digits}`));
  const restored = String(shifted);
  /**
   * Guard: from 1e21 the shifted value prints in exponent form, and
   * `"1e+22e-2"` reads as NaN, so a large total asked for with round came back
   * null. Dividing by the exact power of ten is used only there, so every
   * value that printed as plain digits keeps the result it had.
   */
  return (
    Math.sign(value) *
    (restored.includes("e")
      ? shifted / 10 ** digits
      : Number(`${restored}e-${digits}`))
  );
}

export function computeDerived(
  entry: DerivedMetric,
  groupValue: (slot: number) => number | null,
  totalValue: (slot: number) => number | null,
): DerivedOutcome {
  const add = (terms: readonly DerivedTerm[]): number | null => {
    let sum = 0;
    for (const term of terms) {
      const slot = term.metric - 1;
      const value =
        term.scope === "total" ? totalValue(slot) : groupValue(slot);
      if (value === null) return null;
      sum += value * (term.factor ?? 1);
    }
    return sum;
  };
  const numerator = add(entry.numerator);
  if (numerator === null) return { kind: "value", value: null };
  let value = numerator;
  if (entry.denominator !== undefined) {
    const denominator = add(entry.denominator);
    if (denominator === null) return { kind: "value", value: null };
    if (denominator === 0) return { kind: "divisionByZero" };
    value = numerator / denominator;
  }
  value *= entry.scale ?? 1;
  if (!Number.isFinite(value)) return { kind: "value", value: null };
  return {
    kind: "value",
    value: entry.round === undefined ? value : roundTo(value, entry.round),
  };
}
