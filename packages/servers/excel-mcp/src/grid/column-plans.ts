import {
  isCellDuration,
  presentScalarWithin,
  scalarText,
  type CellScalar,
} from "./cell-value.js";
import {
  explicitReading,
  readAsOf,
  typedCell,
  type ColumnReading,
  type ColumnSpec,
  type ReadAs,
  type ReadingHints,
} from "./column-reading.js";
import { resolveColumn, type ColumnIndex, type ColumnMode } from "./columns.js";
import { classify } from "./predicate.js";
import { columnToLetters } from "./range.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";

export interface ColumnPlan {
  readonly column: number;
  readonly letter: string;
  readonly spec: ColumnSpec;
  readonly reading: ColumnReading;
}

export function explicitPlans(
  index: ColumnIndex,
  specs: readonly ColumnSpec[] | undefined,
  mode: ColumnMode,
  hints: ReadingHints,
): ReadonlyMap<number, ColumnPlan> {
  if ((specs?.length ?? 0) > limits.maxColumnSpecs)
    throw new SezzleeExcelError(
      "invalid_argument",
      `At most ${limits.maxColumnSpecs} columns can be specified.`,
    );
  const plans = new Map<number, ColumnPlan>();
  for (const spec of specs ?? []) {
    const column = resolveColumn(index, spec.column, mode);
    if (plans.has(column))
      throw new SezzleeExcelError(
        "invalid_argument",
        `Column '${columnToLetters(column)}' is specified more than once.`,
      );
    plans.set(column, {
      column,
      letter: columnToLetters(column),
      spec,
      reading: explicitReading(spec, hints),
    });
  }
  return plans;
}

export interface TypedObservation {
  readonly value: CellScalar;
  readonly status: "read" | "missing" | "unreadable" | "identifier";
  readonly converted: boolean;
}

export function observeTyped(
  raw: CellScalar,
  plan: ColumnPlan,
): TypedObservation {
  const cell = typedCell(raw, plan.reading);
  if (cell.missing) return { value: null, status: "missing", converted: false };
  const value = cell.value();
  const type = plan.spec.type;
  if (type === "number") {
    const numeric = cell.number();
    if (numeric.kind === "identifier")
      return { value: null, status: "identifier", converted: false };
    if (numeric.kind === "number")
      return {
        value: numeric.value,
        status: "read",
        converted: typeof raw !== "number",
      };
  } else if (
    type === "text" ||
    (type === "duration" ? isCellDuration(value) : classify(value) === type)
  ) {
    return { value, status: "read", converted: value !== raw };
  }
  return { value: null, status: "unreadable", converted: false };
}

interface TypedExample {
  readonly cell: string;
  readonly value: CellScalar;
  readonly reason: "unreadable" | "identifier";
  readonly truncatedFrom?: number;
}

export interface TypedColumnReport {
  readonly column: string;
  readonly type: ColumnSpec["type"];
  readonly readAs: readonly ReadAs[];
  converted: number;
  missing: number;
  unreadable: number;
  identifiers: number;
  readonly examples: TypedExample[];
}

export function typedReports(
  plans: ReadonlyMap<number, ColumnPlan>,
): Map<number, TypedColumnReport> {
  return new Map(
    [...plans].map(([column, plan]) => [
      column,
      {
        column: plan.letter,
        type: plan.spec.type,
        readAs: readAsOf(plan.reading),
        converted: 0,
        missing: 0,
        unreadable: 0,
        identifiers: 0,
        examples: [],
      },
    ]),
  );
}

function briefExample(raw: CellScalar): {
  readonly value: CellScalar;
  readonly truncatedFrom?: number;
} {
  const text = scalarText(raw);
  return {
    value: presentScalarWithin(raw, 128),
    ...(text.length > 128 ? { truncatedFrom: text.length } : {}),
  };
}

export function recordTyped(
  report: TypedColumnReport | undefined,
  observation: TypedObservation,
  cell: string,
  raw: CellScalar,
): void {
  if (report === undefined) return;
  if (observation.converted) report.converted += 1;
  if (observation.status === "missing") report.missing += 1;
  if (
    observation.status === "unreadable" ||
    observation.status === "identifier"
  ) {
    report.unreadable += 1;
    if (observation.status === "identifier") report.identifiers += 1;
    if (report.examples.length < 3)
      report.examples.push({
        cell,
        ...briefExample(raw),
        reason: observation.status,
      });
  }
}

export type TypedReport = Omit<TypedColumnReport, "examples"> & {
  readonly examples?: readonly TypedExample[];
};

export function reportTyped(
  reports: ReadonlyMap<number, TypedColumnReport>,
): readonly TypedReport[] {
  return [...reports.values()].map(({ examples, ...report }) => ({
    ...report,
    ...(examples.length === 0 ? {} : { examples }),
  }));
}

export function reserveTyped(
  reports: ReadonlyMap<number, TypedColumnReport>,
  cells: number,
): readonly TypedReport[] {
  return [...reports.values()].map((report) => ({
    ...report,
    converted: cells,
    missing: cells,
    unreadable: cells,
    identifiers: cells,
    examples: [0, 1, 2].map(() => ({
      cell: "XFD1048576",
      value: { error: "\u0000".repeat(128) },
      reason: "unreadable",
      truncatedFrom: Number.MAX_SAFE_INTEGER,
    })),
  }));
}
