import { truncateWellFormed } from "@sezzlee/file-core";
import type { MergePolicy, ValueMode } from "./cursor.js";
import { limits } from "../platform/limits.js";

export interface CellError {
  readonly error: string;
}

export interface CellDuration {
  readonly durationSeconds: number;
}

export interface CellImage {
  readonly imageId: number;
  readonly altText?: string;
  readonly decorative?: boolean;
}

export interface LinkedValue {
  readonly type: "_linkedentity2";
  readonly displayText: string;
  readonly entityId?: string;
  readonly entityCulture?: string;
  readonly serviceId?: number;
}

export interface CellLinkedValue {
  readonly linkedValue: LinkedValue;
}

export type CellScalar =
  | string
  | number
  | boolean
  | null
  | CellError
  | CellDuration
  | CellImage
  | CellLinkedValue;

export function isCellError(value: CellScalar): value is CellError {
  return value !== null && typeof value === "object" && "error" in value;
}

export function isCellImage(value: CellScalar): value is CellImage {
  return value !== null && typeof value === "object" && "imageId" in value;
}

export function isCellLinkedValue(value: CellScalar): value is CellLinkedValue {
  return value !== null && typeof value === "object" && "linkedValue" in value;
}

export function isCellDuration(value: CellScalar): value is CellDuration {
  return (
    value !== null && typeof value === "object" && "durationSeconds" in value
  );
}

export interface CellArrayFormula {
  readonly anchor: string;
  readonly ref: string;
  readonly dynamic: boolean;
  readonly collapsed?: boolean;
}

export interface CellUnsupportedRichValue {
  readonly type: string;
  readonly supported: false;
  readonly explanation: string;
}

export type CellNote = (
  | {
      readonly kind: "formula";
      readonly formula: string;
      readonly cached: boolean;
      readonly truncatedFrom?: number;
    }
  | {
      readonly kind: "hyperlink";
      readonly href: string;
      readonly truncatedFrom?: number;
    }
  | { readonly kind: "truncated"; readonly length: number }
  | { readonly kind: "array"; readonly array: CellArrayFormula }
  | { readonly kind: "error"; readonly explanation: string }
  | ({ readonly kind: "richValue" } & CellUnsupportedRichValue)
) & {
  readonly array?: CellArrayFormula;
  readonly explanation?: string;
  readonly richValue?: CellUnsupportedRichValue;
};

export interface CellNumericMeaning {
  readonly unit?: "fraction" | "seconds";
  readonly currency?: string;
}

export interface CellFacts {
  readonly value: CellScalar;
  readonly href?: string;
  readonly meaning?: CellNumericMeaning;
}

export interface CellSnapshot {
  readonly merged: boolean;
  readonly value: CellFacts;
  readonly formula?: string;
  readonly cached?: CellFacts;
  readonly numberFormat?: string;
  readonly array?: CellArrayFormula;
  readonly unsupportedRichValue?: string;
}

export interface NormalizeOptions {
  readonly valueMode: ValueMode;
  readonly mergePolicy: MergePolicy;
  readonly includeHyperlinks: boolean;
}

export type ResolveOptions = Omit<NormalizeOptions, "includeHyperlinks">;

export interface NormalizedCell {
  readonly value: CellScalar;
  readonly note?: CellNote;
}

export const emptyCell: NormalizedCell = { value: null };

interface Presented {
  readonly value: CellScalar;
  readonly truncatedFrom?: number;
}

function clamp(
  value: CellScalar,
  maximum: number = limits.maxStringChars,
): Presented {
  if (isCellImage(value)) {
    const text = value.altText;
    return text !== undefined && text.length > maximum
      ? {
          value: { ...value, altText: truncateWellFormed(text, maximum) },
          truncatedFrom: text.length,
        }
      : { value };
  }
  if (isCellLinkedValue(value)) {
    const { displayText, entityId, entityCulture } = value.linkedValue;
    const longest = Math.max(
      displayText.length,
      entityId?.length ?? 0,
      entityCulture?.length ?? 0,
    );
    return {
      value: {
        linkedValue: {
          ...value.linkedValue,
          displayText: truncateWellFormed(displayText, maximum),
          ...(entityId === undefined
            ? {}
            : { entityId: truncateWellFormed(entityId, maximum) }),
          ...(entityCulture === undefined
            ? {}
            : { entityCulture: truncateWellFormed(entityCulture, maximum) }),
        },
      },
      ...(longest <= maximum ? {} : { truncatedFrom: longest }),
    };
  }
  if (isCellError(value))
    return value.error.length > maximum
      ? {
          value: { error: truncateWellFormed(value.error, maximum) },
          truncatedFrom: value.error.length,
        }
      : { value };
  if (typeof value !== "string" || value.length <= maximum) {
    return { value };
  }
  return {
    value: truncateWellFormed(value, maximum),
    truncatedFrom: value.length,
  };
}

/**
 * Shortens a value for the response. Only output goes through here: predicates,
 * group keys and distinct counts read `resolveCell`, so two strings sharing
 * their first `maxStringChars` characters stay distinct (query-values.spec.ts).
 */
export function presentScalar(value: CellScalar): CellScalar {
  return clamp(value).value;
}

export function presentScalarWithin(
  value: CellScalar,
  maximum: number,
): CellScalar {
  return clamp(value, maximum).value;
}

/** Full searchable text; presentation limits must be applied after matching. */
export function scalarText(value: CellScalar): string {
  if (value === null) return "";
  if (isCellImage(value)) return value.altText ?? "";
  if (isCellLinkedValue(value)) return value.linkedValue.displayText;
  if (isCellDuration(value)) return String(value.durationSeconds);
  if (isCellError(value)) return value.error;
  return String(value);
}

function noteOf(
  facts: CellFacts,
  truncatedFrom: number | undefined,
  options: NormalizeOptions,
): CellNote | undefined {
  if (facts.href !== undefined && options.includeHyperlinks) {
    return {
      kind: "hyperlink",
      href: facts.href,
      ...(truncatedFrom === undefined ? {} : { truncatedFrom }),
    };
  }
  if (truncatedFrom !== undefined) {
    return { kind: "truncated", length: truncatedFrom };
  }
  return undefined;
}

function present(facts: CellFacts, options: NormalizeOptions): NormalizedCell {
  const { value, truncatedFrom } = clamp(facts.value);
  const note = noteOf(facts, truncatedFrom, options);
  return note === undefined ? { value } : { value, note };
}

export function resolveFacts(
  snapshot: CellSnapshot,
  options: ResolveOptions,
): CellFacts {
  if (snapshot.merged && options.mergePolicy === "master") {
    return emptyCell;
  }
  const formula = snapshot.formula;
  if (formula === undefined || formula === "") {
    return snapshot.value;
  }
  if (options.valueMode === "formulas") {
    return { value: `=${formula}` };
  }
  return snapshot.cached ?? emptyCell;
}

export function resolveCell(
  snapshot: CellSnapshot,
  options: ResolveOptions,
): CellScalar {
  return resolveFacts(snapshot, options).value;
}

export function isUncachedFormula(snapshot: CellSnapshot): boolean {
  return (
    snapshot.formula !== undefined &&
    snapshot.formula !== "" &&
    snapshot.cached === undefined
  );
}

export function normalizeCell(
  snapshot: CellSnapshot,
  options: NormalizeOptions,
): NormalizedCell {
  if (snapshot.merged && options.mergePolicy === "master") {
    return emptyCell;
  }
  const formula = snapshot.formula;
  if (formula === undefined || formula === "") {
    return annotate(present(snapshot.value, options), snapshot);
  }
  const text = `=${formula}`;
  const cached = snapshot.cached !== undefined;
  if (options.valueMode === "formulas") {
    return annotate({ value: text }, snapshot);
  }
  const scalar =
    snapshot.cached === undefined
      ? { value: null, truncatedFrom: undefined }
      : clamp(snapshot.cached.value);
  if (options.valueMode === "both" || !cached || snapshot.array !== undefined) {
    return annotate(
      {
        value: scalar.value,
        note: {
          kind: "formula",
          formula: text,
          cached,
          ...(scalar.truncatedFrom === undefined
            ? {}
            : { truncatedFrom: scalar.truncatedFrom }),
        },
      },
      snapshot,
    );
  }
  return snapshot.cached === undefined
    ? emptyCell
    : annotate(present(snapshot.cached, options), snapshot);
}

function annotate(
  cell: NormalizedCell,
  snapshot: CellSnapshot,
): NormalizedCell {
  const { array, unsupportedRichValue } = snapshot;
  const richValue: CellUnsupportedRichValue | undefined =
    unsupportedRichValue === undefined
      ? undefined
      : {
          type: truncateWellFormed(unsupportedRichValue, limits.maxStringChars),
          supported: false,
          explanation:
            "This rich value type is not supported; the stored compatibility value is returned without expanding or refreshing linked data.",
        };
  const explanation = isCellError(cell.value)
    ? cell.value.error === "#SPILL!"
      ? "The stored array formula could not spill. This reader returns the saved error and does not calculate results or infer the blocking cause."
      : cell.value.error === "#CALC!"
        ? "Excel stored a calculation error. This reader returns the saved error and does not recalculate the formula."
        : undefined
    : undefined;
  if (cell.note !== undefined)
    return {
      ...cell,
      note: {
        ...cell.note,
        ...(array === undefined ? {} : { array }),
        ...(explanation === undefined ? {} : { explanation }),
        ...(richValue === undefined ? {} : { richValue }),
      },
    };
  if (richValue !== undefined)
    return {
      ...cell,
      note: {
        kind: "richValue",
        ...richValue,
        ...(array === undefined ? {} : { array }),
      },
    };
  if (explanation !== undefined)
    return {
      ...cell,
      note: {
        kind: "error",
        explanation,
        ...(array === undefined ? {} : { array }),
      },
    };
  return array === undefined
    ? cell
    : { ...cell, note: { kind: "array", array } };
}
