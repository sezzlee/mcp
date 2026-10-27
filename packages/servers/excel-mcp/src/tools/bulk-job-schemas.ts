import { z } from "zod";
import { presentationWireChangeSchema } from "../authoring/presentation.js";
import { bulkOperationSchema } from "../authoring/bulk.js";
import { writeCellWireSchema } from "../authoring/values.js";
import { sheetNameSchema } from "../authoring/workbook.js";
import { columnSpecSchema } from "../grid/column-spec.js";
import {
  workbookVersionSchema,
  workbookVersionIdSchema,
} from "../platform/versions.js";
import { bulkSourceRecordsSchema } from "./bulk-schemas.js";

export const bulkJobLimits = {
  maxSteps: 32,
  maxJobs: 16,
  maxOutputs: 16,
  maxResidentCells: 2_000_000,
  maxRecords: 100_000,
  maxColumns: 256,
  maxSnapshotBytes: 64 * 1024 * 1024,
  maxResidentTextBytes: 64 * 1024 * 1024,
  maxDescriptorBytes: 64 * 1024,
  maxOutputBytes: 50 * 1024 * 1024,
  maxKeyBytes: 16 * 1024 * 1024,
  maxComparisons: 20_000_000,
  maxExpandedChanges: 256,
  maxReceiptBytes: 128 * 1024,
} as const;
const id = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const column = z.string().min(1).max(32_767);
const columns = z.array(column).min(1).max(bulkJobLimits.maxColumns);
const input = { id, input: id };
const conditions = bulkSourceRecordsSchema.shape.where;
const predicate = {
  where: conditions,
  match: z.enum(["all", "any"]).default("all"),
  caseSensitive: z.boolean().default(true),
};
const conflicts = {
  duplicates: z.enum(["error", "first", "last"]).default("error"),
  missingKeys: z.enum(["error", "skip"]).default("error"),
};
const keyed = {
  id,
  source: id,
  target: id,
  keys: bulkOperationSchema.options[0].shape.keys,
  set: bulkOperationSchema.options[0].shape.set,
  ...conflicts,
};
const transform = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("constant"),
      column,
      value: writeCellWireSchema,
    }),
    z.strictObject({ kind: z.literal("trim"), column }),
    z.strictObject({
      kind: z.literal("case"),
      column,
      direction: z.enum(["upper", "lower"]),
      locale: z.string().min(2).max(64),
    }),
    z.strictObject({ kind: z.literal("convert"), spec: columnSpecSchema }),
  ])
  .meta({ type: "object" });

const bulkStepVariants = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("read"),
      id,
      source: workbookVersionSchema,
      selection: bulkSourceRecordsSchema,
    }),
    z.strictObject({
      kind: z.literal("update"),
      ...input,
      ...predicate,
      set: z
        .array(z.strictObject({ column, value: writeCellWireSchema }))
        .min(1)
        .max(64),
    }),
    z.strictObject({
      kind: z.literal("remove"),
      ...input,
      ...predicate,
      mode: z.enum(["clear", "delete_rows"]),
    }),
    z.strictObject({ kind: z.literal("filter"), ...input, ...predicate }),
    z.strictObject({ kind: z.literal("keyed_update"), ...keyed }),
    z.strictObject({ kind: z.literal("upsert"), ...keyed }),
    z.strictObject({ kind: z.literal("replace"), id, target: id, source: id }),
    z.strictObject({
      kind: z.literal("append"),
      id,
      inputs: z.array(id).min(1).max(8),
      columns,
      missingColumns: z.enum(["error", "blank"]).default("error"),
    }),
    z.strictObject({
      kind: z.literal("join"),
      id,
      left: id,
      right: id,
      keys: bulkOperationSchema.options[0].shape.keys,
      join: z.enum(["inner", "left", "full"]),
      ...conflicts,
      manyToMany: z.boolean().default(false),
      columns: z
        .array(
          z.strictObject({
            side: z.enum(["left", "right"]),
            column,
            as: column,
          }),
        )
        .min(1)
        .max(bulkJobLimits.maxColumns),
    }),
    z.strictObject({
      kind: z.literal("deduplicate"),
      ...input,
      keys: columns,
      keep: z.enum(["report", "duplicates_only", "first", "last", "drop_all"]),
      missingKeys: z.enum(["error", "keep", "group"]).default("error"),
    }),
    z.strictObject({
      kind: z.literal("sort"),
      ...input,
      by: z
        .array(
          z.strictObject({
            column,
            direction: z.enum(["asc", "desc"]),
            blanks: z.enum(["first", "last"]),
          }),
        )
        .min(1)
        .max(16),
      mixedTypes: z.enum(["error", "type_order"]).default("error"),
      locale: z.string().min(2).max(64).optional(),
    }),
    z.strictObject({
      kind: z.literal("project"),
      ...input,
      columns: z
        .array(z.strictObject({ column, as: column }))
        .min(1)
        .max(bulkJobLimits.maxColumns),
    }),
    z.strictObject({
      kind: z.literal("transform"),
      ...input,
      transformations: z.array(transform).min(1).max(64),
      onError: z.enum(["error", "blank", "keep"]).default("error"),
    }),
  ])
  .meta({ type: "object" });

export const bulkStepSchema = z
  .strictObject({
    kind: z.enum(
      bulkStepVariants.options.map((option) => option.shape.kind.value),
    ),
    id,
    input: id.optional(),
    source: z.union([id, workbookVersionSchema]).optional(),
    target: id.optional(),
    selection: bulkSourceRecordsSchema.optional(),
    where: conditions,
    match: predicate.match.removeDefault().optional(),
    caseSensitive: predicate.caseSensitive.removeDefault().optional(),
    set: z
      .union([bulkStepVariants.options[1].shape.set, keyed.set])
      .meta({ type: "array" })
      .optional(),
    mode: bulkStepVariants.options[2].shape.mode.optional(),
    keys: z.union([keyed.keys, columns]).meta({ type: "array" }).optional(),
    duplicates: conflicts.duplicates.removeDefault().optional(),
    missingKeys: z
      .union([
        conflicts.missingKeys.removeDefault(),
        bulkStepVariants.options[9].shape.missingKeys.removeDefault(),
      ])
      .optional(),
    inputs: bulkStepVariants.options[7].shape.inputs.optional(),
    columns: z
      .union([
        columns,
        bulkStepVariants.options[8].shape.columns,
        bulkStepVariants.options[11].shape.columns,
      ])
      .meta({ type: "array" })
      .optional(),
    missingColumns: bulkStepVariants.options[7].shape.missingColumns
      .removeDefault()
      .optional(),
    left: id.optional(),
    right: id.optional(),
    join: bulkStepVariants.options[8].shape.join.optional(),
    manyToMany: bulkStepVariants.options[8].shape.manyToMany
      .removeDefault()
      .optional(),
    keep: bulkStepVariants.options[9].shape.keep.optional(),
    by: bulkStepVariants.options[10].shape.by.optional(),
    mixedTypes: bulkStepVariants.options[10].shape.mixedTypes
      .removeDefault()
      .optional(),
    locale: bulkStepVariants.options[10].shape.locale,
    transformations:
      bulkStepVariants.options[12].shape.transformations.optional(),
    onError: bulkStepVariants.options[12].shape.onError
      .removeDefault()
      .optional(),
  })
  .transform((value, context) => {
    const parsed = bulkStepVariants.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      return z.NEVER;
    }
    return parsed.data;
  });

const outputVariants = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("new"),
      id,
      sheets: z
        .array(z.strictObject({ name: sheetNameSchema, input: id }))
        .min(1)
        .max(64),
    }),
    z.strictObject({
      kind: z.literal("edit"),
      id,
      target: id,
      input: id,
      mode: z.enum(["changed_values", "replace_values"]),
      overwrite: z.boolean().default(false),
    }),
    z.strictObject({
      kind: z.literal("edit_workbook"),
      id,
      changes: z
        .array(
          z.strictObject({
            target: id,
            input: id,
            mode: z.enum(["changed_values", "replace_values"]),
            overwrite: z.boolean().default(false),
          }),
        )
        .min(1)
        .max(64),
    }),
  ])
  .meta({ type: "object" });
const output = z
  .strictObject({
    kind: z.enum(
      outputVariants.options.map((option) => option.shape.kind.value),
    ),
    id,
    sheets: outputVariants.options[0].shape.sheets.optional(),
    target: id.optional(),
    input: id.optional(),
    mode: outputVariants.options[1].shape.mode.optional(),
    overwrite: outputVariants.options[1].shape.overwrite
      .removeDefault()
      .optional(),
    changes: outputVariants.options[2].shape.changes.optional(),
  })
  .transform((value, context) => {
    const parsed = outputVariants.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      return z.NEVER;
    }
    return parsed.data;
  });
export const bulkGroupSchema = z.strictObject({
  steps: z.array(bulkStepSchema).min(1).max(bulkJobLimits.maxSteps),
  outputs: z.array(output).min(1).max(bulkJobLimits.maxOutputs),
  finish: z
    .array(
      z.strictObject({
        output: id,
        changes: z.array(presentationWireChangeSchema).min(1).max(128),
      }),
    )
    .max(bulkJobLimits.maxOutputs)
    .optional(),
});
const bulkGroupWireSchema = bulkGroupSchema.omit({ finish: true });
const finishingSchema = z
  .array(
    z.strictObject({
      job: id.optional(),
      output: id,
      changes: z.array(presentationWireChangeSchema).min(1).max(128),
    }),
  )
  .max(bulkJobLimits.maxOutputs * bulkJobLimits.maxJobs)
  .optional();
const bulkJobVariants = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("dependent"),
      group: bulkGroupWireSchema,
      finish: finishingSchema,
    }),
    z.strictObject({
      kind: z.literal("independent"),
      jobs: z
        .array(z.strictObject({ id, group: bulkGroupWireSchema }))
        .min(1)
        .max(bulkJobLimits.maxJobs),
      finish: finishingSchema,
    }),
  ])
  .meta({ type: "object" });
export const bulkJobSchema = z
  .strictObject({
    kind: z.enum(["dependent", "independent"]),
    group: bulkGroupWireSchema.optional(),
    jobs: z
      .array(z.strictObject({ id, group: bulkGroupWireSchema }))
      .min(1)
      .max(bulkJobLimits.maxJobs)
      .optional(),
    finish: finishingSchema,
  })
  .transform((value, context) => {
    const { finish } = value;
    if (
      finish?.some((item) =>
        value.kind === "dependent"
          ? item.job !== undefined
          : item.job === undefined ||
            !value.jobs?.some((child) => child.id === item.job),
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Dependent finish entries omit job; independent finish entries must name an existing job.",
      });
      return z.NEVER;
    }
    const parsed = bulkJobVariants.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      return z.NEVER;
    }
    return parsed.data;
  });
export const bulkJobInputSchema = z.strictObject({ job: bulkJobSchema });
export const bulkJobStatusInputSchema = z.strictObject({
  jobId: workbookVersionIdSchema,
});
const counts = z.record(z.string().max(48), z.int().nonnegative());
export const bulkStepReceiptSchema = z.strictObject({
  id,
  kind: z.string().max(32),
  records: z.int().nonnegative(),
  counts,
});
const outputReceipt = z.strictObject({
  id,
  version: workbookVersionSchema,
  sizeBytes: z.int().nonnegative(),
  recalculated: z.literal(false),
  recalculationRequired: z.boolean(),
  refreshRequired: z.array(z.string().max(32)).max(8),
});
export const bulkGroupReceiptSchema = z.strictObject({
  kind: z.literal("complete"),
  jobId: workbookVersionIdSchema,
  outputs: z.array(outputReceipt).min(1).max(bulkJobLimits.maxOutputs),
  steps: z.array(bulkStepReceiptSchema).min(1).max(bulkJobLimits.maxSteps),
});
export const bulkFailureSchema = z.strictObject({
  error: z.string().max(128),
  message: z.string().max(1024),
  observation: z.enum(["current_attempt", "first_failed_attempt"]),
  diagnosticRetained: z.boolean(),
});
const completeChild = z.discriminatedUnion("details", [
  z.strictObject({
    kind: z.literal("complete"),
    id,
    details: z.literal("full"),
    result: bulkGroupReceiptSchema,
  }),
  z.strictObject({
    kind: z.literal("complete"),
    id,
    details: z.literal("summary"),
    result: z.strictObject({
      kind: z.literal("complete"),
      jobId: workbookVersionIdSchema,
    }),
    outputCount: z.int().positive().max(bulkJobLimits.maxOutputs),
    stepCount: z.int().positive().max(bulkJobLimits.maxSteps),
  }),
]);
const childResult = z.discriminatedUnion("kind", [
  completeChild,
  z.strictObject({
    kind: z.literal("failed"),
    id,
    jobId: workbookVersionIdSchema,
    failure: bulkFailureSchema,
  }),
  z.strictObject({
    kind: z.literal("pending"),
    id,
    jobId: workbookVersionIdSchema,
  }),
]);
export const bulkBatchReceiptSchema = z.strictObject({
  kind: z.enum(["complete", "partial", "failed", "pending"]),
  jobId: workbookVersionIdSchema,
  jobs: z.array(childResult).max(bulkJobLimits.maxJobs),
});
export const bulkStoredManifestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("group"),
    request: bulkGroupSchema,
    result: bulkGroupReceiptSchema,
  }),
  z.strictObject({
    kind: z.literal("batch"),
    request: bulkJobVariants.options[1],
    jobId: workbookVersionIdSchema,
  }),
  z.strictObject({
    kind: z.literal("failure"),
    jobId: workbookVersionIdSchema,
    failure: bulkFailureSchema,
  }),
]);
export type BulkStep = z.infer<typeof bulkStepSchema>;
export type BulkGroup = z.infer<typeof bulkGroupSchema>;
export type BulkJob = z.infer<typeof bulkJobSchema>;
export type BulkGroupReceipt = z.infer<typeof bulkGroupReceiptSchema>;
export type BulkBatchReceipt = z.infer<typeof bulkBatchReceiptSchema>;
export type BulkFailure = z.infer<typeof bulkFailureSchema>;
export type BulkStepReceipt = z.infer<typeof bulkStepReceiptSchema>;
