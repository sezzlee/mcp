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

export const writeCellSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("text"), value: text }),
    z.strictObject({
      kind: z.literal("number"),
      value: z
        .number()
        .finite()
        .refine(
          (value) =>
            (!Number.isInteger(value) || Number.isSafeInteger(value)) &&
            Number(value.toPrecision(15)) === value &&
            (value === 0 || Math.abs(value) >= 2.2251e-308) &&
            Math.abs(value) <= 9.99999999999999e307,
          {
            message:
              "The number cannot be safely represented in Excel. Choose text for long identifiers.",
          },
        ),
    }),
    z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
    z.strictObject({ kind: z.literal("blank") }),
    z.strictObject({
      kind: z.literal("date"),
      value: z.iso
        .date()
        .min(10)
        .refine((value) => value >= "1900-01-01"),
    }),
    z.strictObject({
      kind: z.literal("datetime"),
      value: localDateTime.refine((value) => value >= "1900-01-01T00:00:00"),
    }),
  ],
  {
    error: (issue) =>
      typeof issue.input === "string" &&
      !issue.input.trimStart().startsWith("{")
        ? 'Use a typed cell, for example {kind:"text",value:"Item"} for text or {kind:"number",value:12} for a number; bare scalar values are not cells.'
        : undefined,
  },
);

export type WriteCell = z.infer<typeof writeCellSchema>;

export const writeCellWireSchema = z
  .strictObject({
    kind: z.enum(
      writeCellSchema.options.map((option) => option.shape.kind.value),
    ),
    value: z
      .union([
        writeCellSchema.options[0].shape.value,
        writeCellSchema.options[1].shape.value,
        writeCellSchema.options[2].shape.value,
      ])
      .optional(),
  })
  .transform((value, context) => {
    const parsed = writeCellSchema.safeParse(value);
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
