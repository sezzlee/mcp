import { z } from "zod";
import { authoringLimits } from "./workbook.js";

export const bulkLimits = {
  maxDescriptorBytes: 64 * 1024,
  maxRecordsPerInput: 100_000,
  maxCells: authoringLimits.maxCells,
  maxTextBytes: authoringLimits.maxTextBytes,
  maxKeyBytes: 16 * 1024 * 1024,
  maxKeyComponents: 16,
  maxMappings: 64,
  maxConflictExamples: 8,
} as const;

const mapping = z.strictObject({
  sourceColumn: z.string().min(1).max(32_767),
  targetColumn: z.string().min(1).max(32_767),
});
const keyed = {
  keys: z.array(mapping).min(1).max(bulkLimits.maxKeyComponents),
  set: z.array(mapping).min(1).max(bulkLimits.maxMappings),
  conflictPolicy: z.literal("error").default("error"),
  overwrite: z.boolean().default(false),
};

export const bulkOperationSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("keyed_update"), ...keyed }),
    z.strictObject({ kind: z.literal("upsert"), ...keyed }),
  ])
  .superRefine((operation, context) => {
    for (const field of ["sourceColumn", "targetColumn"] as const) {
      if (
        new Set(operation.keys.map((item) => item[field])).size !==
        operation.keys.length
      )
        context.addIssue({
          code: "custom",
          path: ["keys"],
          message: "Key columns must be unique on each input.",
        });
    }
    const targets = operation.set.map((item) => item.targetColumn);
    if (new Set(targets).size !== targets.length)
      context.addIssue({
        code: "custom",
        path: ["set"],
        message: "Each target column may be assigned only once.",
      });
    const keys = new Set(operation.keys.map((item) => item.targetColumn));
    if (targets.some((column) => keys.has(column)))
      context.addIssue({
        code: "custom",
        path: ["set"],
        message: "Key columns cannot be reassigned by a keyed operation.",
      });
  })
  .meta({ type: "object" });

export type BulkOperation = z.infer<typeof bulkOperationSchema>;
