import { z } from "zod";
import {
  editBlockerSchema,
  editChangeSchema,
  editFeaturesSchema,
} from "../authoring/edit.js";
import {
  workbookVersionIdSchema,
  workbookVersionSchema,
} from "../platform/versions.js";
import { authoringLimits } from "../authoring/workbook.js";

export const editWireChangesSchema = z
  .array(
    z.discriminatedUnion("kind", [
      editChangeSchema.options[0],
      ...editChangeSchema.options
        .slice(1)
        .map((option) =>
          option.shape.kind.value === "copy_range" ||
          option.shape.kind.value === "copy_sheet"
            ? option.extend({ from: workbookVersionSchema.optional() })
            : option,
        ),
    ]),
  )
  .min(1)
  .max(authoringLimits.maxOperations);
export type EditWireChange = z.infer<typeof editWireChangesSchema>[number];

export const prepareEditSchema = z.strictObject({
  filePath: z.string().min(1).max(32_768),
  expectedVersion: workbookVersionIdSchema.optional(),
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
