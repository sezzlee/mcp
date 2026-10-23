import type { JsonSchemaObject } from "./generated/endpoint-descriptor.js";

export type JsonSchemaType = Extract<
  NonNullable<JsonSchemaObject["type"]>,
  string
>;

export type ObjectSchema = JsonSchemaObject & {
  type: "object";
  properties: Record<string, JsonSchemaObject>;
  required: string[];
  additionalProperties: boolean;
};

export function typeOf(
  schema: JsonSchemaObject | undefined,
): JsonSchemaType | undefined {
  const type = schema?.type;
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type)) {
    return type.find((candidate) => candidate !== "null");
  }
  return undefined;
}

export function isObjectSchema(schema: JsonSchemaObject): boolean {
  return typeOf(schema) === "object";
}

export function allowsAdditional(
  schema: JsonSchemaObject | undefined,
): boolean {
  const additional = schema?.additionalProperties;
  if (typeof additional === "boolean") {
    return additional;
  }
  return additional !== undefined;
}

/**
 * Reads a body's `additionalProperties` as the tool root should write it.
 *
 * A body that types its extra keys (`{"additionalProperties":{"type":"integer"}}`) says more than
 * "extra keys are allowed", and the tool root can carry that verbatim: `additionalProperties`
 * constrains only keys absent from `properties`, and every parameter is named there, so lifting the
 * rule cannot reach them. The result is cloned because it lands in a schema the caller owns.
 *
 * @returns the value schema, or the boolean {@link allowsAdditional} reports.
 */
export function additionalPropertiesOf(
  schema: JsonSchemaObject | undefined,
): boolean | JsonSchemaObject {
  const additional = schema?.additionalProperties;
  return typeof additional === "object" && additional !== null
    ? structuredClone(additional)
    : allowsAdditional(schema);
}

export interface FlattenableBody {
  readonly properties: Readonly<Record<string, JsonSchemaObject>>;
  readonly required: readonly string[];
}

export function flattenableBody(
  schema: JsonSchemaObject | undefined,
): FlattenableBody | undefined {
  const properties = schema?.properties;
  if (properties === undefined) {
    return undefined;
  }
  const required = schema?.required;
  return { properties, required: Array.isArray(required) ? required : [] };
}

/**
 * Widens a schema to admit `null`: into its `type` list, and into its `enum` too, since an enum that
 * omits `null` still rejects it; a schema with no `type`, such as a `$ref`, is put beside a `null`
 * branch instead.
 */
export function admittingNull(schema: JsonSchemaObject): JsonSchemaObject {
  const type = schema.type;
  if (typeof type === "string") {
    return {
      ...schema,
      type: [type, "null"],
      ...(Array.isArray(schema.enum) && !schema.enum.includes(null)
        ? { enum: [...schema.enum, null] }
        : {}),
    } as JsonSchemaObject;
  }
  if (Array.isArray(type)) {
    return type.includes("null")
      ? schema
      : ({ ...schema, type: [...type, "null"] } as JsonSchemaObject);
  }
  return { anyOf: [schema, { type: "null" }] } as JsonSchemaObject;
}
