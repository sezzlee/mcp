import { z } from "zod";

export const terminationSchema = z.enum([
  "completed",
  "context_preflight",
  "output_limit",
  "call_budget",
  "request_budget",
  "timeout",
  "malformed_tool_call",
  "oracle_failure",
  "final_answer_failure",
  "scenario_failure",
  "host_failure",
  "empty_reply",
]);
export type Termination = z.infer<typeof terminationSchema>;

const version = z.object({ filePath: z.string(), versionId: z.string() });
export const artifactSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("passed"), output: version }),
  z.object({
    status: z.enum([
      "failed",
      "not_produced",
      "not_verified",
      "not_applicable",
    ]),
  }),
]);
export const finalAnswerSchema = z.enum([
  "passed",
  "failed",
  "missing",
  "not_required",
  "not_evaluated",
]);
export const repeatedErrorSchema = z.object({
  tool: z.string(),
  fingerprint: z.string(),
  error: z.string(),
  count: z.int().positive(),
});
