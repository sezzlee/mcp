import { readFile } from "node:fs/promises";
import { z } from "zod";

export const costMetrics = [
  "calls",
  "inputTokens",
  "responseBytes",
  "seconds",
] as const;
export type CostMetric = (typeof costMetrics)[number];

/**
 * A pre-registered comparison, committed before either run: what differs,
 * what should move and how the result is decided. The comparison refuses a
 * manifest difference the specification does not declare.
 */
export const experimentSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  hypothesis: z.string().min(1),
  treatment: z.array(z.string().min(1)).min(1),
  tasks: z.string().min(1),
  rule: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("superiority") }),
    z.strictObject({
      kind: z.literal("noninferiority"),
      marginPoints: z.number().positive(),
      cost: z.enum(costMetrics),
    }),
  ]),
  mechanism: z
    .strictObject({
      metric: z.enum(costMetrics),
      direction: z.enum(["decrease", "increase"]),
      minRelativeChange: z.number().positive(),
    })
    .optional(),
});
export type Experiment = z.infer<typeof experimentSchema>;

/** Reads and validates a pre-registered experiment. */
export async function readExperiment(path: string): Promise<Experiment> {
  return experimentSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
