import { z } from "zod";
import { writeCellSchema } from "./values.js";

export const authoringLimits = {
  maxCells: 1_000_000,
  maxSheets: 64,
  maxOperations: 128,
  maxTextBytes: 32 * 1024 * 1024,
  maxInputBytes: 64 * 1024 * 1024,
} as const;

export const sheetNameSchema = z
  .string()
  .min(1)
  .max(31)
  .refine(
    (name) =>
      name.trim().length > 0 &&
      [...name].every(
        (character) =>
          character.charCodeAt(0) > 31 &&
          character.charCodeAt(0) !== 127 &&
          !"\\/?*[]:".includes(character),
      ) &&
      !/^[']|[']$/.test(name) &&
      !/[\uD800-\uDFFF]/u.test(name) &&
      !/^history$/i.test(name),
    {
      message: "Use a valid Excel sheet name of at most 31 UTF-16 code units.",
    },
  );

export const valueBlockSchema = z.strictObject({
  startCell: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/),
  values: z
    .array(z.array(writeCellSchema).min(1).max(16_384))
    .min(1)
    .max(authoringLimits.maxCells)
    .refine((rows) => rows.every((row) => row.length === rows[0]?.length), {
      message: "Every row in a value block must have the same width.",
    }),
});

export const newSheetSchema = z.strictObject({
  name: sheetNameSchema,
  blocks: z
    .array(valueBlockSchema)
    .max(authoringLimits.maxOperations)
    .default([]),
});

export const workbookChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("add_sheet"), name: sheetNameSchema }),
  valueBlockSchema.extend({
    kind: z.literal("write_cells"),
    sheetName: sheetNameSchema,
    overwrite: z.boolean().default(false),
  }),
]);

export type ValueBlock = z.infer<typeof valueBlockSchema>;
export type NewSheet = z.infer<typeof newSheetSchema>;
export type WorkbookChange = z.infer<typeof workbookChangeSchema>;
