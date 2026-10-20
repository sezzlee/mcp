import { z } from "zod";
import { limits } from "../platform/limits.js";

/**
 * Guard: a nested schema carries a few words, and the parameter that holds it
 * carries the explanation. The served JSON Schema inlines every use of a
 * shared schema, so a long description was repeated in each union branch,
 * metric and condition of four tools; none is left bare, because the docs
 * reference refuses an argument an agent would see as a name alone.
 */
export const columnRef = z.string().describe("Header text or A1 letter.");

const tokens = z.array(z.string().min(1).max(128)).max(64);
const locale = z.string().min(2).max(64);
const numberingSystem = z.string().min(3).max(32);

export const readingHintsSchema = {
  locale: locale
    .optional()
    .describe(
      "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
    ),
  numberingSystem: numberingSystem
    .optional()
    .describe("Numbering system such as arab; needs locale."),
  missingValues: tokens
    .optional()
    .describe("Missing-text tokens; default N/A, NULL, -, —, #N/A."),
  trueValues: tokens
    .optional()
    .describe("True-text tokens; default true, yes, y, Evet, E."),
  falseValues: tokens
    .optional()
    .describe("False-text tokens; default false, no, n, Hayır, H."),
} as const;

const common = {
  column: columnRef,
  missingValues: tokens.optional().describe("Missing-text tokens."),
};

export const columnSpecSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...common,
    type: z.literal("number"),
    decimal: z.enum([".", ","]).optional(),
    group: z.enum(["none", ".", ",", " ", "'"]).optional(),
    locale: locale.optional(),
    numberingSystem: numberingSystem.optional(),
    identifiers: z.enum(["refuse", "read"]).optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal("date"),
    format: z.string().min(1).max(64).optional(),
    order: z.enum(["dmy", "mdy"]).optional(),
    locale: locale.optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal("boolean"),
    trueValues: tokens.optional(),
    falseValues: tokens.optional(),
  }),
  z.strictObject({ ...common, type: z.literal("time") }),
  z.strictObject({ ...common, type: z.literal("duration") }),
  z.strictObject({ ...common, type: z.literal("text") }),
]);

export type ColumnSpec = z.infer<typeof columnSpecSchema>;

/**
 * The shape a caller sends a column specification in: one object with every
 * field, piped into the union, which accepts exactly what it did before.
 *
 * Guard: the union's six strict branches serialised to about 2.3 KB of JSON
 * Schema in each of four tools; this flat object publishes the same fields
 * once, and the pipe still refuses a field the declared type does not take.
 */
const flatColumnSpec = z
  .strictObject({
    column: columnRef,
    type: z
      .enum(["number", "date", "boolean", "time", "duration", "text"])
      .describe("How to read the column."),
    missingValues: tokens.optional().describe("Missing-text tokens."),
    decimal: z
      .enum([".", ","])
      .optional()
      .describe("Decimal separator, for number."),
    group: z
      .enum(["none", ".", ",", " ", "'"])
      .optional()
      .describe("Thousands separator, for number."),
    locale: locale.optional().describe("File locale, for number or date."),
    numberingSystem: numberingSystem
      .optional()
      .describe("Numbering system, for number."),
    identifiers: z
      .enum(["refuse", "read"])
      .optional()
      .describe("Whether to read digit identifiers, for number."),
    format: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Date pattern such as dd.MM.yyyy, for date."),
    order: z
      .enum(["dmy", "mdy"])
      .optional()
      .describe("Day/month order without a format, for date."),
    trueValues: tokens.optional().describe("True-text tokens, for boolean."),
    falseValues: tokens.optional().describe("False-text tokens, for boolean."),
  })
  .pipe(columnSpecSchema);

export const columnSpecsSchema = z
  .array(flatColumnSpec)
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
