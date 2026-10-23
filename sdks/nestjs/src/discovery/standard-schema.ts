import { declaredSchemaProblem, type JsonSchemaObject } from "@sezzlee/core";

/**
 * A schema implementing Standard JSON Schema (zod 4.2 or later, valibot, ArkType): the converter
 * Nest 12's `@Body({ schema })` and an `@McpTool({ responses })` entry are read through.
 */
export interface StandardJsonSchema {
  readonly "~standard": {
    readonly jsonSchema: {
      readonly input: (options: {
        readonly target: string;
      }) => Record<string, unknown>;
      readonly output: (options: {
        readonly target: string;
      }) => Record<string, unknown>;
    };
  };
}

export type SchemaReading =
  | { readonly kind: "read"; readonly schema: JsonSchemaObject }
  | { readonly kind: "unreadable"; readonly reason: string };

export function isStandardSchema(declared: unknown): boolean {
  return (
    typeof declared === "object" && declared !== null && "~standard" in declared
  );
}

/**
 * Converts a Standard Schema to the JSON Schema of what it accepts (`input`) or produces (`output`).
 *
 * @returns `undefined` when `declared` is not a Standard Schema at all
 */
export function readStandardSchema(
  declared: unknown,
  side: "input" | "output",
): SchemaReading | undefined {
  if (!isStandardSchema(declared)) {
    return undefined;
  }
  const converter = (
    declared as { "~standard": { jsonSchema?: Record<string, unknown> } }
  )["~standard"].jsonSchema?.[side];
  if (typeof converter !== "function") {
    return {
      kind: "unreadable",
      reason:
        "its schema does not implement Standard JSON Schema (zod 4.2 or later does)",
    };
  }
  let converted: unknown;
  try {
    converted = (
      converter as StandardJsonSchema["~standard"]["jsonSchema"][typeof side]
    )({ target: "draft-2020-12" });
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `its schema cannot be written as JSON Schema (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (
    typeof converted !== "object" ||
    converted === null ||
    Array.isArray(converted)
  ) {
    return {
      kind: "unreadable",
      reason:
        "its schema converts to something other than a JSON Schema object",
    };
  }
  const { $schema: _dialect, ...schema } = converted as Record<string, unknown>;
  const problem = declaredSchemaProblem(schema as JsonSchemaObject);
  return problem === undefined
    ? { kind: "read", schema: schema as JsonSchemaObject }
    : { kind: "unreadable", reason: `its JSON Schema ${problem}` };
}
