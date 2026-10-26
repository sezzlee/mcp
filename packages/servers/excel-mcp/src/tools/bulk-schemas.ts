import { z } from "zod";
import { bulkLimits, bulkOperationSchema } from "../authoring/bulk.js";
import { editBlockerSchema } from "../authoring/edit.js";
import { workbookVersionSchema } from "../platform/versions.js";
import {
  transferSelectionSchema,
  transferSummarySchema,
} from "./transfer-schemas.js";

const records = transferSelectionSchema.options[1].extend({
  headerRow: z.int().min(1).max(1_048_576),
  includeHeaders: z.literal(false).default(false),
  range: z
    .string()
    .max(21)
    .regex(/^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$/)
    .optional(),
});
function explicitExtent(selection: {
  readonly range?: string;
  readonly table?: string;
  readonly headerRow: number;
}): boolean {
  if ((selection.range === undefined) === (selection.table === undefined))
    return false;
  if (selection.range === undefined) return true;
  const first = selection.range.split(":")[0];
  const row = first?.match(/[0-9]+$/)?.[0];
  return row !== undefined && Number(row) === selection.headerRow;
}
const extentMessage =
  "Select exactly one closed range or named table; a range must start at headerRow.";
export const bulkSourceRecordsSchema = records.refine(
  explicitExtent,
  extentMessage,
);
const targetRecords = records
  .omit({
    where: true,
    match: true,
    visibleOnly: true,
    selectColumns: true,
    scope: true,
  })
  .extend({
    match: z.literal("all").default("all"),
    scope: z.strictObject({ kind: z.literal("all") }).default({ kind: "all" }),
  })
  .refine(explicitExtent, extentMessage);
const source = workbookVersionSchema.extend({
  selection: bulkSourceRecordsSchema,
});
const target = workbookVersionSchema.extend({ selection: targetRecords });

export const prepareBulkSchema = z.strictObject({
  source,
  target,
  operation: bulkOperationSchema,
});

const side = z.enum(["source", "target"]);
const record = z.int().positive().max(bulkLimits.maxRecordsPerInput);
const column = z.int().positive().max(16_384);
export const bulkConflictSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("missing_header"), side, column }),
  z.strictObject({
    kind: z.literal("duplicate_header"),
    side,
    column,
    firstColumn: column,
  }),
  z.strictObject({
    kind: z.literal("unknown_column"),
    side,
    mapping: z.enum(["keys", "set"]),
    mappingIndex: z
      .int()
      .nonnegative()
      .max(bulkLimits.maxMappings - 1),
  }),
  z.strictObject({ kind: z.literal("missing_key"), side, record }),
  z.strictObject({
    kind: z.literal("duplicate_key"),
    side,
    record,
    firstRecord: record,
  }),
  z.strictObject({ kind: z.literal("overwrite_required"), record }),
  z.strictObject({
    kind: z.literal("incomplete_insert_mapping"),
    columns: z.int().positive().max(16_384),
  }),
]);
const count = z.int().nonnegative().max(bulkLimits.maxRecordsPerInput);
export const bulkKeyAnalysisSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ready"),
    matchedRecords: count,
    sourceUnmatchedRecords: count,
    targetUnmatchedRecords: count,
    wouldUpdateRecords: count,
    unchangedRecords: count,
    wouldInsertRecords: count,
  }),
  z.strictObject({
    kind: z.literal("blocked"),
    conflictCount: z.int().positive(),
    conflicts: z
      .array(bulkConflictSchema)
      .min(1)
      .max(bulkLimits.maxConflictExamples),
    conflictsTruncated: z.boolean(),
  }),
]);
const common = {
  validation: z.literal("keys_and_target_policy"),
  executionAvailable: z.literal(false),
  source: workbookVersionSchema,
  target: workbookVersionSchema,
  requestFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .brand<"BulkRequestFingerprint">(),
  recalculated: z.literal(false),
};
const selections = {
  sourceSelection: transferSummarySchema,
  targetSelection: transferSummarySchema,
};
export const bulkPreparationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ready"),
    ...common,
    ...selections,
    analysis: bulkKeyAnalysisSchema.options[0],
  }),
  z.strictObject({
    kind: z.literal("blocked"),
    ...common,
    failure: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("target_policy"),
        blockers: z.array(editBlockerSchema).min(1),
      }),
      z.strictObject({
        kind: z.literal("record_conflicts"),
        ...selections,
        analysis: bulkKeyAnalysisSchema.options[1],
      }),
    ]),
  }),
]);

export type PrepareBulk = z.infer<typeof prepareBulkSchema>;
export type BulkConflict = z.infer<typeof bulkConflictSchema>;
export type BulkKeyAnalysis = z.infer<typeof bulkKeyAnalysisSchema>;
export type BulkPreparation = z.infer<typeof bulkPreparationSchema>;
