import { z } from "zod";
import { toolDefinitions } from "./definitions.js";
import { rowConditions, readingHintsSchema } from "./schemas.js";
import {
  workbookVersionSchema,
  mutationReceiptSchema,
} from "../platform/versions.js";
import { sheetNameSchema, valueBlockSchema } from "../authoring/workbook.js";
import { limits } from "../platform/limits.js";

const conditions = z
  .array(
    rowConditions.element.omit({ source: true }).extend({
      op: z.enum([
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
      ]),
    }),
  )
  .max(limits.maxConditions);

const common = toolDefinitions.aggregate_sheet.inputSchema.pick({
  sheetName: true,
  range: true,
  table: true,
  visibleOnly: true,
  headerRow: true,
  columnMode: true,
  caseSensitive: true,
  columns: true,
  mergedCells: true,
  delimiter: true,
  encoding: true,
}).shape;

const selectedRows = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({
    kind: z.literal("rows"),
    rows: z
      .array(z.int().min(1).max(1_048_576))
      .min(1)
      .max(10_000)
      .refine(
        (rows) => new Set(rows).size === rows.length,
        "Rows must be unique.",
      ),
  }),
]);

const tabular = {
  ...common,
  ...readingHintsSchema,
  selectColumns: z
    .array(z.string().min(1).max(32_767))
    .min(1)
    .max(16_384)
    .optional(),
};

/** Guard: object-only unions must advertise their JSON type so tool decoders do not default nested arguments to strings. */
export const transferSelectionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("range"), ...tabular }),
    z.strictObject({
      kind: z.literal("records"),
      ...tabular,
      where: conditions.optional(),
      match: z.enum(["all", "any"]).default("all"),
      scope: selectedRows.default({ kind: "all" }),
      includeHeaders: z.boolean().default(true),
    }),
    z.strictObject({
      kind: z.literal("aggregate"),
      ...common,
      ...readingHintsSchema,
      ...toolDefinitions.aggregate_sheet.inputSchema.pick({
        groupBy: true,
        orderBy: true,
        orderByMetric: true,
        descending: true,
      }).shape,
      metrics: z
        .array(
          toolDefinitions.aggregate_sheet.inputSchema.shape.metrics.element.extend(
            {
              where: conditions.optional(),
            },
          ),
        )
        .min(1)
        .max(limits.maxMetrics),
      where: conditions.optional(),
      match: z.enum(["all", "any"]).default("all"),
    }),
  ])
  .meta({ type: "object" });

export const transferReferenceSchema = z.strictObject({
  source: workbookVersionSchema,
  selection: transferSelectionSchema,
});

export const transferSummarySchema = z.strictObject({
  kind: z.enum(["range", "records", "aggregate"]),
  sheet: z.string(),
  range: z.string(),
  scope: z.enum(["all", "rows"]),
  rows: z.int().nonnegative(),
  columns: z.int().positive(),
  cells: z.int().nonnegative(),
  headerRows: z.int().min(0).max(1),
  matchedRows: z.int().nonnegative(),
  cachedFormulas: z.int().nonnegative(),
  recalculated: z.literal(false),
  visibility: z
    .strictObject({
      basis: z.literal("savedHiddenRows"),
      hiddenRowsSkipped: z.int().nonnegative(),
      filterCriteriaReevaluated: z.literal(false),
      autoFilterRef: z.string().optional(),
    })
    .optional(),
  warnings: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        column: z.string().optional(),
      }),
    )
    .optional(),
});

export const transferReceiptSchema = mutationReceiptSchema.extend({
  transferSource: workbookVersionSchema,
  transfer: transferSummarySchema,
});

const targetSheetNameSchema = sheetNameSchema.clone({
  ...sheetNameSchema.def,
  error: () =>
    "target.sheetName is required and must be text. Use target.sheetName, never target.sheet or target.name; keep the other valid arguments unchanged.",
});

export const transferTargetSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("new"),
      sheetName: targetSheetNameSchema,
      startCell: valueBlockSchema.shape.startCell.default("A1"),
    }),
    z.strictObject({
      kind: z.literal("add_sheet"),
      source: workbookVersionSchema,
      sheetName: targetSheetNameSchema,
      startCell: valueBlockSchema.shape.startCell.default("A1"),
    }),
    z.strictObject({
      kind: z.literal("sheet"),
      source: workbookVersionSchema,
      sheetName: targetSheetNameSchema,
      startCell: valueBlockSchema.shape.startCell,
      overwrite: z.boolean().default(false),
      mapping: z
        .discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("position") }),
          z.strictObject({
            kind: z.literal("headers"),
            headerRow: z.int().min(1).max(1_048_576),
          }),
        ])
        .default({ kind: "position" }),
    }),
  ])
  .meta({ type: "object" });

export type TransferSelection = z.infer<typeof transferSelectionSchema>;
export type TransferReference = z.infer<typeof transferReferenceSchema>;
export type TransferTarget = z.infer<typeof transferTargetSchema>;
export type TransferSummary = z.infer<typeof transferSummarySchema>;
