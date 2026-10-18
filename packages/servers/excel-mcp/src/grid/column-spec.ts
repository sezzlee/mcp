import { z } from "zod";
import { limits } from "../platform/limits.js";

export const columnRef = z
  .string()
  .describe(
    "Header text or an A1 letter such as C. Header matching folds case and accents; columnMode resolves collisions.",
  );

const tokens = z.array(z.string().min(1).max(128)).max(64);

export const readingHintsSchema = {
  locale: z
    .string()
    .min(2)
    .max(64)
    .optional()
    .describe(
      "Explicit BCP 47 locale for numeric separators, digit shapes and Gregorian month names. Unsupported locales are refused; omission never uses the host locale.",
    ),
  numberingSystem: z
    .string()
    .min(3)
    .max(32)
    .optional()
    .describe(
      "Unicode decimal numbering system, for example arab or latn. Requires locale and must be supported by the runtime.",
    ),
  missingValues: tokens
    .optional()
    .describe(
      "Replace the missing-text tokens. Defaults to N/A, NULL, -, — and #N/A with folded matching. Nulls and blank strings are always missing; [] keeps other text literal. Stored Excel errors remain errors.",
    ),
  trueValues: tokens
    .optional()
    .describe(
      "Replace true-text tokens. Defaults to true, yes, y, Evet and E with folded matching. Tokens may use any script. Numeric 0 and 1 are not inferred as booleans.",
    ),
  falseValues: tokens
    .optional()
    .describe(
      "Replace false-text tokens. Defaults to false, no, n, Hayır and H with folded matching. True, false and missing token sets must not overlap.",
    ),
} as const;

const common = {
  column: columnRef,
  missingValues: readingHintsSchema.missingValues,
};

export const columnSpecSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...common,
    type: z.literal("number"),
    decimal: z
      .enum([".", ","])
      .optional()
      .describe(
        "Decimal separator. Supply this or locale. It cannot be combined with locale.",
      ),
    group: z
      .enum(["none", ".", ",", " ", "'"])
      .optional()
      .describe(
        "Thousands separator for decimal-based reading. Defaults to '.' for decimal comma and ',' for decimal point. Cannot be combined with locale.",
      ),
    locale: readingHintsSchema.locale,
    numberingSystem: readingHintsSchema.numberingSystem,
    identifiers: z
      .enum(["refuse", "read"])
      .optional()
      .describe(
        "Whether to refuse digit strings with leading zeros or more than 15 digits. Explicit number columns default to read for compatibility; reusable profile columns always say refuse.",
      ),
  }),
  z.strictObject({
    ...common,
    type: z.literal("date"),
    format: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Closed Gregorian date pattern, for example dd.MM.yyyy or d MMMM yyyy. Supports yyyy MM M MMM MMMM dd d HH H hh h mm ss a and fixed separators. Cannot be combined with order.",
      ),
    order: z
      .enum(["dmy", "mdy"])
      .optional()
      .describe(
        "Explicit day/month order without a fixed pattern. When format and order are omitted, only unambiguous dates are accepted.",
      ),
    locale: readingHintsSchema.locale,
  }),
  z.strictObject({
    ...common,
    type: z.literal("boolean"),
    trueValues: readingHintsSchema.trueValues,
    falseValues: readingHintsSchema.falseValues,
  }),
  z.strictObject({ ...common, type: z.literal("time") }),
  z.strictObject({ ...common, type: z.literal("duration") }),
  z.strictObject({ ...common, type: z.literal("text") }),
]);

export type ColumnSpec = z.infer<typeof columnSpecSchema>;

export const columnSpecsSchema = z
  .array(columnSpecSchema)
  .min(1)
  .max(limits.maxColumnSpecs);

export interface ReadingHints {
  readonly locale?: string;
  readonly numberingSystem?: string;
  readonly missingValues?: readonly string[];
  readonly trueValues?: readonly string[];
  readonly falseValues?: readonly string[];
}

export function readingHintsOf(hints: ReadingHints): ReadingHints {
  return {
    ...(hints.locale === undefined ? {} : { locale: hints.locale }),
    ...(hints.numberingSystem === undefined
      ? {}
      : { numberingSystem: hints.numberingSystem }),
    ...(hints.missingValues === undefined
      ? {}
      : { missingValues: hints.missingValues }),
    ...(hints.trueValues === undefined ? {} : { trueValues: hints.trueValues }),
    ...(hints.falseValues === undefined
      ? {}
      : { falseValues: hints.falseValues }),
  };
}
