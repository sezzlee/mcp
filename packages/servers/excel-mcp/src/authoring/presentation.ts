import { z } from "zod";
import { sheetNameSchema } from "./workbook.js";
import { writeCellWireSchema } from "./values.js";

export const presentationLimits = {
  maxStyles: 16_384,
  maxComponents: 16_384,
  maxFormulaChars: 8_192,
  maxFormulaTokens: 4_096,
  maxTables: 256,
  maxTableColumns: 1_024,
} as const;

export const cellRangeSchema = z
  .string()
  .max(21)
  .regex(/^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$/);
const color = z.string().regex(/^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/);
const plainText = z.string().refine(
  (value) =>
    [...value].every((ch) => {
      const n = ch.codePointAt(0) ?? 0;
      return (
        n >= 32 && !(n >= 0xd800 && n <= 0xdfff) && n !== 0xfffe && n !== 0xffff
      );
    }),
  "Use valid text without control characters.",
);
const noteText = z
  .string()
  .max(32_767)
  .refine(
    (value) =>
      [...value].every((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return (
          (code >= 32 || code === 9 || code === 10 || code === 13) &&
          !(code >= 0xd800 && code <= 0xdfff) &&
          code !== 0xfffe &&
          code !== 0xffff
        );
      }),
    "Use valid XML note text.",
  );
const protectionPassword = z
  .string()
  .min(1)
  .max(15)
  .regex(/^[\x20-\x7e]+$/);
const borderSide = z.strictObject({
  style: z.enum([
    "thin",
    "medium",
    "thick",
    "dashed",
    "dotted",
    "double",
    "hair",
    "none",
  ]),
  color: color.optional(),
});
export const cellStyleSchema = z.strictObject({
  numberFormat: plainText.min(1).max(255).nullable().optional(),
  font: z
    .strictObject({
      name: plainText.min(1).max(128).optional(),
      size: z.number().min(1).max(409).optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      strike: z.boolean().optional(),
      color: color.optional(),
    })
    .nullable()
    .optional(),
  fill: color.nullable().optional(),
  border: z
    .strictObject({
      left: borderSide.optional(),
      right: borderSide.optional(),
      top: borderSide.optional(),
      bottom: borderSide.optional(),
    })
    .nullable()
    .optional(),
  alignment: z
    .strictObject({
      horizontal: z
        .enum([
          "general",
          "left",
          "center",
          "right",
          "fill",
          "justify",
          "centerContinuous",
          "distributed",
        ])
        .optional(),
      vertical: z
        .enum(["top", "center", "bottom", "justify", "distributed"])
        .optional(),
      wrapText: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  protection: z
    .strictObject({
      locked: z.boolean().optional(),
      hidden: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});
const formula = z.string().min(1).max(presentationLimits.maxFormulaChars);
const tableName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u);
const tableStyle = z.enum(["SezzleeBlue", "none"]);
const comparison = z.enum([
  "between",
  "notBetween",
  "equal",
  "notEqual",
  "greaterThan",
  "lessThan",
  "greaterThanOrEqual",
  "lessThanOrEqual",
]);
const validationRule = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("list"),
    items: z.array(plainText.min(1).max(255)).min(1).max(128),
  }),
  ...(["whole", "decimal", "date", "textLength"] as const).map((type) =>
    z.strictObject({
      type: z.literal(type),
      operator: comparison,
      bounds: z.array(z.number().finite()).min(1).max(2),
    }),
  ),
  z.strictObject({ type: z.literal("custom"), formula }),
]);
const conditionalRule = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cellIs"),
    operator: comparison,
    formulas: z.array(formula).min(1).max(2),
  }),
  z.strictObject({ type: z.literal("expression"), formula }),
]);
const calculatedColumns = z
  .array(z.strictObject({ column: z.string().min(1).max(255), formula }))
  .max(presentationLimits.maxTableColumns);
const totals = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("label"),
        column: plainText.min(1).max(255),
        text: plainText.max(255),
      }),
      z.strictObject({
        kind: z.literal("function"),
        column: z.string().min(1).max(255),
        function: z.enum([
          "sum",
          "average",
          "count",
          "countNums",
          "min",
          "max",
          "stdDev",
          "var",
        ]),
      }),
      z.strictObject({
        kind: z.literal("formula"),
        column: z.string().min(1).max(255),
        formula,
      }),
    ]),
  )
  .max(presentationLimits.maxTableColumns);

export const presentationChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("protect_sheet"),
    sheetName: sheetNameSchema,
    password: protectionPassword.optional(),
    selectLocked: z.boolean().default(true),
    selectUnlocked: z.boolean().default(true),
  }),
  z.strictObject({
    kind: z.literal("unprotect_sheet"),
    sheetName: sheetNameSchema,
    password: protectionPassword.optional(),
  }),
  z.strictObject({
    kind: z.literal("protect_workbook"),
    sheetName: sheetNameSchema,
    password: protectionPassword.optional(),
  }),
  z.strictObject({
    kind: z.literal("unprotect_workbook"),
    sheetName: sheetNameSchema,
    password: protectionPassword.optional(),
  }),
  z.strictObject({
    kind: z.literal("set_pivot"),
    sheetName: sheetNameSchema,
    name: tableName,
    cell: cellRangeSchema,
    sourceSheet: sheetNameSchema,
    sourceRange: cellRangeSchema,
    rowColumn: plainText.min(1).max(255),
    measures: z
      .array(
        z.strictObject({
          column: plainText.min(1).max(255),
          function: z.enum(["sum", "count", "min", "max"]),
          name: plainText.min(1).max(255),
        }),
      )
      .min(1)
      .max(8),
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("set_chart"),
    sheetName: sheetNameSchema,
    name: plainText.min(1).max(255),
    chartType: z.enum(["column", "bar", "line", "pie"]),
    title: plainText.max(255).default(""),
    cell: cellRangeSchema,
    width: z.int().min(100).max(2000).default(640),
    height: z.int().min(100).max(2000).default(360),
    series: z
      .array(
        z.strictObject({
          name: plainText.min(1).max(255),
          sheetName: sheetNameSchema,
          categories: cellRangeSchema,
          values: cellRangeSchema,
        }),
      )
      .min(1)
      .max(16),
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("remove_chart"),
    sheetName: sheetNameSchema,
    name: plainText.min(1).max(255),
  }),
  z.strictObject({
    kind: z.literal("set_hyperlink"),
    sheetName: sheetNameSchema,
    cell: cellRangeSchema,
    target: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("internal"),
        location: plainText.min(1).max(1024),
      }),
      z.strictObject({ kind: z.literal("external"), url: z.url().max(2048) }),
    ]),
    tooltip: plainText.max(255).optional(),
    display: plainText.max(32_767).optional(),
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("remove_hyperlink"),
    sheetName: sheetNameSchema,
    cell: cellRangeSchema,
  }),
  z.strictObject({
    kind: z.literal("set_note"),
    sheetName: sheetNameSchema,
    cell: cellRangeSchema,
    text: noteText,
    author: plainText.min(1).max(255).default("Author"),
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("remove_note"),
    sheetName: sheetNameSchema,
    cell: cellRangeSchema,
  }),
  z.strictObject({
    kind: z.literal("set_image"),
    sheetName: sheetNameSchema,
    name: plainText.min(1).max(255),
    cell: cellRangeSchema,
    mime: z.enum(["image/png", "image/jpeg"]),
    data: z.string().min(4).max(7_000_000),
    width: z.int().min(1).max(10_000),
    height: z.int().min(1).max(10_000),
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("remove_image"),
    sheetName: sheetNameSchema,
    name: plainText.min(1).max(255),
  }),
  z.strictObject({
    kind: z.literal("set_validation"),
    sheetName: sheetNameSchema,
    range: cellRangeSchema,
    rule: validationRule,
    allowBlank: z.boolean().default(false),
    errorStyle: z.enum(["stop", "warning", "information"]).default("stop"),
    errorTitle: plainText.max(32).optional(),
    error: plainText.max(225).optional(),
    promptTitle: plainText.max(32).optional(),
    prompt: plainText.max(255).optional(),
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("remove_validation"),
    sheetName: sheetNameSchema,
    range: cellRangeSchema,
  }),
  z.strictObject({
    kind: z.literal("set_conditional_format"),
    sheetName: sheetNameSchema,
    range: cellRangeSchema,
    priority: z.int().min(1).max(4096),
    rule: conditionalRule,
    appearance: cellStyleSchema.pick({ font: true, fill: true }),
    stopIfTrue: z.boolean().default(false),
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("remove_conditional_format"),
    sheetName: sheetNameSchema,
    priority: z.int().min(1).max(4096),
  }),
  z.strictObject({
    kind: z.literal("define_name"),
    sheetName: sheetNameSchema,
    name: tableName,
    scope: z.enum(["workbook", "sheet"]).default("workbook"),
    range: cellRangeSchema,
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("delete_name"),
    sheetName: sheetNameSchema,
    name: tableName,
    scope: z.enum(["workbook", "sheet"]).default("workbook"),
  }),
  z.strictObject({
    kind: z.literal("write_named_range"),
    sheetName: sheetNameSchema,
    name: tableName,
    scope: z.enum(["workbook", "sheet"]).default("workbook"),
    values: z
      .array(z.array(writeCellWireSchema).min(1).max(16_384))
      .min(1)
      .max(1_048_576),
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("format_cells"),
    sheetName: sheetNameSchema,
    range: cellRangeSchema,
    style: cellStyleSchema,
  }),
  z.strictObject({
    kind: z.literal("set_columns"),
    sheetName: sheetNameSchema,
    first: z.int().min(1).max(16_384),
    last: z.int().min(1).max(16_384),
    width: z.number().min(0).max(255).nullable().optional(),
    hidden: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("set_rows"),
    sheetName: sheetNameSchema,
    first: z.int().min(1).max(1_048_576),
    last: z.int().min(1).max(1_048_576),
    height: z.number().min(0).max(409).nullable().optional(),
    hidden: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("freeze_panes"),
    sheetName: sheetNameSchema,
    rows: z.int().min(0).max(1_048_575),
    columns: z.int().min(0).max(16_383),
  }),
  z.strictObject({
    kind: z.literal("set_sheet_visibility"),
    sheetName: sheetNameSchema,
    state: z.enum(["visible", "hidden", "veryHidden"]),
  }),
  z.strictObject({
    kind: z.literal("set_print_layout"),
    sheetName: sheetNameSchema,
    orientation: z.enum(["portrait", "landscape"]).optional(),
    paper: z.enum(["A4", "letter", "legal"]).optional(),
    margins: z
      .strictObject({
        left: z.number().min(0).max(10),
        right: z.number().min(0).max(10),
        top: z.number().min(0).max(10),
        bottom: z.number().min(0).max(10),
        header: z.number().min(0).max(10),
        footer: z.number().min(0).max(10),
      })
      .optional(),
    fitWidth: z.int().min(0).max(32_767).optional(),
    fitHeight: z.int().min(0).max(32_767).optional(),
    scale: z.int().min(10).max(400).optional(),
    printArea: cellRangeSchema.nullable().optional(),
    titleRows: z
      .strictObject({
        first: z.int().min(1).max(1_048_576),
        last: z.int().min(1).max(1_048_576),
      })
      .nullable()
      .optional(),
    titleColumns: z
      .strictObject({
        first: z.int().min(1).max(16_384),
        last: z.int().min(1).max(16_384),
      })
      .nullable()
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("merge_cells"),
    sheetName: sheetNameSchema,
    range: cellRangeSchema,
    loss: z.enum(["reject", "discard_non_anchor"]).default("reject"),
  }),
  z.strictObject({
    kind: z.literal("unmerge_cells"),
    sheetName: sheetNameSchema,
    range: cellRangeSchema,
  }),
  z.strictObject({
    kind: z.literal("write_formula"),
    sheetName: sheetNameSchema,
    cell: cellRangeSchema,
    formula,
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("fill_formula"),
    sheetName: sheetNameSchema,
    anchor: cellRangeSchema,
    range: cellRangeSchema,
    formula,
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("create_table"),
    sheetName: sheetNameSchema,
    range: cellRangeSchema,
    name: tableName,
    style: tableStyle.default("SezzleeBlue"),
    filter: z.boolean().default(true),
    totals: totals.optional(),
    calculatedColumns: calculatedColumns.optional(),
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("edit_table"),
    sheetName: sheetNameSchema,
    tableName,
    name: tableName.optional(),
    range: cellRangeSchema.optional(),
    columns: z
      .array(
        z.strictObject({
          column: plainText.min(1).max(255),
          name: plainText.min(1).max(255),
        }),
      )
      .max(presentationLimits.maxTableColumns)
      .optional(),
    totals: totals.nullable().optional(),
    style: tableStyle.optional(),
    filter: z.boolean().optional(),
    calculatedColumns: calculatedColumns.optional(),
    clearRemovedValues: z.boolean().default(false),
    overwrite: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("convert_table"),
    sheetName: sheetNameSchema,
    tableName,
  }),
]);

export type PresentationChange = z.infer<typeof presentationChangeSchema>;
export type CellStyle = z.infer<typeof cellStyleSchema>;

function ruleWireSchema() {
  const variants = [...validationRule.options, ...conditionalRule.options];
  const fields = new Map<string, Map<string, z.ZodType>>();
  for (const variant of variants)
    for (const [name, schema] of Object.entries(variant.shape)) {
      if (name === "type") continue;
      const choices = fields.get(name) ?? new Map<string, z.ZodType>();
      choices.set(
        JSON.stringify(z.toJSONSchema(schema, { io: "input" })),
        schema,
      );
      fields.set(name, choices);
    }
  const shape: Record<string, z.ZodType> = {
    type: z.enum(variants.map((variant) => variant.shape.type.value)),
  };
  for (const [name, choices] of fields) {
    const schemas = [...choices.values()];
    const first = schemas[0];
    if (first !== undefined)
      shape[name] = (
        schemas.length === 1 ? first : z.union(schemas)
      ).optional();
  }
  return z.strictObject(shape);
}

function presentationWireSchema() {
  const fields = new Map<string, Map<string, z.ZodType>>();
  for (const variant of presentationChangeSchema.options)
    for (const [name, schema] of Object.entries(variant.shape)) {
      if (name === "kind" || name === "sheetName" || name === "rule") continue;
      const input = schema instanceof z.ZodDefault ? schema.unwrap() : schema;
      const choices = fields.get(name) ?? new Map<string, z.ZodType>();
      choices.set(
        JSON.stringify(z.toJSONSchema(input, { io: "input" })),
        input,
      );
      fields.set(name, choices);
    }
  const shape: Record<string, z.ZodType> = {
    kind: z.enum(
      presentationChangeSchema.options.map((v) => v.shape.kind.value),
    ),
    sheetName: sheetNameSchema,
    rule: ruleWireSchema().optional(),
  };
  for (const [name, choices] of fields) {
    const schemas = [...choices.values()],
      first = schemas[0];
    if (first === undefined) continue;
    shape[name] = (schemas.length === 1 ? first : z.union(schemas)).optional();
  }
  return z.strictObject(shape).transform((value, context) => {
    const parsed = presentationChangeSchema.safeParse(value);
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
}
export const presentationWireChangeSchema = presentationWireSchema();
