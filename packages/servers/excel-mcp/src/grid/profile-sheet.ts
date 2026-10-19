import { truncateWellFormed } from "@sezzlee/file-core";
import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import {
  isCellDuration,
  presentScalarWithin,
  scalarText,
  isUncachedFormula,
  resolveCell,
  type CellScalar,
} from "./cell-value.js";
import {
  explicitReading,
  readAsOf,
  readingWarnings,
  sniffedReading,
  typedCell,
  type ColumnReading,
  type ColumnSpec,
  type ReadAs,
  type ReadingHints,
} from "./column-reading.js";
import { buildColumnIndex, resolveColumn, type ColumnMode } from "./columns.js";
import type { MergePolicy } from "./cursor.js";
import { orderedPatternOf } from "./date-text.js";
import { headerWarnings, type HeaderRowSource } from "./header.js";
import { asciiDecimalDigits } from "./locale-text.js";
import { classify, compareWithin, type CellKind } from "./predicate.js";
import { columnToLetters, formatRange } from "./range.js";
import type { SheetSource } from "./sheet.js";
import {
  selectSheetRange,
  selectionHeaders,
  visibilityOf,
  type SelectionOptions,
  type TableSelection,
  type VisibilityReport,
} from "./select-sheet.js";

export interface ProfileOptions extends ReadingHints, SelectionOptions {
  readonly sheetName?: string;
  readonly range?: string;
  readonly headerRow: number;
  readonly headerRowSource: HeaderRowSource;
  readonly columnMode: ColumnMode;
  readonly columns?: readonly ColumnSpec[];
  readonly mergedCells: MergePolicy;
  readonly maxRows?: number;
  readonly maxColumns?: number;
}

type InferredType = CellKind | "mixed";

interface Example {
  readonly value: CellScalar;
  readonly truncatedFrom?: number;
}

interface FrequentValue extends Example {
  readonly count: number;
}

interface IdentifierFacts {
  readonly likely: boolean;
  readonly count: number;
  readonly leadingZeros: boolean;
  readonly longDigits: boolean;
  readonly fixedLength: number | null;
}

interface ColumnProfile {
  readonly letter: string;
  readonly header: string | null;
  readonly inferredType: InferredType;
  readonly confidence: number;
  readonly missing: number;
  readonly missingRatio: number;
  readonly distinct:
    | { readonly count: number; readonly exact: true }
    | { readonly lowerBound: number; readonly exact: false };
  readonly min: CellScalar;
  readonly max: CellScalar;
  readonly topValues: readonly FrequentValue[];
  readonly topValuesComplete: boolean;
  readonly unreadable: {
    readonly count: number;
    readonly examples: readonly Example[];
  };
  readonly identifiers: IdentifierFacts;
  readonly readAs: readonly ReadAs[];
  readonly uncachedFormulas: number;
  readonly valuesTruncated?: boolean;
  readonly warnings?: readonly string[];
}

export interface ProfileResult {
  readonly sheet: string;
  readonly range: string;
  readonly usedRange: string;
  readonly table?: TableSelection;
  readonly visibility?: VisibilityReport;
  readonly headerRow: number;
  readonly headerRowSource: HeaderRowSource;
  readonly columnMode: "letter";
  readonly columns: readonly ColumnSpec[];
  readonly profiles: readonly ColumnProfile[];
  readonly totalRows: number;
  readonly sampledRows: number;
  readonly omittedRows: number;
  readonly totalColumns: number;
  readonly sampledColumns: number;
  readonly omittedColumns: number;
  readonly sampledCells: number;
  readonly sampling: "prefix";
  readonly samplingLimit?: "maxRows" | "maxProfileCells";
  readonly warnings?: readonly string[];
}

interface SampledColumn {
  readonly column: number;
  readonly header: string | null;
  readonly values: readonly CellScalar[];
  readonly uncachedFormulas: number;
  readonly spec: ColumnSpec | undefined;
  readonly reading: ColumnReading;
  readonly identifierReading: ColumnReading;
}

interface ObservedValue {
  readonly raw: CellScalar;
  readonly value: CellScalar;
  readonly kind: CellKind;
}

type ScalarKey = string | number | boolean;

interface CountedValue {
  readonly value: CellScalar;
  count: number;
}

const maxExampleChars = 160;
const maxExamples = 3;
const maxTopValues = 5;

function bounded(
  value: number | undefined,
  fallback: number,
  hard: number,
  name: string,
): number {
  const requested = value ?? fallback;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > hard)
    throw new SezzleeExcelError(
      "invalid_argument",
      `${name} must be an integer from 1 to ${hard}.`,
    );
  return requested;
}

function example(value: CellScalar): Example {
  const text = scalarText(value);
  return {
    value: presentScalarWithin(value, maxExampleChars),
    ...(text.length > maxExampleChars ? { truncatedFrom: text.length } : {}),
  };
}

function scalarKey(value: Exclude<CellScalar, null>): ScalarKey {
  if (typeof value !== "object") return value;
  return isCellDuration(value) ? value.durationSeconds : JSON.stringify(value);
}

/**
 * Guard: once an unseen value exceeds the distinct cap, only the proven lower
 * bound is returned. Continuing to rank the retained keys would falsely label
 * their counts as the sample's top values.
 */
function frequencies(values: readonly ObservedValue[]): {
  readonly distinct: ColumnProfile["distinct"];
  readonly topValues: readonly FrequentValue[];
  readonly complete: boolean;
} {
  const kinds = new Map<CellKind, Map<ScalarKey, CountedValue>>();
  let distinct = 0;
  let capped = false;
  for (const entry of values) {
    if (entry.value === null || capped) continue;
    const key = scalarKey(entry.value);
    const bucket = kinds.get(entry.kind) ?? new Map<ScalarKey, CountedValue>();
    const existing = bucket.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    if (distinct === limits.maxProfileDistinct) {
      capped = true;
      continue;
    }
    bucket.set(key, { value: entry.value, count: 1 });
    kinds.set(entry.kind, bucket);
    distinct += 1;
  }
  if (capped)
    return {
      distinct: { lowerBound: distinct + 1, exact: false },
      topValues: [],
      complete: false,
    };
  const ranked = [...kinds.values()].flatMap((bucket) => [...bucket.values()]);
  ranked.sort((left, right) => {
    if (left.count !== right.count) return right.count - left.count;
    const aKind = classify(left.value);
    const bKind = classify(right.value);
    if (aKind !== bKind) return aKind < bKind ? -1 : 1;
    const a = left.value === null ? "" : scalarKey(left.value);
    const b = right.value === null ? "" : scalarKey(right.value);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return {
    distinct: { count: distinct, exact: true },
    topValues: ranked.slice(0, maxTopValues).map((entry) => ({
      ...example(entry.value),
      count: entry.count,
    })),
    complete: true,
  };
}

function identifierFacts(
  values: readonly ObservedValue[],
  reading: ColumnReading,
): IdentifierFacts {
  let count = 0;
  let leadingZeros = false;
  let longDigits = false;
  let fixedLength: number | undefined;
  let varyingLength = false;
  for (const entry of values) {
    if (entry.value === null || typeof entry.raw !== "string") continue;
    const text = entry.raw.trim();
    let length = 0;
    for (const _character of text) length += 1;
    if (fixedLength === undefined) fixedLength = length;
    else if (fixedLength !== length) varyingLength = true;
    if (typedCell(entry.raw, reading).number().kind !== "identifier") continue;
    count += 1;
    const normalized = asciiDecimalDigits(text).replace(/^[+-]/u, "");
    if (/^0[0-9]+$/u.test(normalized)) leadingZeros = true;
    let digits = 0;
    for (const character of normalized)
      if (character >= "0" && character <= "9") digits += 1;
    if (digits > 15) longDigits = true;
  }
  return {
    likely: count > 0,
    count,
    leadingZeros,
    longDigits,
    fixedLength: varyingLength ? null : (fixedLength ?? null),
  };
}

function inferred(
  values: readonly ObservedValue[],
  ambiguous: boolean,
): { readonly type: InferredType; readonly confidence: number } {
  const counts = new Map<CellKind, number>();
  let nonmissing = 0;
  for (const entry of values) {
    if (entry.kind === "empty") continue;
    nonmissing += 1;
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  }
  if (nonmissing === 0) return { type: "empty", confidence: 0 };
  if (ambiguous) return { type: "mixed", confidence: 0 };
  let winner: CellKind = "empty";
  let matched = 0;
  for (const [kind, count] of counts) {
    if (count > matched) {
      winner = kind;
      matched = count;
    }
  }
  if (matched * 2 <= nonmissing) return { type: "mixed", confidence: 0 };
  return { type: winner, confidence: matched / nonmissing };
}

function compare(
  type: InferredType,
  left: CellScalar,
  right: CellScalar,
): number | undefined {
  switch (type) {
    case "number":
    case "date":
    case "time":
    case "text":
      return compareWithin(type, left, right, true);
    case "boolean":
      return Number(left) - Number(right);
    case "duration":
      return isCellDuration(left) && isCellDuration(right)
        ? left.durationSeconds - right.durationSeconds
        : undefined;
    case "error":
    case "image":
    case "linkedValue":
    case "empty":
    case "mixed":
      return undefined;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function reusableDate(
  sample: SampledColumn,
  base: Extract<ColumnSpec, { readonly type: "date" }>,
  hints: ReadingHints,
): Extract<ColumnSpec, { readonly type: "date" }> | undefined {
  const dates = sample.values.map((raw) =>
    typedCell(raw, sample.reading).as("date"),
  );
  const equivalent = (spec: ColumnSpec): boolean => {
    const reading = explicitReading(spec, hints);
    return sample.values.every(
      (raw, at) => typedCell(raw, reading).as("date") === dates[at],
    );
  };
  if (equivalent(base)) return base;
  const decision = readAsOf(sample.reading).find(
    (entry) => entry.type === "date" && "order" in entry,
  );
  if (decision === undefined || !("order" in decision)) return undefined;
  const order = decision.order;
  if (order === undefined) return undefined;
  const tried = new Set<string>();
  for (const raw of sample.values) {
    if (typeof raw !== "string") continue;
    const pattern = orderedPatternOf(raw, order);
    if (pattern === undefined) continue;
    const format = pattern.replace("dd", "d").replace("MM", "M");
    if (tried.has(format)) continue;
    tried.add(format);
    const spec = { ...base, format };
    if (equivalent(spec)) return spec;
  }
  return undefined;
}

function reusable(
  sample: SampledColumn,
  type: InferredType,
  identifiers: IdentifierFacts,
  hints: ReadingHints,
): ColumnSpec {
  const column = columnToLetters(sample.column);
  const missingValues = sample.spec?.missingValues ?? hints.missingValues;
  const common = {
    column,
    ...(missingValues === undefined
      ? {}
      : { missingValues: [...missingValues] }),
  };
  const readings = readAsOf(sample.reading);
  const locale =
    sample.spec?.type === "date"
      ? (sample.spec.locale ?? hints.locale)
      : hints.locale;
  const language = locale === undefined ? {} : { locale };
  if (sample.spec?.type === "date")
    return { ...sample.spec, ...common, ...language };
  if (type === "number" && !identifiers.likely) {
    const reading = readings.find((entry) => entry.type === "number");
    if (reading !== undefined && "locale" in reading)
      return {
        ...common,
        type: "number",
        locale: reading.locale,
        numberingSystem: reading.numberingSystem,
        identifiers: "refuse",
      };
    if (reading !== undefined)
      return { ...reading, ...common, identifiers: "refuse" };
    return {
      ...common,
      type: "number",
      decimal: ".",
      group: "none",
      identifiers: "refuse",
    };
  }
  if (type === "date") {
    return (
      reusableDate(sample, { ...common, type: "date", ...language }, hints) ?? {
        ...common,
        type: "text",
      }
    );
  }
  if (type === "boolean") {
    const explicit = sample.spec?.type === "boolean" ? sample.spec : undefined;
    const trueValues = explicit?.trueValues ?? hints.trueValues;
    const falseValues = explicit?.falseValues ?? hints.falseValues;
    return {
      ...common,
      type: "boolean",
      ...(trueValues === undefined ? {} : { trueValues: [...trueValues] }),
      ...(falseValues === undefined ? {} : { falseValues: [...falseValues] }),
    };
  }
  if (type === "time" || type === "duration") return { ...common, type };
  return { ...common, type: "text" };
}

function describeColumn(
  sample: SampledColumn,
  hints: ReadingHints,
): { readonly profile: ColumnProfile; readonly spec: ColumnSpec } {
  const letter = columnToLetters(sample.column);
  const values = sample.values.map((raw): ObservedValue => {
    const value = typedCell(raw, sample.reading).value();
    return { raw, value, kind: classify(value) };
  });
  const ambiguous =
    sample.reading.number.kind === "ambiguous" ||
    sample.reading.date.kind === "ambiguous";
  const decision = inferred(values, ambiguous);
  const identifiers = identifierFacts(values, sample.identifierReading);
  const spec = reusable(sample, decision.type, identifiers, hints);
  const requestedDate = sample.spec?.type === "date";
  const frequency = frequencies(values);
  const missing = values.filter((entry) => entry.value === null).length;
  let min: CellScalar = null;
  let max: CellScalar = null;
  let unreadable = 0;
  const examples: Example[] = [];
  for (const entry of values) {
    if (entry.value === null) continue;
    const cannotRead = requestedDate
      ? entry.kind !== "date"
      : ambiguous ||
        (decision.type !== "mixed" && entry.kind !== decision.type);
    if (cannotRead) {
      unreadable += 1;
      if (examples.length < maxExamples) examples.push(example(entry.raw));
    }
    if (entry.kind !== decision.type) continue;
    if (compare(decision.type, entry.value, entry.value) === undefined)
      continue;
    if (min === null || (compare(decision.type, entry.value, min) ?? 0) < 0)
      min = entry.value;
    if (max === null || (compare(decision.type, entry.value, max) ?? 0) > 0)
      max = entry.value;
  }
  const warnings = readingWarnings(sample.reading, letter).map((warning) =>
    truncateWellFormed(warning, limits.maxStringChars),
  );
  if (!frequency.complete)
    warnings.push(
      `Distinct values exceeded ${limits.maxProfileDistinct} in the sample; the distinct count is a lower bound and top values are omitted.`,
    );
  if (decision.type === "mixed" && !ambiguous)
    warnings.push(
      "No type has a strict majority of non-missing sample values.",
    );
  if (identifiers.likely)
    warnings.push(
      "Identifier-like text was observed; reusable columns keep this column as text.",
    );
  if (decision.type === "date" && spec.type === "text")
    warnings.push(
      "No single reusable date format preserves the sampled dates; reusable columns keep this column as text. Choose an explicit date format or normalize the source before calendar analysis.",
    );
  if (sample.uncachedFormulas > 0)
    warnings.push(
      `${sample.uncachedFormulas} formula cells have no cached value and are counted as missing.`,
    );
  const low = example(min);
  const high = example(max);
  const clipped =
    low.truncatedFrom !== undefined ||
    high.truncatedFrom !== undefined ||
    frequency.topValues.some((entry) => entry.truncatedFrom !== undefined) ||
    examples.some((entry) => entry.truncatedFrom !== undefined);
  return {
    profile: {
      letter,
      header: sample.header,
      inferredType: decision.type,
      confidence: decision.confidence,
      missing,
      missingRatio: values.length === 0 ? 0 : missing / values.length,
      distinct: frequency.distinct,
      min: low.value,
      max: high.value,
      topValues: frequency.topValues,
      topValuesComplete: frequency.complete,
      unreadable: { count: unreadable, examples },
      identifiers,
      readAs:
        decision.type === "date" || requestedDate
          ? spec.type === "date"
            ? readAsOf(explicitReading(spec, hints))
            : []
          : readAsOf(sample.reading).filter(
              (entry) => entry.type === decision.type,
            ),
      uncachedFormulas: sample.uncachedFormulas,
      ...(clipped ? { valuesTruncated: true } : {}),
      ...(warnings.length === 0 ? {} : { warnings }),
    },
    spec,
  };
}

export function profileSheet(
  source: SheetSource,
  options: ProfileOptions,
): ProfileResult {
  const maxRows = bounded(
    options.maxRows,
    limits.maxProfileRowsDefault,
    limits.maxProfileRowsHard,
    "maxRows",
  );
  const maxColumns = bounded(
    options.maxColumns,
    limits.maxProfileColumnsDefault,
    limits.maxProfileColumnsHard,
    "maxColumns",
  );
  const selected = selectSheetRange(source, options);
  const { sheet, used, bounds } = selected;
  const headers = selectionHeaders(selected, options.headerRow, {
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
  const explicit = new Map<
    number,
    { readonly spec: ColumnSpec; readonly reading: ColumnReading }
  >();
  for (const spec of options.columns ?? []) {
    const column = resolveColumn(index, spec.column, options.columnMode);
    if (explicit.has(column))
      throw new SezzleeExcelError(
        "invalid_argument",
        `columns names ${columnToLetters(column)} twice.`,
        "Give each column one entry.",
      );
    explicit.set(column, { spec, reading: explicitReading(spec, options) });
  }
  const startRow =
    options.headerRow >= bounds.top && options.headerRow <= bounds.bottom
      ? options.headerRow + 1
      : bounds.top;
  const visibility =
    options.visibleOnly === true
      ? visibilityOf(selected, startRow, bounds.bottom)
      : undefined;
  const totalRows =
    Math.max(0, bounds.bottom - startRow + 1) -
    (visibility?.hiddenRowsSkipped ?? 0);
  const totalColumns = bounds.right - bounds.left + 1;
  const sampledColumns = Math.min(totalColumns, maxColumns);
  const cellBoundRows = Math.floor(limits.maxProfileCells / sampledColumns);
  const sampledRows = Math.min(totalRows, maxRows, cellBoundRows);
  const sampleRows: number[] = [];
  for (
    let row = startRow;
    row <= bounds.bottom && sampleRows.length < sampledRows;
    row += 1
  ) {
    if (options.visibleOnly === true && sheet.hiddenRows.has(row)) continue;
    sampleRows.push(row);
  }
  const results: {
    readonly profile: ColumnProfile;
    readonly spec: ColumnSpec;
  }[] = [];
  for (let offset = 0; offset < sampledColumns; offset += 1) {
    const column = bounds.left + offset;
    const values: CellScalar[] = [];
    let uncachedFormulas = 0;
    for (const row of sampleRows) {
      const snapshot = sheet.rowAt(row)?.cellAt(column);
      if (snapshot === undefined) {
        values.push(null);
        continue;
      }
      const covered = snapshot.merged && options.mergedCells === "master";
      if (!covered && isUncachedFormula(snapshot)) uncachedFormulas += 1;
      values.push(
        resolveCell(snapshot, {
          valueMode: "values",
          mergePolicy: options.mergedCells,
        }),
      );
    }
    const entry = explicit.get(column);
    const reading =
      entry?.reading ??
      sniffedReading(
        values.filter((value): value is string => typeof value === "string"),
        { number: true, date: true, boolean: true, time: true, duration: true },
        options,
      );
    const identifierReading =
      entry?.spec.type === "number"
        ? explicitReading({ ...entry.spec, identifiers: "refuse" }, options)
        : reading;
    results.push(
      describeColumn(
        {
          column,
          header: headers[offset] ?? null,
          values,
          uncachedFormulas,
          spec: entry?.spec,
          reading,
          identifierReading,
        },
        options,
      ),
    );
  }
  const warnings = [
    ...headerWarnings(
      sheet,
      bounds,
      options.headerRow,
      headers,
      options.range !== undefined || selected.table !== undefined,
      options.mergedCells,
    ),
  ];
  if (sampledRows < totalRows)
    warnings.push(
      "Statistics and confidence describe only the sampled prefix; later rows can contain other types or values.",
    );
  if (sampledColumns < totalColumns)
    warnings.push(
      `${totalColumns - sampledColumns} columns were not profiled; narrow range or increase maxColumns for their profiles.`,
    );
  return {
    sheet: sheet.name,
    range: formatRange(bounds),
    usedRange: formatRange(used),
    ...(selected.table === undefined ? {} : { table: selected.table }),
    ...(visibility === undefined ? {} : { visibility }),
    headerRow: options.headerRow,
    headerRowSource: options.headerRowSource,
    columnMode: "letter",
    columns: results.map((entry) => entry.spec),
    profiles: results.map((entry) => entry.profile),
    totalRows,
    sampledRows,
    omittedRows: totalRows - sampledRows,
    totalColumns,
    sampledColumns,
    omittedColumns: totalColumns - sampledColumns,
    sampledCells: sampledRows * sampledColumns,
    sampling: "prefix",
    ...(sampledRows === totalRows
      ? {}
      : {
          samplingLimit:
            cellBoundRows < maxRows
              ? ("maxProfileCells" as const)
              : ("maxRows" as const),
        }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
