import { truncateWellFormed } from "@sezzlee/file-core";
import type { MergePolicy, ValueMode } from "./cursor.js";
import { limits } from "../platform/limits.js";

export interface CellError {
  readonly error: string;
}

export interface CellDuration {
  readonly durationSeconds: number;
}

export type CellScalar =
  string | number | boolean | null | CellError | CellDuration;

export function isCellDuration(value: CellScalar): value is CellDuration {
  return (
    value !== null && typeof value === "object" && "durationSeconds" in value
  );
}

export type CellNote =
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
  | { readonly kind: "truncated"; readonly length: number };

export interface CellFacts {
  readonly value: CellScalar;
  readonly href?: string;
}

export interface CellSnapshot {
  readonly merged: boolean;
  readonly value: CellFacts;
  readonly formula?: string;
  readonly cached?: CellFacts;
  readonly numberFormat?: string;
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

function clamp(value: CellScalar): Presented {
  if (typeof value !== "string" || value.length <= limits.maxStringChars) {
    return { value };
  }
  return {
    value: truncateWellFormed(value, limits.maxStringChars),
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

export function resolveCell(
  snapshot: CellSnapshot,
  options: ResolveOptions,
): CellScalar {
  if (snapshot.merged && options.mergePolicy === "master") {
    return null;
  }
  const formula = snapshot.formula;
  if (formula === undefined || formula === "") {
    return snapshot.value.value;
  }
  if (options.valueMode === "formulas") {
    return `=${formula}`;
  }
  return snapshot.cached?.value ?? null;
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
    return present(snapshot.value, options);
  }
  const text = `=${formula}`;
  const cached = snapshot.cached !== undefined;
  if (options.valueMode === "formulas") {
    return { value: text };
  }
  const scalar =
    snapshot.cached === undefined
      ? { value: null, truncatedFrom: undefined }
      : clamp(snapshot.cached.value);
  if (options.valueMode === "both" || !cached) {
    return {
      value: scalar.value,
      note: {
        kind: "formula",
        formula: text,
        cached,
        ...(scalar.truncatedFrom === undefined
          ? {}
          : { truncatedFrom: scalar.truncatedFrom }),
      },
    };
  }
  return snapshot.cached === undefined
    ? emptyCell
    : present(snapshot.cached, options);
}
