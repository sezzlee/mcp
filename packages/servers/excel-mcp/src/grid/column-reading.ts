import { fold } from "@sezzlee/file-core";
import {
  isCellDuration,
  type CellNumericMeaning,
  type CellScalar,
} from "./cell-value.js";
import type { ColumnSpec, ReadingHints } from "./column-spec.js";
import {
  readDurationText,
  readTimeText,
  sniffTemporal,
} from "./temporal-text.js";
import {
  DateFormat,
  DateLocale,
  isDottedDate,
  orderedPatternOf,
  readDateText,
  sniffDateOrder,
  type DateOrder,
  type DateReading,
} from "./date-text.js";
import {
  NumberLocale,
  markCandidates,
  readNumberText,
  sniffNumberMarks,
  type NumberMarks,
  type NumberReading,
} from "./number-text.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { boundedMemo } from "./memo.js";
import { warning, type Warning } from "./warnings.js";
import {
  classify,
  finiteNumber,
  type ReadableKind,
  type NumberRead,
  type TypedCell,
} from "./predicate.js";

export type { ColumnSpec, ReadingHints } from "./column-spec.js";

type NumberPlan =
  | {
      readonly kind: "marks";
      readonly marks: NumberMarks;
      readonly identifiers: "refuse" | "read";
    }
  | {
      readonly kind: "locale";
      readonly locale: NumberLocale;
      readonly identifiers: "refuse" | "read";
      readonly contradiction?: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly candidates: readonly NumberMarks[];
      readonly example: string;
    }
  | { readonly kind: "off" };

type DatePlan =
  | {
      readonly kind: "order";
      readonly order: DateOrder;
      readonly dottedDayFirst?: string;
    }
  | { readonly kind: "unordered" }
  | { readonly kind: "format"; readonly format: DateFormat }
  | {
      readonly kind: "locale";
      readonly locale: DateLocale;
      readonly order?: DateOrder;
      readonly orderedDots?: boolean;
      readonly dottedDayFirst?: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly example: string;
      readonly orderedDots: boolean;
      readonly locale?: DateLocale;
    }
  | { readonly kind: "off" };

interface Tokens {
  readonly missing: ReadonlySet<string>;
  readonly yes: ReadonlySet<string>;
  readonly no: ReadonlySet<string>;
  readonly maxMissingLength: number;
  readonly maxBooleanLength: number;
}

export interface ColumnReading {
  readonly number: NumberPlan;
  readonly date: DatePlan;
  readonly time: boolean;
  readonly duration: boolean;
  readonly boolean: boolean;
  readonly tokens: Tokens;
  readonly target?: ColumnSpec["type"];
}

const defaultMissing = ["N/A", "NULL", "-", "—", "#N/A"];
const defaultTrue = ["true", "yes", "y", "Evet", "E"];
const defaultFalse = ["false", "no", "n", "Hayır", "H"];

function tokenSet(
  values: readonly string[],
  label: string,
): ReadonlySet<string> {
  if (
    values.length > 64 ||
    values.some((value) => value.length > 128 || value.trim() === "")
  )
    throw new SezzleeExcelError(
      "invalid_argument",
      `${label} accepts at most 64 nonblank tokens of at most 128 characters.`,
    );
  return new Set(values.map((value) => fold(value.trim())));
}

interface TokenList {
  readonly tokens: ReadonlySet<string>;
  readonly explicit: boolean;
}

function tokenList(
  values: readonly string[] | undefined,
  defaults: readonly string[],
  label: string,
): TokenList {
  return {
    tokens: tokenSet(values ?? defaults, label),
    explicit: values !== undefined,
  };
}

/**
 * Guard: a caller's list takes its words from the defaults of the other two,
 * so `missingValues: ["N"]` does not collide with the default false token
 * `n`. Only two lists the caller wrote can overlap, and that is refused.
 */
function tokensOf(hints: ReadingHints): Tokens {
  const lists = {
    missing: tokenList(hints.missingValues, defaultMissing, "missingValues"),
    yes: tokenList(hints.trueValues, defaultTrue, "trueValues"),
    no: tokenList(hints.falseValues, defaultFalse, "falseValues"),
  };
  const claimed = Object.values(lists).flatMap((list) =>
    list.explicit ? [list.tokens] : [],
  );
  if (
    claimed.some((tokens, at) =>
      claimed
        .slice(at + 1)
        .some((other) => [...tokens].some((token) => other.has(token))),
    )
  )
    throw new SezzleeExcelError(
      "invalid_argument",
      "missingValues, trueValues and falseValues overlap after case/accent folding.",
    );
  const settled = (list: TokenList): ReadonlySet<string> =>
    list.explicit
      ? list.tokens
      : new Set(
          [...list.tokens].filter(
            (token) => !claimed.some((tokens) => tokens.has(token)),
          ),
        );
  const missing = settled(lists.missing);
  const yes = settled(lists.yes);
  const no = settled(lists.no);
  return {
    missing,
    yes,
    no,
    maxMissingLength: Math.max(0, ...[...missing].map((value) => value.length)),
    maxBooleanLength: Math.max(
      0,
      ...[...yes, ...no].map((value) => value.length),
    ),
  };
}

const defaultTokens = tokensOf({});

export const rawReading: ColumnReading = {
  number: { kind: "off" },
  date: { kind: "off" },
  time: false,
  duration: false,
  boolean: false,
  tokens: defaultTokens,
};

export function rawReadingFor(hints: ReadingHints = {}): ColumnReading {
  if (hints.numberingSystem !== undefined && hints.locale === undefined)
    throw new SezzleeExcelError(
      "invalid_argument",
      "numberingSystem requires an explicit locale.",
    );
  if (
    hints.missingValues === undefined &&
    hints.trueValues === undefined &&
    hints.falseValues === undefined
  )
    return rawReading;
  return { ...rawReading, tokens: tokensOf(hints) };
}

export interface ColumnNeeds {
  readonly number: boolean;
  readonly date: boolean;
  readonly time?: boolean;
  readonly duration?: boolean;
  readonly boolean?: boolean;
}

const compiledNumberLocale = boundedMemo(
  (locale: string, numberingSystem: string | undefined) =>
    NumberLocale.compile(locale, numberingSystem),
  (locale, numberingSystem) => JSON.stringify([locale, numberingSystem]),
  64,
);

const compiledDateLocale = boundedMemo(
  (locale: string | undefined) => DateLocale.compile(locale),
  (locale) => JSON.stringify([locale]),
  64,
);

function numberLocale(locale: string, numberingSystem?: string): NumberLocale {
  const compiled = compiledNumberLocale(locale, numberingSystem);
  if (compiled.kind === "invalid")
    throw new SezzleeExcelError("invalid_argument", compiled.reason);
  return compiled.locale;
}

function dateLocale(locale?: string): DateLocale {
  const compiled = compiledDateLocale(locale);
  if (compiled.kind === "invalid")
    throw new SezzleeExcelError("invalid_argument", compiled.reason);
  return compiled.locale;
}

function marksOf(spec: Extract<ColumnSpec, { type: "number" }>): NumberMarks {
  const decimal = spec.decimal;
  if (decimal === undefined)
    throw new SezzleeExcelError(
      "invalid_argument",
      `columns entry '${spec.column}': number requires decimal or locale.`,
    );
  const group = spec.group ?? (decimal === "," ? "." : ",");
  if (decimal === "." && group !== ".") return { decimal: ".", group };
  if (decimal === "," && group !== ",") return { decimal: ",", group };
  throw new SezzleeExcelError(
    "invalid_argument",
    `columns entry '${spec.column}': decimal and group cannot both be '${decimal}'.`,
    'Pass group "none" for numbers written without a thousands separator.',
  );
}

export function explicitReading(
  spec: ColumnSpec,
  hints: ReadingHints = {},
): ColumnReading {
  const base = {
    ...rawReadingFor({
      ...hints,
      ...(spec.missingValues === undefined
        ? {}
        : { missingValues: spec.missingValues }),
      ...(spec.type !== "boolean"
        ? {}
        : {
            ...(spec.trueValues === undefined
              ? {}
              : { trueValues: spec.trueValues }),
            ...(spec.falseValues === undefined
              ? {}
              : { falseValues: spec.falseValues }),
          }),
    }),
    target: spec.type,
  };
  switch (spec.type) {
    case "number": {
      const locale =
        spec.locale ?? (spec.decimal === undefined ? hints.locale : undefined);
      const numberingSystem =
        spec.numberingSystem ??
        (locale === undefined ? undefined : hints.numberingSystem);
      if (
        (spec.locale !== undefined &&
          (spec.decimal !== undefined || spec.group !== undefined)) ||
        (spec.numberingSystem !== undefined && locale === undefined) ||
        (locale !== undefined && spec.group !== undefined)
      )
        throw new SezzleeExcelError(
          "invalid_argument",
          `columns entry '${spec.column}': locale excludes decimal/group, and numberingSystem requires locale.`,
        );
      return {
        ...base,
        number:
          locale === undefined
            ? {
                kind: "marks",
                marks: marksOf(spec),
                identifiers: spec.identifiers ?? "read",
              }
            : {
                kind: "locale",
                locale: numberLocale(locale, numberingSystem),
                identifiers: spec.identifiers ?? "read",
              },
      };
    }
    case "date": {
      if (spec.format !== undefined && spec.order !== undefined)
        throw new SezzleeExcelError(
          "invalid_argument",
          `columns entry '${spec.column}': format and order cannot be combined.`,
        );
      if (spec.format === undefined)
        return {
          ...base,
          date: {
            kind: "locale",
            locale: dateLocale(spec.locale ?? hints.locale),
            ...(spec.order === undefined ? {} : { order: spec.order }),
          },
        };
      const compiled = DateFormat.compile(
        spec.format,
        spec.locale ?? hints.locale,
      );
      if (compiled.kind === "invalid")
        throw new SezzleeExcelError(
          "invalid_argument",
          `columns entry '${spec.column}': format '${spec.format}' cannot be read: ${compiled.reason}`,
          "Use a closed Gregorian date pattern, for example dd.MM.yyyy or d MMMM yyyy.",
        );
      return { ...base, date: { kind: "format", format: compiled.format } };
    }
    case "boolean":
      return { ...base, boolean: true };
    case "time":
      return { ...base, time: true };
    case "duration":
      return { ...base, duration: true };
    case "text":
      return base;
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
}

/** Decides bounded per-column readings; the caller counts values they cannot read. */
export function sniffedReading(
  texts: readonly string[],
  needs: ColumnNeeds,
  hints: ReadingHints = {},
): ColumnReading {
  const base = rawReadingFor(hints);
  const present = texts.filter((text) => !missingText(text, base.tokens));
  const temporal = needs.duration ? sniffTemporal(present) : "none";
  const number: NumberPlan = needs.number
    ? hints.locale === undefined
      ? numberPlanOf(present)
      : localeNumberPlan(
          present,
          numberLocale(hints.locale, hints.numberingSystem),
        )
    : { kind: "off" };
  const date: DatePlan = needs.date
    ? hints.locale === undefined
      ? datePlanOf(present)
      : localeDatePlan(present, dateLocale(hints.locale))
    : { kind: "off" };
  const duration =
    temporal === "duration" &&
    majority(
      present,
      (text) => readDurationText(text).kind === "duration",
      (text) => numberText(text, number).kind === "number",
    );
  return {
    ...base,
    number,
    date,
    time:
      !duration &&
      (needs.time === true || needs.duration === true) &&
      present.some((text) => readTimeText(text).kind === "time"),
    duration,
    boolean:
      needs.boolean === true &&
      majority(
        present,
        (text) => booleanText(text, { ...base, boolean: true }) !== undefined,
        (text) => booleanText(text, { ...base, boolean: true }) === undefined,
      ),
  };
}

/**
 * Guard: one value must not turn a whole column. A stray `100:30` in an
 * amount column, or a grade `E` that is also a Turkish yes token, would
 * otherwise re-read every other value and lose it without a warning.
 */
function majority(
  texts: readonly string[],
  supports: (text: string) => boolean,
  opposes: (text: string) => boolean,
): boolean {
  let balance = 0;
  for (const text of texts) {
    if (supports(text)) balance += 1;
    else if (opposes(text)) balance -= 1;
  }
  return balance > 0;
}

/**
 * Guard: a caller's locale names the month words, never the day/month order.
 * The order still comes from the column, so a Turkish reader who names
 * `tr-TR` for an English file cannot move `03/04/2026` into April. A decided
 * slash order must not reorder a dotted date in the same column.
 */
function localeDatePlan(
  texts: readonly string[],
  locale: DateLocale,
): DatePlan {
  const decision = sniffDateOrder(texts);
  switch (decision.kind) {
    case "decided":
      return {
        kind: "locale",
        locale,
        order: decision.order,
        orderedDots: false,
        ...dottedDayFirstOf(texts, decision.order),
      };
    case "ambiguous":
      return { ...decision, locale };
    case "unordered":
    case "none":
      return { kind: "locale", locale };
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

/**
 * Guard: a caller may name the reader's locale rather than the file's. The
 * locale still decides the separators, but a value the column's own marks
 * read as a different number is named in a warning instead of passing in
 * silence.
 */
function localeNumberPlan(
  texts: readonly string[],
  locale: NumberLocale,
): NumberPlan {
  const decision = sniffNumberMarks(texts);
  const contradiction =
    decision.kind === "decided"
      ? texts.find((text) => {
          const own = readNumberText(text, decision.marks);
          if (own.kind !== "number") return false;
          const named = locale.read(text);
          return named.kind !== "number" || named.value !== own.value;
        })
      : undefined;
  return {
    kind: "locale",
    locale,
    identifiers: "refuse",
    ...(contradiction === undefined ? {} : { contradiction }),
  };
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
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

/**
 * Guard: an inferred month-first order leaves dotted dates day first, but the
 * same order passed back as an explicit `columns` entry applies to dotted
 * dates too and moves them. The example keeps that order out of `readAs`.
 */
function dottedDayFirstOf(
  texts: readonly string[],
  order: DateOrder,
): { readonly dottedDayFirst?: string } {
  const example =
    order === "mdy"
      ? texts.find((text) => {
          if (!isDottedDate(text)) return false;
          const inferred = readDateText(text, order);
          const explicit = readDateText(text, order, true);
          return (
            inferred.kind !== explicit.kind ||
            (inferred.kind === "date" &&
              explicit.kind === "date" &&
              inferred.iso !== explicit.iso)
          );
        })
      : undefined;
  return example === undefined ? {} : { dottedDayFirst: example };
}

function datePlanOf(texts: readonly string[]): DatePlan {
  const decision = sniffDateOrder(texts);
  switch (decision.kind) {
    case "decided":
      return {
        kind: "order",
        order: decision.order,
        ...dottedDayFirstOf(texts, decision.order),
      };
    case "unordered":
      return decision;
    case "ambiguous":
      return decision;
    case "none":
      return { kind: "off" };
    default: {
      const exhaustive: never = decision;
      return exhaustive;
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
    case "locale":
      return plan.locale.read(text, plan.identifiers);
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
    case "locale":
      return plan.locale.read(text, plan.order, plan.orderedDots);
    case "ambiguous": {
      const readings = (["dmy", "mdy"] as const).map((order) =>
        plan.locale === undefined
          ? readDateText(text, order, plan.orderedDots)
          : plan.locale.read(text, order, plan.orderedDots),
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

function missingText(raw: string, tokens: Tokens): boolean {
  const text = raw.trim();
  if (text === "") return true;
  if (text.length > tokens.maxMissingLength && /^[\u0020-\u007e]*$/.test(text))
    return false;
  return tokens.missing.has(fold(text));
}

function booleanText(raw: string, reading: ColumnReading): boolean | undefined {
  if (!reading.boolean) return undefined;
  const text = raw.trim();
  if (
    text.length > reading.tokens.maxBooleanLength &&
    /^[\u0020-\u007e]*$/.test(text)
  )
    return undefined;
  const token = fold(text);
  return reading.tokens.yes.has(token)
    ? true
    : reading.tokens.no.has(token)
      ? false
      : undefined;
}

function numberOf(
  raw: CellScalar,
  reading: ColumnReading,
  meaning: CellNumericMeaning | undefined,
): NumberRead {
  if (typeof raw === "number")
    return {
      kind: "number",
      value: finiteNumber(raw),
      currency: meaning?.currency,
      ...(meaning?.unit === undefined ? {} : { unit: meaning.unit }),
    };
  if (isCellDuration(raw))
    return {
      kind: "number",
      value: finiteNumber(raw.durationSeconds),
      currency: undefined,
      unit: "seconds",
    };
  if (typeof raw !== "string") return { kind: "other" };
  if (reading.duration) {
    const duration = readDurationText(raw);
    return duration.kind === "duration"
      ? {
          kind: "number",
          value: duration.seconds,
          currency: undefined,
          unit: "seconds",
        }
      : { kind: "unreadable" };
  }
  /** Guard: this finite decimal subset contains no grouping, affix or identifier. */
  if (
    reading.number.kind === "marks" &&
    reading.number.marks.decimal === "." &&
    canonicalDecimal.test(raw)
  )
    return { kind: "number", value: Number(raw), currency: undefined };
  if (classify(raw) !== "text") return { kind: "other" };
  const read = numberText(raw, reading.number);
  switch (read.kind) {
    case "number":
      return {
        kind: "number",
        value: read.value,
        currency: read.unit.kind === "currency" ? read.unit.code : undefined,
        ...(read.unit.kind === "percent" || read.unit.kind === "permille"
          ? { unit: "fraction" as const }
          : {}),
      };
    case "identifier":
      return { kind: "identifier" };
    case "text":
      return { kind: "unreadable" };
    default: {
      const exhaustive: never = read;
      return exhaustive;
    }
  }
}

export function typedCell(
  raw: CellScalar,
  reading: ColumnReading,
  meaning?: CellNumericMeaning,
): TypedCell {
  const missing =
    raw === null ||
    (typeof raw === "string" && missingText(raw, reading.tokens));
  let numeric: NumberRead | undefined;
  const number = (): NumberRead =>
    (numeric ??= missing ? { kind: "other" } : numberOf(raw, reading, meaning));
  const as = (kind: ReadableKind): CellScalar => {
    if (missing) return null;
    if (kind === "number") {
      const read = number();
      return read.kind === "number" ? read.value : raw;
    }
    if (typeof raw !== "string") return raw;
    if (kind === "boolean") return booleanText(raw, reading) ?? raw;
    if (kind === "time" && reading.time) {
      const read = readTimeText(raw);
      return read.kind === "time" ? read.value : raw;
    }
    if (kind === "date") {
      const read = dateText(raw, reading.date);
      return read.kind === "date" ? read.iso : raw;
    }
    return raw;
  };
  const value = (): CellScalar => {
    if (missing) return null;
    if (reading.target === "text" || typeof raw !== "string") return raw;
    if (reading.duration) {
      const read = number();
      if (read.kind === "number" && read.unit === "seconds")
        return { durationSeconds: read.value };
      return raw;
    }
    for (const kind of ["boolean", "date", "time"] as const) {
      const normalized = as(kind);
      if (normalized !== raw) return normalized;
    }
    return reading.number.kind === "off" ? raw : as("number");
  };
  return { raw, missing, as, value, number };
}

export type ReadAs =
  | {
      readonly type: "number";
      readonly decimal: "." | ",";
      readonly group: NumberMarks["group"];
    }
  | { readonly type: "date" }
  | { readonly type: "date"; readonly order: DateOrder }
  | { readonly type: "date"; readonly format: string; readonly locale?: string }
  | {
      readonly type: "number";
      readonly locale: string;
      readonly numberingSystem: string;
      readonly decimal: string;
      readonly group: string;
    }
  | {
      readonly type: "date";
      readonly locale?: string;
      readonly order?: DateOrder;
    }
  | { readonly type: "boolean" | "time" | "duration" | "text" };

export function readAsOf(reading: ColumnReading): readonly ReadAs[] {
  const out: ReadAs[] = [];
  if (reading.number.kind === "marks")
    out.push({
      type: "number",
      decimal: reading.number.marks.decimal,
      group: reading.number.marks.group,
    });
  if (reading.number.kind === "locale")
    out.push({
      type: "number",
      locale: reading.number.locale.locale,
      numberingSystem: reading.number.locale.numberingSystem,
      decimal: reading.number.locale.decimal,
      group: reading.number.locale.group,
    });
  if (reading.boolean) out.push({ type: "boolean" });
  if (reading.time) out.push({ type: "time" });
  if (reading.duration) out.push({ type: "duration" });
  if (reading.target === "text") out.push({ type: "text" });
  switch (reading.date.kind) {
    case "order":
      if (reading.date.dottedDayFirst === undefined)
        out.push({ type: "date", order: reading.date.order });
      break;
    case "unordered":
      out.push({ type: "date" });
      break;
    case "locale":
      if (reading.date.dottedDayFirst !== undefined) break;
      out.push({
        type: "date",
        ...(reading.date.locale.locale === undefined
          ? {}
          : { locale: reading.date.locale.locale }),
        ...(reading.date.order === undefined
          ? {}
          : { order: reading.date.order }),
      });
      break;
    case "format":
      out.push({
        type: "date",
        format: reading.date.format.pattern,
        ...(reading.date.format.locale === undefined
          ? {}
          : { locale: reading.date.format.locale }),
      });
      break;
    default:
      break;
  }
  return out;
}

export function readingWarnings(
  reading: ColumnReading,
  letter: string,
): readonly Warning[] {
  const warnings: Warning[] = [];
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
      warning(
        "ambiguous_decimal",
        `${letter}: values such as '${reading.number.example}' read differently with a decimal point and with a decimal comma, so they were not read as numbers. Pass columns ${options}.`,
        letter,
      ),
    );
  }
  if (
    reading.number.kind === "locale" &&
    reading.number.contradiction !== undefined
  )
    warnings.push(
      warning(
        "locale_separator_conflict",
        `${letter}: values such as '${reading.number.contradiction}' read as a different number with locale ${reading.number.locale.locale} than with the column's own separators. Check that the locale names the file's language, or pass columns with an explicit decimal.`,
        letter,
      ),
    );
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
      warning(
        "ambiguous_day_order",
        `${letter}: dates such as '${date.example}' read either day first or month first, so they were not read as dates. Pass columns ${options}.`,
        letter,
      ),
    );
  }
  if (
    (date.kind === "order" || date.kind === "locale") &&
    date.dottedDayFirst !== undefined
  )
    warnings.push(
      warning(
        "mixed_date_order",
        `${letter}: slash and dash dates were read month first and dotted dates such as '${date.dottedDayFirst}' day first. An explicit order also applies to dotted dates, so readAs omits it; reuse the columns recipe from profile_sheet or pass a format to keep both readings.`,
        letter,
      ),
    );
  return warnings;
}
