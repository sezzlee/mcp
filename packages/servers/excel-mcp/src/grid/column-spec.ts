import { z } from "zod";
import { limits } from "../platform/limits.js";

/**
 * Guard: a nested schema carries a few words, and the parameter that holds it
 * carries the explanation. The served JSON Schema inlines every use of a
 * shared schema, so a long description was repeated in each union branch,
 * metric and condition of four tools; none is left bare, because the docs
 * reference refuses an argument an agent would see as a name alone.
 */
export const columnRef = z.string().describe("Column.");

const tokens = z.array(z.string().min(1).max(128)).max(64);
const locale = z.string().min(2).max(64);
const numberingSystem = z.string().min(3).max(32);

export const readingHintsSchema = {
  locale: locale
    .optional()
    .describe("BCP 47 locale: separators/month names, not date order."),
  numberingSystem: numberingSystem
    .optional()
    .describe("Locale digit system, e.g. arab."),
  missingValues: tokens
    .optional()
    .describe("Missing tokens: N/A, NULL, -, —, #N/A."),
  trueValues: tokens.optional().describe("True tokens: true, yes, y, Evet, E."),
  falseValues: tokens
    .optional()
    .describe("False tokens: false, no, n, Hayır, H."),
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
      .describe("Reading type."),
    missingValues: tokens.optional().describe("Missing-text tokens."),
    decimal: z.enum([".", ","]).optional().describe("Number decimal mark."),
    group: z
      .enum(["none", ".", ",", " ", "'"])
      .optional()
      .describe("Number group mark."),
    locale: locale.optional().describe("Number/date locale."),
    numberingSystem: numberingSystem
      .optional()
      .describe("Number digit system."),
    identifiers: z
      .enum(["refuse", "read"])
      .optional()
      .describe("Number: read digit identifiers?"),
    format: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Date pattern, e.g. dd.MM.yyyy."),
    order: z
      .enum(["dmy", "mdy"])
      .optional()
      .describe("Date order if no format."),
    trueValues: tokens.optional().describe("Boolean true tokens."),
    falseValues: tokens.optional().describe("Boolean false tokens."),
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
