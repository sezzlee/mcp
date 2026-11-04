import { z } from "zod";
import { limits } from "../platform/limits.js";
import { encodingNames } from "../platform/delimited.js";
import { dateParts } from "../grid/grouping.js";

export const filePath = z.string().describe("Path under the root.");
export const sheetName = z
  .string()
  .optional()
  .describe("Sheet; default first visible.");
export const table = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe("XLSX table: data rows, not range.");
export const visibleOnly = z
  .boolean()
  .optional()
  .describe("XLSX: skip hidden/AutoFilter rows.");
export { columnRef, readingHintsSchema } from "../grid/column-spec.js";
import { columnRef, columnSpecsSchema } from "../grid/column-spec.js";

export const groupAxis = z
  .array(
    z.union([
      columnRef,
      z.strictObject({ column: columnRef, by: z.enum(dateParts) }),
      z.strictObject({
        column: columnRef,
        bins: z.array(z.number()).min(1).max(limits.maxGroupBins),
      }),
      z.strictObject({
        column: columnRef,
        width: z.number().min(Number.MIN_VALUE),
        origin: z.number().optional(),
      }),
    ]),
  )
  .max(limits.maxMetrics);

export const groupAxisForms =
  "Keys: column; {column,by} UTC part (month includes year, ISO week, Monday=1); {column,bins} or {column,width,origin?} for [lower,upper) bins.";

export const rowConditions = z
  .array(
    z.strictObject({
      column: columnRef,
      op: z
        .enum([
          "eq",
          "ne",
          "lt",
          "lte",
          "gt",
          "gte",
          "contains",
          "startsWith",
          "endsWith",
          "in",
          "between",
          "isEmpty",
          "isNotEmpty",
          "isError",
          "isNumber",
          "isText",
          "inColumn",
          "notInColumn",
        ])
        .describe("Operator."),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .optional()
        .describe("Operand."),
      values: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .min(1)
        .max(limits.maxInValues)
        .optional()
        .describe("Operands of in, or [low, high] of between."),
      source: z
        .strictObject({
          filePath: z.string().optional().describe("Defaults to this file."),
          sheetName: z.string().optional().describe("Source sheet."),
          column: columnRef,
          range: z.string().optional().describe("Source range."),
          headerRow: z.int().min(0).optional().describe("Source header row."),
        })
        .optional()
        .describe("Column inColumn and notInColumn test against."),
    }),
  )
  .max(limits.maxConditions);

export const rowConditionForms =
  "Filters {column,op,value?,values?,source?}. Comparison/text/isError take value; in takes values; between takes [low,high]; other unary ops take neither. inColumn/notInColumn use source with eq semantics. Incomparable cells are reported.";

export const drawingKind = z
  .enum(["picture", "chart", "pivotTable", "sparkline"])
  .optional()
  .describe("Only picture is read here; charts are get_charts'.");

export const delimiter = z
  .enum(["comma", "semicolon", "tab", "pipe"])
  .optional()
  .describe("CSV separator; sniffed when omitted.");

export const encoding = z
  .enum(encodingNames)
  .optional()
  .describe("CSV encoding; BOM or utf-8 when omitted.");

export const columnSpecs = columnSpecsSchema
  .optional()
  .describe("Readings {column,type,...}; reuse profile_sheet.");
