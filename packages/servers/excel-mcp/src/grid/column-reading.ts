import type { CellScalar } from "./cell-value.js";
import {
  DateFormat,
  orderedPatternOf,
  readDateText,
  sniffDateOrder,
  type DateOrder,
  type DateReading,
} from "./date-text.js";
import {
  markCandidates,
  readNumberText,
  sniffNumberMarks,
  type NumberMarks,
  type NumberReading,
} from "./number-text.js";
import { SezzleeExcelError } from "../platform/errors.js";
import {
  classify,
  finiteNumber,
  type ComparableKind,
  type NumberRead,
  type TypedCell,
} from "./predicate.js";

export type ColumnSpec =
  | {
      readonly column: string;
      readonly type: "number";
      readonly decimal: "." | ",";
      readonly group?: "none" | "." | "," | " " | "'" | undefined;
    }
  | { readonly column: string; readonly type: "date"; readonly format: string }
  | { readonly column: string; readonly type: "text" };

type NumberPlan =
  | {
      readonly kind: "marks";
      readonly marks: NumberMarks;
      readonly identifiers: "refuse" | "read";
    }
  | {
      readonly kind: "ambiguous";
      readonly candidates: readonly NumberMarks[];
      readonly example: string;
    }
  | { readonly kind: "off" };

type DatePlan =
  | { readonly kind: "order"; readonly order: DateOrder }
  | { readonly kind: "unordered" }
  | { readonly kind: "format"; readonly format: DateFormat }
  | { readonly kind: "ambiguous"; readonly example: string }
  | { readonly kind: "off" };

export interface ColumnReading {
  readonly number: NumberPlan;
  readonly date: DatePlan;
  readonly source: "explicit" | "sniffed";
}

export const rawReading: ColumnReading = {
  number: { kind: "off" },
  date: { kind: "off" },
  source: "sniffed",
};

export interface ColumnNeeds {
  readonly number: boolean;
  readonly date: boolean;
}

function marksOf(
  spec: Extract<ColumnSpec, { type: "number" }>,
  label: string,
): NumberMarks {
  const group = spec.group ?? (spec.decimal === "," ? "." : ",");
  if (spec.decimal === "." && group !== ".") return { decimal: ".", group };
  if (spec.decimal === "," && group !== ",") return { decimal: ",", group };
  throw new SezzleeExcelError(
    "invalid_argument",
    `columns entry '${label}': decimal and group cannot both be '${spec.decimal}'.`,
    'Pass group "none" for numbers written without a thousands separator.',
  );
}

export function explicitReading(spec: ColumnSpec): ColumnReading {
  switch (spec.type) {
    case "number":
      return {
        number: {
          kind: "marks",
          marks: marksOf(spec, spec.column),
          identifiers: "read",
        },
        date: { kind: "off" },
        source: "explicit",
      };
    case "date": {
      const compiled = DateFormat.compile(spec.format);
      if (compiled.kind === "invalid")
        throw new SezzleeExcelError(
          "invalid_argument",
          `columns entry '${spec.column}': format '${spec.format}' cannot be read: ${compiled.reason}`,
          "Build the format from yyyy, MM, M, MMM, MMMM, dd, d, HH, H, hh, h, mm, ss, a and the separators . / - : , space and T, for example dd.MM.yyyy.",
        );
      return {
        number: { kind: "off" },
        date: { kind: "format", format: compiled.format },
        source: "explicit",
      };
    }
    case "text":
      return rawReading;
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}

/**
 * Decides a column's readings from every text value it holds in the range.
 * Values the decision cannot read are left to the caller to count.
 */
export function sniffedReading(
  texts: readonly string[],
  needs: ColumnNeeds,
): ColumnReading {
  const number = needs.number ? numberPlanOf(texts) : { kind: "off" as const };
  const date = needs.date ? datePlanOf(texts) : { kind: "off" as const };
  return { number, date, source: "sniffed" };
}

function numberPlanOf(texts: readonly string[]): NumberPlan {
  const decision = sniffNumberMarks(texts);
  switch (decision.kind) {
    case "decided":
      return { kind: "marks", marks: decision.marks, identifiers: "refuse" };
    case "ambiguous":
      return decision;
    case "none":
      return { kind: "off" };
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

function datePlanOf(texts: readonly string[]): DatePlan {
  const decision = sniffDateOrder(texts);
  switch (decision.kind) {
    case "decided":
      return { kind: "order", order: decision.order };
    case "unordered":
      return decision;
    case "ambiguous":
      return decision;
    case "none":
      return { kind: "off" };
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

function agreed<T>(
  readings: readonly T[],
  same: (left: T, right: T) => boolean,
): T | undefined {
  const [first, ...rest] = readings;
  if (first === undefined) return undefined;
  return rest.every((reading) => same(first, reading)) ? first : undefined;
}

function sameNumber(left: NumberReading, right: NumberReading): boolean {
  if (left.kind !== right.kind) return false;
  return (
    left.kind !== "number" ||
    (right.kind === "number" && left.value === right.value)
  );
}

function numberText(text: string, plan: NumberPlan): NumberReading {
  switch (plan.kind) {
    case "marks":
      return readNumberText(text, plan.marks, plan.identifiers);
    case "ambiguous":
      return (
        agreed(
          plan.candidates.map((marks) => readNumberText(text, marks)),
          sameNumber,
        ) ?? { kind: "text" }
      );
    case "off": {
      const [anyMarks] = markCandidates;
      return readNumberText(text, anyMarks).kind === "identifier"
        ? { kind: "identifier" }
        : { kind: "text" };
    }
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }
}

function dateText(text: string, plan: DatePlan): DateReading {
  switch (plan.kind) {
    case "order":
      return readDateText(text, plan.order);
    case "unordered":
      return readDateText(text, "dmy");
    case "format":
      return plan.format.read(text);
    case "ambiguous": {
      const readings = (["dmy", "mdy"] as const).map((order) =>
        readDateText(text, order),
      );
      return (
        agreed(
          readings,
          (left, right) =>
            left.kind === right.kind &&
            (left.kind !== "date" ||
              (right.kind === "date" && left.iso === right.iso)),
        ) ?? { kind: "text" }
      );
    }
    case "off":
      return { kind: "text" };
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }
}

const canonicalDecimal = /^[+-]?(?:0|[1-9]\d{0,14})(?:\.\d{1,15})?$/;

function numberOf(raw: CellScalar, reading: ColumnReading): NumberRead {
  if (typeof raw === "number")
    return { kind: "number", value: finiteNumber(raw), currency: undefined };
  if (typeof raw !== "string" || classify(raw) !== "text" || raw.trim() === "")
    return { kind: "other" };
  /**
   * Guard: this bounded subset has no affix, grouping mark or identifier.
   * This common path reduced the 2-million-cell aggregate benchmark cost;
   * every other spelling still goes through the general parser's validation.
   */
  if (
    reading.number.kind === "marks" &&
    reading.number.marks.decimal === "." &&
    canonicalDecimal.test(raw)
  )
    return { kind: "number", value: Number(raw), currency: undefined };
  const read = numberText(raw, reading.number);
  switch (read.kind) {
    case "number":
      return {
        kind: "number",
        value: read.value,
        currency: read.unit.kind === "currency" ? read.unit.code : undefined,
      };
    case "identifier":
      return { kind: "identifier" };
    case "text":
      return { kind: "unreadable" };
    default: {
      const _exhaustive: never = read;
      return _exhaustive;
    }
  }
}

function as(
  raw: CellScalar,
  kind: ComparableKind,
  reading: ColumnReading,
): CellScalar {
  if (typeof raw !== "string" || classify(raw) !== "text") return raw;
  if (kind === "number") {
    const read = numberText(raw, reading.number);
    return read.kind === "number" ? read.value : raw;
  }
  if (kind === "date") {
    const read = dateText(raw, reading.date);
    return read.kind === "date" ? read.iso : raw;
  }
  return raw;
}

export function typedCell(raw: CellScalar, reading: ColumnReading): TypedCell {
  let numeric: NumberRead | undefined;
  return {
    raw,
    as: (kind) => as(raw, kind, reading),
    number: () => (numeric ??= numberOf(raw, reading)),
  };
}

export type ReadAs =
  | {
      readonly type: "number";
      readonly decimal: "." | ",";
      readonly group: NumberMarks["group"];
    }
  | { readonly type: "date" }
  | { readonly type: "date"; readonly order: DateOrder }
  | { readonly type: "date"; readonly format: string };

export function readAsOf(reading: ColumnReading): readonly ReadAs[] {
  const out: ReadAs[] = [];
  if (reading.number.kind === "marks")
    out.push({
      type: "number",
      decimal: reading.number.marks.decimal,
      group: reading.number.marks.group,
    });
  switch (reading.date.kind) {
    case "order":
      out.push({ type: "date", order: reading.date.order });
      break;
    case "unordered":
      out.push({ type: "date" });
      break;
    case "format":
      out.push({ type: "date", format: reading.date.format.pattern });
      break;
    default:
      break;
  }
  return out;
}

export function readingWarnings(
  reading: ColumnReading,
  letter: string,
): readonly string[] {
  const warnings: string[] = [];
  if (reading.number.kind === "ambiguous") {
    const decimals = [
      ...new Set(reading.number.candidates.map((marks) => marks.decimal)),
    ];
    const options = decimals
      .map(
        (decimal) =>
          `[{"column":"${letter}","type":"number","decimal":"${decimal}"}]`,
      )
      .join(" or ");
    warnings.push(
      `${letter}: values such as '${reading.number.example}' read differently with a decimal point and with a decimal comma, so they were not read as numbers. Pass columns ${options}.`,
    );
  }
  const date = reading.date;
  if (date.kind === "ambiguous") {
    const options = (["dmy", "mdy"] as const)
      .map((order) => orderedPatternOf(date.example, order))
      .filter((pattern) => pattern !== undefined)
      .map(
        (pattern) =>
          `[{"column":"${letter}","type":"date","format":"${pattern}"}]`,
      )
      .join(" or ");
    warnings.push(
      `${letter}: dates such as '${date.example}' read either day first or month first, so they were not read as dates. Pass columns ${options}.`,
    );
  }
  return warnings;
}
