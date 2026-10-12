import type { CatalogSeverity } from "./catalog/diagnostics.js";
import { SezzleeTemplateError, type FamilyErrorCode } from "./errors.js";
import type {
  ArgumentCuration,
  EndpointDescriptor,
  JsonSchemaObject,
  Parameter,
  ToolVariant,
} from "./generated/endpoint-descriptor.js";

export const familySeverities = {
  family_parameter_unresolved: "endpointDropped",
  family_without_members: "endpointDropped",
  family_key_unfilled: "endpointDropped",
  family_key_duplicate: "endpointDropped",
  variant_body_without_family: "endpointDropped",
  variant_body_invalid: "endpointDropped",
} as const satisfies Readonly<Record<FamilyErrorCode, CatalogSeverity>>;

type FamilyKey = string | number | boolean;

const scalarTypes: ReadonlySet<string> = new Set([
  "string",
  "integer",
  "number",
  "boolean",
]);

const dispatchable = (parameter: Parameter): boolean => {
  const type = parameter.schema.type;
  const types = typeof type === "string" ? [type] : (type ?? []);
  return (
    parameter.in !== "querystring" &&
    types.length > 0 &&
    types.every((name) => scalarTypes.has(name))
  );
};

const isFamilyKey = (value: unknown): value is FamilyKey =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const recordFor = (
  operation: EndpointDescriptor,
  variant: ToolVariant,
  name: string,
): ArgumentCuration | undefined =>
  variant.arguments?.find((record) => record.name === name) ??
  operation.arguments?.find((record) => record.name === name);

/**
 * Refuses a family whose lowered form could publish the dispatcher itself.
 *
 * Every member must write its own distinct key into the dispatch parameter as a hidden constant.
 * A member that leaves the parameter visible, or fills it at invoke time, hands the agent a tool
 * that can reach every other member's capability through one name, which is the exposure the
 * family exists to remove. A family with no member produces nothing rather than the uncurated
 * dispatcher, for the same reason.
 *
 * @param operation the declared operation, before any production is derived from it
 */
export function assertFamily(operation: EndpointDescriptor): void {
  const where = `${operation.method} ${operation.route}`;
  const family = operation.family;
  if (family === undefined) {
    const bodied = operation.variants?.find(
      (variant) => variant.requestBody !== undefined,
    );
    if (bodied !== undefined) {
      throw new SezzleeTemplateError(
        "variant_body_without_family",
        `Variant '${bodied.name}' of ${where} declares its own request body; only a family member may replace the operation's body.`,
      );
    }
    return;
  }
  const parameter = operation.parameters?.find(
    (candidate) => candidate.name === family.parameter,
  );
  if (parameter === undefined || !dispatchable(parameter)) {
    throw new SezzleeTemplateError(
      "family_parameter_unresolved",
      `${where} dispatches on '${family.parameter}', which is not a declared scalar parameter outside the body.`,
    );
  }
  if (operation.variants === undefined) {
    throw new SezzleeTemplateError(
      "family_without_members",
      `${where} declares a family on '${family.parameter}' with no member; no tool is produced for it.`,
    );
  }
  const claimed = new Map<string, string>();
  for (const variant of operation.variants) {
    const fill = recordFor(operation, variant, family.parameter)?.hidden;
    if (fill?.kind !== "constant" || !isFamilyKey(fill.value)) {
      throw new SezzleeTemplateError(
        "family_key_unfilled",
        `Member '${variant.name}' of ${where} does not write a scalar constant into '${family.parameter}'; a member must hide its own key.`,
      );
    }
    const key = JSON.stringify(fill.value);
    const first = claimed.get(key);
    if (first !== undefined) {
      throw new SezzleeTemplateError(
        "family_key_duplicate",
        `Members '${first}' and '${variant.name}' of ${where} both dispatch with key ${key}.`,
      );
    }
    claimed.set(key, variant.name);
    const problem =
      variant.requestBody === undefined
        ? undefined
        : declaredSchemaProblem(variant.requestBody.schema);
    if (problem !== undefined) {
      throw new SezzleeTemplateError(
        "variant_body_invalid",
        `Member '${variant.name}' of ${where} declares a body schema that ${problem}.`,
      );
    }
  }
}

/**
 * The descriptor one production is built from: the operation, with a family member's body in
 * place of the operation's.
 *
 * Both the published input schema and the request template read this one object, so the two can
 * never disagree about which body a member sends. The media type and object notation stay the
 * operation's, because they describe the backend's parser, not the member.
 *
 * @returns the operation itself when the variant declares no body
 */
export function productionDescriptor(
  operation: EndpointDescriptor,
  variant: ToolVariant | undefined,
): EndpointDescriptor {
  const body = variant?.requestBody;
  if (body === undefined) {
    return operation;
  }
  const base = operation.requestBody;
  const description = body.description ?? base?.description;
  return {
    ...operation,
    requestBody: {
      schema: body.schema,
      ...(body.required === undefined ? {} : { required: body.required }),
      ...(description === undefined ? {} : { description }),
      ...(base?.contentType === undefined
        ? {}
        : { contentType: base.contentType }),
      ...(base?.objectNotation === undefined
        ? {}
        : { objectNotation: base.objectNotation }),
    },
  };
}

const schemaMaps = ["properties", "patternProperties", "$defs"] as const;
const schemaValues = [
  "items",
  "additionalProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
] as const;
const schemaLists = ["anyOf", "oneOf", "allOf"] as const;
const identityKeywords = [
  "$id",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
] as const;

const isSchema = (value: unknown): value is JsonSchemaObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function* subschemas(schema: JsonSchemaObject): Generator<JsonSchemaObject> {
  const node = schema as Record<string, unknown>;
  for (const keyword of schemaMaps) {
    const map = node[keyword];
    if (isSchema(map)) {
      yield* Object.values(map).filter(isSchema);
    }
  }
  for (const keyword of schemaValues) {
    const value = node[keyword];
    if (isSchema(value)) {
      yield value;
    }
  }
  for (const keyword of schemaLists) {
    const list = node[keyword];
    if (Array.isArray(list)) {
      yield* list.filter(isSchema);
    }
  }
}

function* walk(schema: JsonSchemaObject): Generator<JsonSchemaObject> {
  yield schema;
  for (const child of subschemas(schema)) {
    yield* walk(child);
  }
}

const unescapePointer = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

/**
 * Checks that a host-declared body schema is self-contained.
 *
 * A member body arrives verbatim from host data rather than from a discovered type, so nothing
 * upstream has resolved it. A `$ref` that leaves the schema's own `$defs` would be followed by
 * whichever validator the agent's client runs, and an identity keyword re-bases every relative
 * reference beneath it; both make the published schema mean something the composer never checks.
 *
 * @returns a clause describing the first problem, or `undefined` when the schema is self-contained
 */
export function declaredSchemaProblem(
  schema: JsonSchemaObject,
): string | undefined {
  const nodes = [...walk(schema)];
  const definitions = new Set<string>();
  for (const node of nodes) {
    for (const name of Object.keys(node.$defs ?? {})) {
      definitions.add(name);
    }
  }
  for (const node of nodes) {
    const keyword = identityKeywords.find(
      (candidate) => (node as Record<string, unknown>)[candidate] !== undefined,
    );
    if (keyword !== undefined) {
      return `carries '${keyword}'`;
    }
    const ref = node.$ref;
    if (ref === undefined) {
      continue;
    }
    const local = /^#\/\$defs\/([^/]+)$/.exec(ref);
    if (local === null || !definitions.has(unescapePointer(local[1] ?? ""))) {
      return `references '${ref}', which is not one of its own definitions`;
    }
  }
  return undefined;
}
