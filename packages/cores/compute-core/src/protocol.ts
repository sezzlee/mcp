import { z } from "zod";

export const executionLimits = Object.freeze({
  maxCodeBytes: 16_384,
  maxInputBytes: 8_388_608,
  maxOutputBytes: 1_048_576,
  maxMemoryBytes: 33_554_432,
  maxStackBytes: 524_288,
  timeoutMs: 2_000,
  maxConcurrent: 2,
});

export const executionLimitsSchema = z.strictObject({
  maxCodeBytes: z.int().positive().max(executionLimits.maxCodeBytes),
  maxInputBytes: z.int().positive().max(executionLimits.maxInputBytes),
  maxOutputBytes: z.int().positive().max(executionLimits.maxOutputBytes),
  maxMemoryBytes: z.int().min(1_048_576).max(executionLimits.maxMemoryBytes),
  maxStackBytes: z.int().min(16_384).max(executionLimits.maxStackBytes),
  timeoutMs: z.int().positive().max(executionLimits.timeoutMs),
  maxConcurrent: z.int().positive().max(executionLimits.maxConcurrent),
});

export type ExecutionLimits = Readonly<z.infer<typeof executionLimitsSchema>>;

export const executionFailureReasonSchema = z.enum([
  "invalid_input",
  "code_limit",
  "input_limit",
  "output_limit",
  "invalid_program",
  "program_failed",
  "invalid_result",
  "memory_limit",
  "timeout",
  "cancelled",
  "busy",
  "unavailable",
]);

export type ExecutionFailureReason = z.infer<
  typeof executionFailureReasonSchema
>;

export const dataExecutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("success"), json: z.string() }),
  z.strictObject({
    kind: z.literal("failure"),
    reason: executionFailureReasonSchema,
  }),
]);

export type DataExecution = z.infer<typeof dataExecutionSchema>;

export const executionInputSchema = z.strictObject({
  code: z.string(),
  json: z.string(),
});

export type ExecutionInput = z.infer<typeof executionInputSchema>;

export const executionRequestSchema = executionInputSchema.extend({
  signal: z.instanceof(AbortSignal).optional(),
});

export const workerInputSchema = executionInputSchema.extend({
  limits: executionLimitsSchema,
});

export interface DataExecutor {
  readonly limits: ExecutionLimits;
  execute(
    input: ExecutionInput & { readonly signal?: AbortSignal },
  ): Promise<DataExecution>;
}

export function executionFailure(
  reason: ExecutionFailureReason,
): DataExecution {
  return { kind: "failure", reason };
}
