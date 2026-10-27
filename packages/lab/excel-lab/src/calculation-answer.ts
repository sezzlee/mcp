import { z } from "zod";

const answerSchema = z.strictObject({
  filePath: z.string().min(1),
  total: z.number().optional(),
  complete: z.boolean().optional(),
  unavailableCells: z.number().int().nonnegative().optional(),
});

export function parseCalculationAnswer(content: string) {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const suffix =
    /(?:\s*<\/(?:parameter|function|tool_call)>)+\s*$/.exec(text)?.[0] ?? "";
  const json = suffix === "" ? text : text.slice(0, -suffix.length);
  const value: unknown = JSON.parse(json);
  return {
    answer: answerSchema.parse(value),
    protocolSuffixStripped: suffix !== "",
  };
}
