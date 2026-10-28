import { z } from "zod";
import {
  editBlockerSchema,
  editFeaturesSchema,
  insertRowsFields,
  sourceEditChangeSchema,
} from "../authoring/edit.js";
import {
  blockSourceReceiptSchema,
  editPlacementSchema,
  expectedVersionSchema,
  workbookVersionSchema,
  mutationReceiptSchema,
} from "../platform/versions.js";
import {
  authoringLimits,
  valueBlockSchema,
  workbookChangeSchema,
} from "../authoring/workbook.js";
import {
  blockHeaderSchema,
  blockSourceSchema,
  oneBlockInput,
  oneBlockInputMessage,
} from "./block-sources.js";

const sourced = {
  source: blockSourceSchema.optional(),
  header: blockHeaderSchema.optional(),
};

export const valueBlockWireSchema = z
  .strictObject({
    startCell: valueBlockSchema.shape.startCell,
    values: valueBlockSchema.shape.values.optional(),
    ...sourced,
  })
  .refine(oneBlockInput, { message: oneBlockInputMessage });

const writeCellsWire = z
  .strictObject({
    ...workbookChangeSchema.options[1].shape,
    values: valueBlockSchema.shape.values.optional(),
    ...sourced,
  })
  .refine(oneBlockInput, { message: oneBlockInputMessage });

const insertRowsWire = z
  .strictObject({ ...insertRowsFields, ...sourced })
  .refine(
    (change) =>
      [change.count, change.values, change.source].filter(
        (input) => input !== undefined,
      ).length === 1,
    { message: "Give insert_rows exactly one of count, values or source." },
  )
  .refine(
    (change) => change.startColumn === undefined || change.count === undefined,
    {
      message:
        "startColumn places inserted values; it requires values or source.",
    },
  )
  .refine(
    (change) => change.header === undefined || change.count === undefined,
    {
      message:
        "header names the columns that values or source write; insert_rows with count writes no cells.",
    },
  )
  .refine(
    (change) =>
      change.values?.every(
        (row) => row.length === change.values?.[0]?.length,
      ) ?? true,
    { message: "Every inserted row must have the same width." },
  );

export const editWireChangesSchema = z
  .array(
    z.discriminatedUnion("kind", [
      sourceEditChangeSchema.options[0],
      ...sourceEditChangeSchema.options.slice(1).map((option) => {
        switch (option.shape.kind.value) {
          case "copy_range":
          case "copy_sheet":
            return option.extend({ from: workbookVersionSchema.optional() });
          case "write_cells":
            return writeCellsWire;
          case "insert_rows":
            return insertRowsWire;
          default:
            return option;
        }
      }),
    ]),
  )
  .min(1)
  .max(authoringLimits.maxOperations);
export type EditWireChange = z.infer<typeof editWireChangesSchema>[number];

export const prepareEditSchema = z.strictObject({
  filePath: z.string().min(1).max(32_768),
  expectedVersion: expectedVersionSchema.optional(),
  changes: editWireChangesSchema,
});

const common = {
  source: workbookVersionSchema,
  requestFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .brand<"EditRequestFingerprint">(),
  operations: z.int().positive(),
  cellsRequested: z.int().nonnegative(),
  features: editFeaturesSchema,
  recalculated: z.literal(false),
  effects: mutationReceiptSchema.shape.editing,
  placements: z.array(editPlacementSchema).min(1).optional(),
  sources: z.array(blockSourceReceiptSchema).min(1).optional(),
};

export const editPreparationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ready"),
    ...common,
    profile: z.enum(["canonical_values", "preserved_package"]),
  }),
  z.strictObject({
    kind: z.literal("blocked"),
    ...common,
    blockers: z.array(editBlockerSchema).min(1),
  }),
]);
