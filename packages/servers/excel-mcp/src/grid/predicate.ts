import { fold } from "@sezzlee/file-core";
import {
  isCellDuration,
  isCellImage,
  isCellLinkedValue,
  type CellError,
  type CellScalar,
} from "./cell-value.js";
import { isCanonicalDate, orderOfDate, readDateText } from "./date-text.js";
import { isCanonicalTime } from "./temporal-text.js";
import { SezzleeExcelError } from "../platform/errors.js";

export type CellKind =
  | "number"
  | "duration"
  | "date"
  | "time"
  | "text"
  | "boolean"
  | "image"
  | "linkedValue"
  | "error"
  | "empty";

export type ComparableKind = "number" | "date" | "time" | "text";

export type ReadableKind = ComparableKind | "boolean";

export type ReadingNeed = ReadableKind | "duration";

export const kindPrecedence: readonly CellKind[] = [
  "number",
  "duration",
  "date",
  "time",
  "text",
  "boolean",
  "image",
  "linkedValue",
  "error",
  "empty",
];

export function classify(value: CellScalar): CellKind {
  if (value === null) {
    return "empty";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "object") {
    if (isCellImage(value)) return "image";
    if (isCellLinkedValue(value)) return "linkedValue";
    return isCellDuration(value) ? "duration" : "error";
  }
  if (isCanonicalDate(value) && readDateText(value, "dmy").kind === "date")
    return "date";
  return isCanonicalTime(value) ? "time" : "text";
}

export function finiteNumber(value: number): number {
  if (!Number.isFinite(value))
    throw new SezzleeExcelError(
      "numeric_overflow",
      "A numeric value is outside the finite number range.",
    );
  return value;
}

export type NumberRead =
  | {
      readonly kind: "number";
      readonly value: number;
      readonly currency: string | undefined;
      readonly unit?: "fraction" | "seconds";
    }
  | { readonly kind: "identifier" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "other" };

/**
 * A cell as the stored value plus its readings: `as(kind)` is the value read
 * as that kind when the column's reading allows it, else the stored value.
 */
export interface TypedCell {
  readonly raw: CellScalar;
  readonly missing: boolean;
  value(): CellScalar;
  as(kind: ReadableKind): CellScalar;
  number(): NumberRead;
}

function orderKey(
  kind: ComparableKind,
  value: CellScalar,
  caseSensitive: boolean,
): string | number {
  if (kind === "number") {
    return value as number;
  }
  if (kind === "date") {
    const text = value as string;
    return orderOfDate(text) ?? text;
  }
  if (kind === "time") {
    const text = value as string;
    return `${text.slice(0, 8)}${text.slice(9).padEnd(9, "0")}`;
  }
  return caseSensitive ? (value as string) : fold(value as string);
}

export function compareWithin(
  kind: ComparableKind,
  left: CellScalar,
  right: CellScalar,
  caseSensitive: boolean,
): number {
  const a = orderKey(kind, left, caseSensitive);
  const b = orderKey(kind, right, caseSensitive);
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export type Operator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "between"
  | "isEmpty"
  | "isNotEmpty"
  | "isError"
  | "isNumber"
  | "isText";

export type PredicateScalar = string | number | boolean;

export interface Condition {
  readonly column: string;
  readonly op: Operator;
  readonly value?: PredicateScalar;
  readonly values?: readonly PredicateScalar[];
}

export interface PredicateOptions {
  readonly caseSensitive: boolean;
}

/**
 * `incomparable` is a non-empty cell whose kind, after the column's reading,
 * differs from the operand's: it is counted and reported, never folded into
 * an ordinary miss.
 */
export type Outcome = "match" | "miss" | "incomparable";

const orderingOperators = new Set<Operator>(["lt", "lte", "gt", "gte"]);
const textOperators = new Set<Operator>(["contains", "startsWith", "endsWith"]);
const nullaryOperators = new Set<Operator>([
  "isEmpty",
  "isNotEmpty",
  "isNumber",
  "isText",
]);

function operandKind(value: PredicateScalar): CellKind {
  return classify(value);
}

function requireOperand(condition: Condition): PredicateScalar {
  if (condition.value === undefined) {
    throw new SezzleeExcelError(
      "invalid_argument",
      `Operator '${condition.op}' on column '${condition.column}' needs a value.`,
      "Pass value, or use isEmpty / isNotEmpty for blank checks.",
    );
  }
  return condition.value;
}

function comparableKindOf(
  condition: Condition,
  operand: PredicateScalar,
): ComparableKind {
  const kind = operandKind(operand);
  if (
    kind === "number" ||
    kind === "date" ||
    kind === "time" ||
    kind === "text"
  ) {
    return kind;
  }
  throw new SezzleeExcelError(
    "invalid_argument",
    `Operator '${condition.op}' on column '${condition.column}' cannot compare against a ${kind} value.`,
    "Compare against a number, an ISO date string, an HH:mm:ss time, or text.",
  );
}

export function kindsRead(condition: Condition): readonly ReadingNeed[] {
  if (condition.op === "isNumber") return ["number", "duration"];
  if (condition.op === "isText")
    return ["number", "date", "time", "duration", "boolean"];
  if (nullaryOperators.has(condition.op) || condition.op === "isError")
    return [];
  if (textOperators.has(condition.op)) return [];
  const operands =
    condition.op === "in" || condition.op === "between"
      ? (condition.values ?? [])
      : condition.value === undefined
        ? []
        : [condition.value];
  return [
    ...new Set(
      operands.flatMap<ReadingNeed>((operand) => {
        const kind = operandKind(operand);
        if (kind === "number") return ["number", "duration"] as const;
        return kind === "date" || kind === "time" || kind === "boolean"
          ? [kind]
          : [];
      }),
    ),
  ];
}

export function validateCondition(
  condition: Condition,
  caseSensitive = true,
): void {
  for (const operand of [condition.value, ...(condition.values ?? [])]) {
    if (typeof operand === "number" && !Number.isFinite(operand))
      throw new SezzleeExcelError(
        "invalid_argument",
        "Predicate numbers must be finite.",
      );
  }
  if (nullaryOperators.has(condition.op)) {
    return;
  }
  if (condition.op === "isError") {
    return;
  }
  if (condition.op === "in") {
    if (condition.values === undefined || condition.values.length === 0) {
      throw new SezzleeExcelError(
        "invalid_argument",
        `Operator 'in' on column '${condition.column}' needs a non-empty values array.`,
        "Pass values, or use eq for a single comparison.",
      );
    }
    return;
  }
  if (condition.op === "between") {
    const pair = condition.values;
    if (pair === undefined || pair.length !== 2) {
      throw new SezzleeExcelError(
        "invalid_argument",
        `Operator 'between' on column '${condition.column}' needs exactly two values.`,
        "Pass values as [low, high].",
      );
    }
    const low = pair[0];
    const high = pair[1];
    if (low === undefined || high === undefined)
      throw new SezzleeExcelError(
        "invalid_argument",
        "between needs two bounds.",
      );
    const kind = comparableKindOf(condition, low);
    if (kind !== comparableKindOf(condition, high))
      throw new SezzleeExcelError(
        "invalid_argument",
        "between bounds must have the same comparable type.",
      );
    if (compareWithin(kind, low, high, caseSensitive) > 0) {
      throw new SezzleeExcelError(
        "invalid_argument",
        `Operator 'between' on column '${condition.column}' was given a low bound above its high bound.`,
        "Swap the two values.",
      );
    }
    return;
  }
  const operand = requireOperand(condition);
  if (orderingOperators.has(condition.op)) {
    comparableKindOf(condition, operand);
  }
  if (textOperators.has(condition.op) && typeof operand !== "string") {
    throw new SezzleeExcelError(
      "invalid_argument",
      `Operator '${condition.op}' on column '${condition.column}' needs text on the right.`,
      "Pass a string, or use eq for an exact comparison.",
    );
  }
}

function verdict(hit: boolean): Outcome {
  return hit ? "match" : "miss";
}

export function evaluate(
  condition: Condition,
  cell: TypedCell,
  options: PredicateOptions,
): Outcome {
  const raw = cell.raw;
  const rawKind = classify(raw);
  const blank = cell.missing || (typeof raw === "string" && raw.trim() === "");
  const unmatched: Outcome = blank ? "miss" : "incomparable";

  switch (condition.op) {
    case "isEmpty":
      return verdict(cell.missing);
    case "isNotEmpty":
      return verdict(!cell.missing);
    case "isError":
      return verdict(
        rawKind === "error" &&
          (condition.value === undefined ||
            (raw as CellError).error === condition.value),
      );
    case "isNumber":
      return verdict(cell.number().kind === "number");
    case "isText":
      return verdict(!cell.missing && classify(cell.value()) === "text");
    default:
      break;
  }

  if (condition.op === "in") {
    const outcomes = (condition.values ?? []).map((entry) =>
      evaluate(
        { column: condition.column, op: "eq", value: entry },
        cell,
        options,
      ),
    );
    if (outcomes.includes("match")) return "match";
    return outcomes.every((outcome) => outcome === "incomparable")
      ? "incomparable"
      : "miss";
  }

  if (condition.op === "between") {
    const [low, high] = (condition.values ?? []) as [
      PredicateScalar,
      PredicateScalar,
    ];
    const bound = comparableKindOf(condition, low);
    const value = cell.as(bound);
    if (classify(value) !== bound) return unmatched;
    return verdict(
      compareWithin(bound, value, low, options.caseSensitive) >= 0 &&
        compareWithin(bound, value, high, options.caseSensitive) <= 0,
    );
  }

  const operand = requireOperand(condition);

  /**
   * Guard: a missing token such as `N/A` is still the text the caller asked
   * for when they compare against text. Treating it as missing here would
   * return no rows without a warning; `isEmpty` keeps the missing reading.
   */
  const literal = typeof raw === "string" && raw.trim() !== "";

  if (textOperators.has(condition.op)) {
    if (!literal) return unmatched;
    const haystack = options.caseSensitive ? raw : fold(raw);
    const needle = options.caseSensitive
      ? (operand as string)
      : fold(operand as string);
    if (condition.op === "contains") {
      return verdict(haystack.includes(needle));
    }
    if (condition.op === "startsWith") {
      return verdict(haystack.startsWith(needle));
    }
    return verdict(haystack.endsWith(needle));
  }

  const wanted = operandKind(operand);
  if (condition.op === "eq" || condition.op === "ne") {
    const value =
      wanted === "text" && literal
        ? raw
        : wanted === "number" ||
            wanted === "date" ||
            wanted === "time" ||
            wanted === "text" ||
            wanted === "boolean"
          ? cell.as(wanted)
          : raw;
    const kind = classify(value);
    const same =
      kind === wanted &&
      (kind === "number" || kind === "boolean"
        ? value === operand
        : compareWithin(
            kind as ComparableKind,
            value,
            operand,
            options.caseSensitive,
          ) === 0);
    if (condition.op === "ne") return verdict(!same);
    return same ? "match" : kind === wanted ? "miss" : unmatched;
  }

  const bound = comparableKindOf(condition, operand);
  const value = cell.as(bound);
  if (classify(value) !== bound) return unmatched;
  const order = compareWithin(bound, value, operand, options.caseSensitive);
  if (condition.op === "lt") {
    return verdict(order < 0);
  }
  if (condition.op === "lte") {
    return verdict(order <= 0);
  }
  if (condition.op === "gt") {
    return verdict(order > 0);
  }
  return verdict(order >= 0);
}

export interface Census {
  images?: number;
  linkedValues?: number;
  numbers: number;
  durations: number;
  dates: number;
  times: number;
  texts: number;
  booleans: number;
  errors: number;
  nulls: number;
  textNumbers: number;
  identifiers: number;
  missingLiterals: number;
}

export function emptyCensus(): Census {
  return {
    numbers: 0,
    durations: 0,
    dates: 0,
    times: 0,
    texts: 0,
    booleans: 0,
    errors: 0,
    nulls: 0,
    textNumbers: 0,
    identifiers: 0,
    missingLiterals: 0,
  };
}

/**
 * Counts a cell by its stored kind; `textNumbers` and `identifiers` count the
 * text cells among `texts` that read as a number or look like an identifier.
 */
export function record(census: Census, cell: TypedCell): CellKind {
  const kind = classify(cell.raw);
  if (cell.missing && cell.raw !== null) census.missingLiterals += 1;
  switch (kind) {
    case "number":
      census.numbers += 1;
      break;
    case "duration":
      census.durations += 1;
      break;
    case "date":
      census.dates += 1;
      break;
    case "time":
      census.times += 1;
      break;
    case "text": {
      census.texts += 1;
      const read = cell.number().kind;
      if (read === "number") census.textNumbers += 1;
      if (read === "identifier") census.identifiers += 1;
      break;
    }
    case "boolean":
      census.booleans += 1;
      break;
    case "image":
      census.images = (census.images ?? 0) + 1;
      break;
    case "linkedValue":
      census.linkedValues = (census.linkedValues ?? 0) + 1;
      break;
    case "error":
      census.errors += 1;
      break;
    case "empty":
      census.nulls += 1;
      break;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
  return kind;
}

export function reportCensus(census: Census): Partial<Census> {
  const out: Partial<Census> = {};
  for (const [key, count] of Object.entries(census) as [
    keyof Census,
    number,
  ][]) {
    if (count > 0) {
      out[key] = count;
    }
  }
  return out;
}
