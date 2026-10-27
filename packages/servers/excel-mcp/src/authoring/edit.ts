import { z } from "zod";
import {
  presentationChangeSchema,
  presentationLimits,
} from "./presentation.js";
import { writeCellSchema } from "./values.js";
import {
  authoringLimits,
  sheetNameSchema,
  workbookChangeSchema,
} from "./workbook.js";

const range = z
  .string()
  .min(2)
  .max(21)
  .regex(/^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$/);
const rowIndex = z.int().min(1).max(1_048_576);
export const copyModeSchema = z.enum([
  "values",
  "formulas",
  "formatting",
  "all",
]);
const sheetChanges = [
  z.strictObject({
    kind: z.literal("clear_contents"),
    sheetName: sheetNameSchema,
    range,
  }),
  z.strictObject({
    kind: z.literal("rename_sheet"),
    sheetName: sheetNameSchema,
    name: sheetNameSchema,
  }),
  z.strictObject({
    kind: z.literal("reorder_sheet"),
    sheetName: sheetNameSchema,
    position: z.int().min(1).max(authoringLimits.maxSheets),
  }),
  z.strictObject({
    kind: z.literal("delete_sheet"),
    sheetName: sheetNameSchema,
  }),
  z.strictObject({
    kind: z.literal("copy_sheet"),
    sheetName: sheetNameSchema,
    name: sheetNameSchema,
    mode: copyModeSchema,
  }),
  z.strictObject({
    kind: z.literal("copy_range"),
    sheetName: sheetNameSchema,
    range,
    targetSheet: sheetNameSchema,
    startCell: z.string().min(2).max(10),
    mode: copyModeSchema,
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("move_range"),
    sheetName: sheetNameSchema,
    range,
    targetSheet: sheetNameSchema,
    startCell: z.string().min(2).max(10),
    overwrite: z.boolean().default(false),
  }),
] as const;
const axisChanges = [
  z.strictObject({
    kind: z.literal("delete_rows"),
    sheetName: sheetNameSchema,
    at: rowIndex,
    count: z.int().min(1).max(1_000_000),
  }),
  z.strictObject({
    kind: z.literal("insert_columns"),
    sheetName: sheetNameSchema,
    at: z.int().min(1).max(16_384),
    count: z.int().min(1).max(16_384),
  }),
  z.strictObject({
    kind: z.literal("delete_columns"),
    sheetName: sheetNameSchema,
    at: z.int().min(1).max(16_384),
    count: z.int().min(1).max(16_384),
  }),
] as const;

export const editChangeSchema = z.discriminatedUnion("kind", [
  ...workbookChangeSchema.options,
  ...presentationChangeSchema.options,
  ...sheetChanges,
  z.strictObject({
    kind: z.literal("insert_rows"),
    sheetName: sheetNameSchema,
    at: rowIndex,
    count: z.int().min(1).max(1_000_000),
  }),
  ...axisChanges,
]);

export const editChangesSchema = z
  .array(editChangeSchema)
  .min(1)
  .max(authoringLimits.maxOperations);

export const insertedCellSchema = z.discriminatedUnion("kind", [
  ...writeCellSchema.options,
  z.strictObject({
    kind: z.literal("formula"),
    formula: z.string().min(1).max(presentationLimits.maxFormulaChars),
  }),
]);

export const sourceEditChangeSchema = z.discriminatedUnion("kind", [
  ...workbookChangeSchema.options,
  ...presentationChangeSchema.options,
  ...sheetChanges,
  z
    .strictObject({
      kind: z.literal("insert_rows"),
      sheetName: sheetNameSchema,
      at: rowIndex,
      count: z.int().min(1).max(1_000_000).optional(),
      startColumn: z
        .string()
        .regex(/^[A-Za-z]{1,3}$/)
        .optional(),
      values: z
        .array(z.array(insertedCellSchema).min(1).max(16_384))
        .min(1)
        .max(authoringLimits.maxCells)
        .optional(),
    })
    .refine(
      (change) =>
        (change.count === undefined) !== (change.values === undefined),
      {
        message: "Give insert_rows either count or values, not both.",
      },
    )
    .refine(
      (change) =>
        change.values !== undefined || change.startColumn === undefined,
      {
        message: "startColumn places inserted values; it requires values.",
      },
    )
    .refine(
      (change) =>
        change.values?.every(
          (row) => row.length === change.values?.[0]?.length,
        ) ?? true,
      { message: "Every inserted row must have the same width." },
    ),
  ...axisChanges,
]);

export const editFeaturesSchema = z.strictObject({
  parts: z.int().nonnegative().default(0),
  sheets: z.int().nonnegative().default(0),
  formulas: z.int().nonnegative().default(0),
  sharedFormulas: z.int().nonnegative().default(0),
  arrayFormulas: z.int().nonnegative().default(0),
  styledCells: z.int().nonnegative().default(0),
  mergedRanges: z.int().nonnegative().default(0),
  tables: z.int().nonnegative().default(0),
  charts: z.int().nonnegative().default(0),
  drawings: z.int().nonnegative().default(0),
  definedNames: z.int().nonnegative().default(0),
  externalRelationships: z.int().nonnegative().default(0),
  conditionalFormats: z.int().nonnegative().default(0),
  validations: z.int().nonnegative().default(0),
  protectionElements: z.int().nonnegative().default(0),
  protectedSheets: z.int().nonnegative().default(0),
  workbookProtected: z.boolean().default(false),
  date1904: z.boolean().default(false),
  strict: z.boolean().default(false),
});

export const editBlockerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("workbook"),
    code: z.enum([
      "macros",
      "protected_workbook",
      "protected_sheet",
      "write_reservation",
      "signed_package",
      "strict_markup",
      "unsupported_layout",
      "external_editing_unavailable",
    ]),
  }),
  z.strictObject({
    kind: z.literal("operation"),
    operationIndex: z
      .int()
      .nonnegative()
      .max(authoringLimits.maxOperations - 1),
    code: z.enum([
      "operation_not_supported",
      "overlapping_writes",
      "target_deleted",
      "conflicting_structure",
      "name_conflict",
    ]),
  }),
]);

export type EditChange = z.infer<typeof editChangeSchema>;
export type SourceEditChange = z.infer<typeof sourceEditChangeSchema>;
export type InsertedCell = z.infer<typeof insertedCellSchema>;
export type EditFeatures = z.infer<typeof editFeaturesSchema>;
export type EditBlocker = z.infer<typeof editBlockerSchema>;
