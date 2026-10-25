import { z } from "zod";

const text = z
  .string()
  .max(32_767)
  .refine((value) => !/[\uD800-\uDFFF]/u.test(value), {
    message: "Text must contain valid Unicode.",
  });
const localDateTime = z.iso
  .datetime({ local: true })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/);

export const writeCellSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), value: text }),
  z.strictObject({ kind: z.literal("number"), value: z.number().finite() }),
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ kind: z.literal("blank") }),
  z.strictObject({ kind: z.literal("date"), value: z.iso.date() }),
  z.strictObject({ kind: z.literal("datetime"), value: localDateTime }),
]);

export type WriteCell = z.infer<typeof writeCellSchema>;
