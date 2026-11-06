import { z } from "zod";

export const resultExecutionSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("aggregate"),
    resultId: z.string(),
    scope: z.literal("retained_result"),
    totalRows: z.int().nonnegative(),
    totalColumns: z.int().nonnegative(),
    matchedSourceRows: z.int().nonnegative(),
    sourceVersion: z.string(),
    sourcePolicy: z.literal("snapshot"),
  }),
  z.strictObject({
    kind: z.literal("computed"),
    resultId: z.string(),
    scope: z.literal("computed_json"),
  }),
]);

export type ResultExecutionSource = z.infer<typeof resultExecutionSourceSchema>;
