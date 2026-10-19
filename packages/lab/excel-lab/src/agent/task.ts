import { readFile } from "node:fs/promises";
import { toolDefinitions, toolNames, type ToolName } from "@sezzlee/excel-mcp";
import { z } from "zod";
import { sha256Schema } from "../record.ts";
import { exprSchema } from "./derive.ts";

export const caseIds = [
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "S7",
  "S8",
  "S9",
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V6",
  "V7",
  "V8",
  "V9",
  "V10",
  "E1",
  "E2",
  "E3",
  "E4",
  "E5",
  "Z1",
  "Z2",
  "Z3",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "Q5",
  "Q6",
  "Q7",
  "Q8",
  "Q9",
  "Q10",
  "Q11",
  "Q12",
  "Q13",
  "X1",
  "X2",
  "X3",
  "X4",
  "X5",
  "T1",
  "T2",
  "T3",
  "T4",
  "T5",
  "T6",
  "R1",
  "R2",
  "R3",
  "R4",
  "R5",
  "R6",
] as const;
export type CaseId = (typeof caseIds)[number];

export const levels = ["L1", "L2", "L3", "L4", "L5"] as const;
export const knowledgeLevels = ["K0", "K1", "K2"] as const;
export const languages = ["tr", "en"] as const;
export type Language = (typeof languages)[number];

const fileId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const workspacePath = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.(xlsx|xlsm|csv)$/);

const corpusFile = z.strictObject({
  source: z.string().min(1),
  file: z.string().min(1),
  sha256: sha256Schema,
  bytes: z.int().positive(),
  license: z.string().min(1),
  language: z.enum([...languages, "none"]),
  as: workspacePath,
});
export type CorpusFile = z.infer<typeof corpusFile>;

export const catalogFilesSchema = z.record(fileId, corpusFile);

const tolerance = z.number().nonnegative();

const field = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("integer"), value: z.int() }),
  z.strictObject({
    kind: z.literal("decimal"),
    value: z.number(),
    tolerance,
  }),
  z.strictObject({
    kind: z.literal("percent"),
    value: z.number(),
    tolerance,
  }),
  z.strictObject({ kind: z.literal("text"), value: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("date"),
    value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.strictObject({
    kind: z.literal("month"),
    value: z.string().regex(/^\d{4}-\d{2}$/),
  }),
  z.strictObject({
    kind: z.literal("localDateTime"),
    value: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
  }),
]);
export type Field = z.infer<typeof field>;
export type FieldKind = Field["kind"];

export const refusalReasons = [
  "notInFile",
  "suppressed",
  "ambiguous",
  "readOnly",
  "limit",
] as const;
export type RefusalReason = (typeof refusalReasons)[number];

const answer = z.discriminatedUnion("kind", [
  ...field.options,
  z.strictObject({ kind: z.literal("list"), items: z.tuple([field], field) }),
  z.strictObject({ kind: z.literal("set"), items: z.tuple([field], field) }),
  z.strictObject({
    kind: z.literal("record"),
    fields: z.record(z.string().min(1), field),
  }),
  z.strictObject({
    kind: z.literal("refusal"),
    reason: z.enum(refusalReasons),
    shape: z.enum([
      "integer",
      "decimal",
      "percent",
      "text",
      "date",
      "month",
      "localDateTime",
      "list",
      "set",
    ]),
  }),
]);
export type Answer = z.infer<typeof answer>;

const toolName = z.custom<ToolName>(
  (value) =>
    typeof value === "string" && toolNames.some((name) => name === value),
);

const step = z.strictObject({
  tool: toolName,
  args: z.record(z.string(), z.unknown()),
  role: z.enum(["discover", "answer"]),
  expectError: z.string().min(1).optional(),
});
export type PlanStep = z.infer<typeof step>;

const plan = z.strictObject({
  steps: z.array(step),
  derive: exprSchema.optional(),
  confirm: z
    .strictObject({ value: exprSchema, equals: z.unknown() })
    .optional(),
});
export type Plan = z.infer<typeof plan>;

export const taskSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  level: z.enum(levels),
  knowledge: z.enum(knowledgeLevels),
  cases: z.array(z.enum(caseIds)).min(1),
  files: z.array(fileId).min(1),
  question: z.strictObject({ tr: z.string().min(1), en: z.string().min(1) }),
  answer,
  plan,
});
export type Task = z.infer<typeof taskSchema>;

const catalogSchema = z
  .strictObject({
    files: catalogFilesSchema,
    tasks: z.array(taskSchema).min(1),
    uncovered: z.partialRecord(z.enum(caseIds), z.string().min(1)),
  })
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const id of Object.keys(catalog.uncovered))
      if (
        catalog.tasks.some((entry) => entry.cases.some((used) => used === id))
      )
        context.addIssue({
          code: "custom",
          message: `case ${id} is marked uncovered but a task exercises it`,
          path: ["uncovered", id],
        });
    for (const [id, file] of Object.entries(catalog.files)) {
      if (paths.has(file.as))
        context.addIssue({
          code: "custom",
          message: `workspace path ${file.as} is used twice`,
          path: ["files", id],
        });
      paths.add(file.as);
    }
    catalog.tasks.forEach((entry, at) => {
      if (ids.has(entry.id))
        context.addIssue({
          code: "custom",
          message: `duplicate task ${entry.id}`,
          path: ["tasks", at],
        });
      ids.add(entry.id);
      for (const file of entry.files)
        if (!(file in catalog.files))
          context.addIssue({
            code: "custom",
            message: `task ${entry.id} names unknown file ${file}`,
            path: ["tasks", at, "files"],
          });
      const needs =
        entry.answer.kind !== "refusal"
          ? "derive"
          : entry.answer.reason === "readOnly"
            ? null
            : "confirm";
      for (const key of ["derive", "confirm"] as const)
        if ((entry.plan[key] !== undefined) !== (needs === key))
          context.addIssue({
            code: "custom",
            message: `task ${entry.id} ${needs === key ? "needs" : "must not have"} plan.${key}`,
            path: ["tasks", at, "plan", key],
          });
      entry.plan.steps.forEach((planned, index) => {
        const parsed = toolDefinitions[planned.tool].inputSchema.safeParse(
          planned.args,
        );
        if (!parsed.success)
          context.addIssue({
            code: "custom",
            message: `task ${entry.id} step ${index + 1} (${planned.tool}): ${parsed.error.message}`,
            path: ["tasks", at, "plan", "steps", index],
          });
      });
    });
  });
export type Catalog = z.infer<typeof catalogSchema>;

export const catalogPath = new URL("./catalog.json", import.meta.url);

/** Reads and validates the task catalog, including every planned call against its tool schema. */
export async function readCatalog(
  path: URL | string = catalogPath,
): Promise<Catalog> {
  return catalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export interface Coverage {
  readonly tasks: number;
  readonly missingCases: readonly CaseId[];
  readonly uncovered: Readonly<Partial<Record<CaseId, string>>>;
  readonly missingTools: readonly ToolName[];
  readonly missingLevels: readonly string[];
  readonly missingKnowledge: readonly string[];
  readonly missingPairings: readonly string[];
  readonly casesUsed: Readonly<Partial<Record<CaseId, number>>>;
}

/** Lists what the catalog does not yet exercise: case ids, tools, levels, knowledge levels and question/file language pairings. */
export function coverageOf(catalog: Catalog): Coverage {
  const casesUsed: Partial<Record<CaseId, number>> = {};
  const tools = new Set<ToolName>();
  const levelsSeen = new Set<string>();
  const knowledgeSeen = new Set<string>();
  const pairings = new Set<string>();
  for (const entry of catalog.tasks) {
    for (const id of entry.cases) casesUsed[id] = (casesUsed[id] ?? 0) + 1;
    for (const planned of entry.plan.steps) tools.add(planned.tool);
    levelsSeen.add(entry.level);
    knowledgeSeen.add(entry.knowledge);
    for (const file of entry.files) {
      const fileLanguage = catalog.files[file]?.language;
      if (fileLanguage === undefined || fileLanguage === "none") continue;
      for (const question of languages)
        pairings.add(`${question}->${fileLanguage}`);
    }
  }
  return {
    tasks: catalog.tasks.length,
    missingCases: caseIds.filter(
      (id) =>
        casesUsed[id] === undefined && catalog.uncovered[id] === undefined,
    ),
    uncovered: catalog.uncovered,
    missingTools: toolNames.filter((name) => !tools.has(name)),
    missingLevels: levels.filter((level) => !levelsSeen.has(level)),
    missingKnowledge: knowledgeLevels.filter(
      (level) => !knowledgeSeen.has(level),
    ),
    missingPairings: languages
      .flatMap((question) => languages.map((file) => `${question}->${file}`))
      .filter((pairing) => !pairings.has(pairing)),
    casesUsed,
  };
}
