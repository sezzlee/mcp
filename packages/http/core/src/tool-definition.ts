import type { EndpointDescriptor } from "./generated/endpoint-descriptor.js";
import type {
  ToolAnnotations,
  ToolDefinition,
} from "./generated/tool-definition.js";
import { assertUniqueArgumentNames } from "./argument-names.js";
import { canonicalJson } from "./canonical-json.js";
import { curationShapeOf, resolveCuration } from "./curation.js";
import type { CurationRelief } from "./curation.js";
import type { ToolVariant } from "./generated/endpoint-descriptor.js";
import { SezzleeTemplateError } from "./errors.js";
import type { JsonSchemaObject } from "./generated/endpoint-descriptor.js";
import {
  additionalPropertiesOf,
  allowsAdditional,
  flattenableBody,
  typeOf,
  type ObjectSchema,
} from "./json-schema.js";
import { createToolName } from "./naming.js";
import { publishFileSchema } from "./file-argument.js";
import type { FileOptions } from "./file-argument.js";
import { isBinaryMediaType, multipartMediaType } from "./request-template.js";

function describe(
  schema: JsonSchemaObject,
  description: string | undefined,
): JsonSchemaObject {
  const clone = structuredClone(schema);
  if (
    description !== undefined &&
    description.trim() !== "" &&
    clone["description"] == null
  ) {
    clone["description"] = description;
  }
  return clone;
}

export const bodyRootArgument = "body";

export type BodyRootReason =
  "optional" | "non_object" | "unflattenable_root" | "collision";

/**
 * The body-root keys flattening consumes, preserves elsewhere, or drops by rule.
 *
 * `description` is dropped deliberately — flattening leaves no slot for it. `$defs` and
 * `additionalProperties` are carried to the tool root. Everything else here is consumed.
 */
const flattenableKeys = new Set([
  "type",
  "properties",
  "required",
  "$defs",
  "additionalProperties",
  "description",
]);

/**
 * Body-root keys that annotate without constraining, and so must not force root mode.
 *
 * The list has to be generous: root mode raises `argument_collision` when the endpoint already has a
 * parameter named `body`, so a key wrongly treated as a constraint turns a working tool into a
 * dropped one. `$schema` in particular is written by `zod-to-json-schema` and by any standalone
 * serialization, and reaches this predicate through a `verbatim` host schema; it names a dialect, and
 * the only keywords flattening reads — `properties` and `required` — mean the same in every dialect.
 *
 * A key that decides **where a `$ref` resolves** is never an annotation, however it reads. `$id`
 * makes the body root its own schema resource and rebases every reference inside it; `$anchor`
 * declares a plain-name fragment that a `{"$ref":"#Name"}` in a lifted property points at. Dropping
 * either leaves the references spelled correctly and aimed at nothing, which is the same defect as a
 * lost `$defs` bag. Both stay out of this set, and out of the flattenable set, so they take the root
 * argument.
 */
const ignoredKeys = new Set([
  "title",
  "$schema",
  "$comment",
  "example",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/**
 * Names the body-root key that flattening would silently discard, if there is one.
 *
 * @returns the key, for a diagnostic to name; `undefined` when every key is safe.
 */
export function unflattenableRootKey(
  body: JsonSchemaObject,
): string | undefined {
  if (Array.isArray(body.type)) {
    return "type";
  }
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      continue;
    }
    if (
      flattenableKeys.has(key) ||
      ignoredKeys.has(key) ||
      key.startsWith("x-")
    ) {
      continue;
    }
    return key;
  }
  return undefined;
}

/**
 * Names the body field flattening would merge onto a parameter of the same name, if there is one.
 *
 * MCP gives tool arguments one namespace and no `in`, so a flattened field and a parameter that
 * share a name would claim one key for two wire slots. Nothing in the descriptor says whether they
 * denote the same value — `POST /orders/{id}` with a body field `id` says yes, and
 * `POST /projects/{id}/members/{memberId}` with a body field `id` says no — so neither reading may
 * be guessed and the body takes the root argument instead.
 *
 * @returns the field name, for a diagnostic to name; `undefined` when flattening is unambiguous.
 */
export function collidingBodyField(
  body: JsonSchemaObject,
  parameterNames: Iterable<string>,
): string | undefined {
  const taken = new Set(parameterNames);
  for (const name of Object.keys(body.properties ?? {})) {
    if (taken.has(name)) {
      return name;
    }
  }
  return undefined;
}

/**
 * Decides whether the body travels as one synthetic argument instead of flattening.
 *
 * Flattening preserves a body root's `properties` and `required` and nothing else, so it is allowed
 * only for a root that carries nothing else worth keeping. The direction is deliberate: an
 * unrecognised keyword wraps the body rather than dropping the keyword, because a wrapped body is
 * complete and merely less ergonomic, while a dropped keyword publishes a contract the backend does
 * not honour. `minProperties` and `propertyNames` are the clearest cases — both count or match
 * *every* key, and after flattening the tool root's keys include the path and query parameters.
 *
 * @param required the body-level `requestBody.required`; `false` forces root mode, because a
 * flattened body has no wrapper left to omit and would always send `{}`.
 * @param parameterNames the endpoint's parameter names, which flattening would share a namespace
 * with; a field that collides with one of them forces root mode.
 * @returns why the body needs a root argument, or `undefined` to flatten its fields.
 */
export function bodyRootReasonOf(
  body: JsonSchemaObject | undefined,
  required?: boolean,
  parameterNames: Iterable<string> = [],
): BodyRootReason | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (required === false) {
    return "optional";
  }
  const type = typeOf(body);
  if (type !== undefined && type !== "object") {
    return "non_object";
  }
  if (unflattenableRootKey(body) !== undefined) {
    return "unflattenable_root";
  }
  if (body.properties === undefined && !allowsAdditional(body)) {
    return "unflattenable_root";
  }
  if (collidingBodyField(body, parameterNames) !== undefined) {
    return "collision";
  }
  return undefined;
}

/**
 * @returns the synthetic argument name, or `undefined` to flatten the body's fields.
 */
export function bodyRootOf(
  body: JsonSchemaObject | undefined,
  required?: boolean,
  parameterNames: Iterable<string> = [],
): string | undefined {
  return bodyRootReasonOf(body, required, parameterNames) === undefined
    ? undefined
    : bodyRootArgument;
}

type InputSchema = Omit<ObjectSchema, "additionalProperties"> & {
  additionalProperties: boolean | JsonSchemaObject;
};

function withFileArguments(
  body: JsonSchemaObject,
  files: FileOptions | undefined,
): JsonSchemaObject {
  if (body.properties === undefined) {
    return body;
  }
  const properties: Record<string, JsonSchemaObject> = {};
  for (const [name, schema] of Object.entries(body.properties)) {
    properties[name] = publishFileSchema(schema, name, files);
  }
  return { ...body, properties };
}

function buildInputSchema(
  endpoint: EndpointDescriptor,
  variant: ToolVariant | undefined,
  relief: CurationRelief | undefined,
  files: FileOptions | undefined,
): InputSchema {
  const multipart = endpoint.requestBody?.contentType === multipartMediaType;
  const bodyType = endpoint.requestBody?.contentType;
  const binary = bodyType !== undefined && isBinaryMediaType(bodyType);
  const parameters = endpoint.parameters ?? [];
  const body = endpoint.requestBody?.schema;
  const bodyRequired = endpoint.requestBody?.required;
  const parameterNames = parameters.map((parameter) => parameter.name);
  const root = bodyRootOf(body, bodyRequired, parameterNames);
  const flattened = root === undefined ? flattenableBody(body) : undefined;

  assertUniqueArgumentNames(
    parameterNames,
    root !== undefined
      ? [root]
      : flattened === undefined
        ? []
        : Object.keys(flattened.properties),
  );

  const curation = resolveCuration(
    endpoint,
    variant,
    curationShapeOf(
      parameterNames,
      parameters.filter((parameter) => parameter.required).map((p) => p.name),
      flattened === undefined ? [] : Object.keys(flattened.properties),
      flattened?.required ?? [],
      root,
      bodyRequired !== false,
    ),
    relief,
  );

  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];
  const claimed = new Set<string>();
  const require = (name: string): void => {
    if (!claimed.has(name)) {
      claimed.add(name);
      required.push(name);
    }
  };
  /**
   * A curation description overrides, including one the schema already carries.
   * This is the one place the "the schema source takes precedence" rule is
   * inverted: a parameter description is a fallback for a missing one, whereas
   * a curation description is the host stating what the agent should read.
   */
  const publish = (
    wireName: string,
    schema: JsonSchemaObject,
  ): string | undefined => {
    const resolved = curation.byWireName.get(wireName);
    if (resolved?.fill !== undefined) {
      return undefined;
    }
    const key = resolved?.argument ?? wireName;
    if (resolved?.description !== undefined) {
      schema["description"] = resolved.description;
    }
    properties[key] = schema;
    return key;
  };

  for (const parameter of parameters) {
    const key = publish(
      parameter.name,
      describe(parameter.schema, parameter.description),
    );
    if (key !== undefined && parameter.required) {
      require(key);
    }
  }

  if (root !== undefined && body !== undefined) {
    const cloned = structuredClone(body);
    const key = publish(
      root,
      multipart
        ? withFileArguments(cloned, files)
        : binary
          ? publishFileSchema(cloned, root, files)
          : cloned,
    );
    if (key !== undefined && bodyRequired !== false) {
      require(key);
    }
  }

  if (flattened !== undefined) {
    for (const [name, schema] of Object.entries(flattened.properties)) {
      const cloned = structuredClone(schema);
      publish(
        name,
        multipart ? publishFileSchema(cloned, name, files) : cloned,
      );
    }
    for (const name of flattened.required) {
      /**
       * The wire-to-agent mapping happens before the guard on purpose: a
       * renamed required field is keyed by its agent name, so a guard that
       * looked up the wire name would find nothing and silently drop the
       * requiredness.
       */
      const resolved = curation.byWireName.get(name);
      if (resolved?.fill !== undefined) {
        continue;
      }
      const key = resolved?.argument ?? name;
      if (Object.hasOwn(properties, key)) {
        require(key);
      }
    }
  }

  const schema: InputSchema = {
    type: "object",
    properties,
    required,
    additionalProperties: root === undefined && additionalPropertiesOf(body),
  };
  const defs = liftDefs(
    properties,
    root === undefined ? body?.$defs : undefined,
  );
  if (defs !== undefined) {
    schema.$defs = defs;
  }
  return schema;
}

const resultRootProperty = "result";

const preferredStatuses = ["200", "201", "202", "204"];

function primaryResponseOf(
  responses: NonNullable<EndpointDescriptor["responses"]>,
): JsonSchemaObject | undefined {
  const successes = Object.keys(responses).filter((status) =>
    /^2[0-9]{2}$/.test(status),
  );
  const chosen =
    preferredStatuses.find((status) => successes.includes(status)) ??
    successes.sort((left, right) => Number(left) - Number(right))[0] ??
    (responses["2XX"] === undefined ? undefined : "2XX");
  return chosen === undefined ? undefined : responses[chosen]?.schema;
}

function isObjectRoot(schema: JsonSchemaObject): boolean {
  const type = schema.type;
  if (typeof type === "string") {
    return type === "object";
  }
  if (!Array.isArray(type)) {
    return false;
  }
  const declared = type.filter((candidate) => candidate !== "null");
  return declared.length === 1 && declared[0] === "object";
}

/**
 * Produces the schema of what the tool returns, or nothing when the endpoint declares no success
 * body.
 *
 * A non-object root is wrapped under `result` because MCP requires `outputSchema` to be an object.
 * The wrapped schema's `$defs` MUST move to the wrapper root: a `#/$defs/...` inside it resolves
 * against the document root, so a bag left under `properties.result` leaves every reference aimed at
 * nothing. A root declaring `$id` is its own schema resource and rebases its own references, so
 * `liftDefs` leaves it alone — the same rule that keeps such a root out of body flattening.
 *
 * `additionalProperties` is never written here. On `inputSchema` it binds what the caller may send;
 * a response is the backend's own shape and the agent is not the party constrained by it.
 */
function buildOutputSchema(
  endpoint: EndpointDescriptor,
): JsonSchemaObject | undefined {
  const responses = endpoint.responses;
  if (responses === undefined) {
    return undefined;
  }
  const primary = primaryResponseOf(responses);
  if (primary === undefined) {
    return undefined;
  }
  if (isObjectRoot(primary)) {
    return structuredClone(primary);
  }
  const properties = { [resultRootProperty]: structuredClone(primary) };
  const schema: JsonSchemaObject = {
    type: "object",
    properties,
    required: [resultRootProperty],
  };
  const defs = liftDefs(properties, undefined);
  if (defs !== undefined) {
    schema.$defs = defs;
  }
  return schema;
}

/**
 * Merges every `$defs` bag reachable from the tool's own root into one.
 *
 * A property declaring `$id` is skipped: it is its own schema resource, so a `#/$defs/...` inside it
 * resolves against that `$id` and not against the tool document. Hoisting its bag to the tool root
 * would leave those references aimed at nothing — the very defect hoisting exists to prevent.
 *
 * @param seed the flattened body's own root bag. A flattened body contributes its properties to
 * `properties` but its root — and therefore its bag — is never emitted, so without this the `$ref`s
 * lifted out of it would point at nothing. It is cloned and its source is left intact: the
 * descriptor is shared across the catalog snapshot, so stripping `$defs` from it would break every
 * tool built after the first. A root declaring `$id` never reaches here, because it takes the root
 * argument instead of flattening.
 * @throws SezzleeTemplateError `schema_def_conflict` when one key carries two different schemas.
 */
function liftDefs(
  properties: Record<string, JsonSchemaObject>,
  seed: Record<string, JsonSchemaObject> | undefined,
): Record<string, JsonSchemaObject> | undefined {
  const merged: Record<string, JsonSchemaObject> = {};
  let found = false;
  const take = (name: string, body: JsonSchemaObject): void => {
    const existing = merged[name];
    if (existing !== undefined) {
      /**
       * Guard: the conflict check MUST NOT see two spellings of one schema as two schemas. Plain
       * `JSON.stringify` is key-order sensitive while the .NET side compares with
       * `JsonNode.DeepEquals`, which is not — so a parameter bag and a body bag carrying the same
       * type in a different key order would drop the endpoint here and build the tool there.
       */
      if (canonicalJson(existing) !== canonicalJson(body)) {
        throw new SezzleeTemplateError(
          "schema_def_conflict",
          `Two schemas define '${name}' differently; the tool cannot be built.`,
        );
      }
      return;
    }
    merged[name] = body;
    found = true;
  };

  if (seed !== undefined) {
    for (const [name, body] of Object.entries(seed)) {
      take(name, structuredClone(body));
    }
  }
  for (const schema of Object.values(properties)) {
    const own = schema.$defs;
    if (own === undefined) {
      continue;
    }
    if (schema.$id !== undefined) {
      continue;
    }
    delete schema.$defs;
    for (const [name, body] of Object.entries(own)) {
      take(name, body);
    }
  }
  if (!found) {
    return undefined;
  }
  const ordered: Record<string, JsonSchemaObject> = {};
  for (const name of Object.keys(merged).sort()) {
    ordered[name] = merged[name] as JsonSchemaObject;
  }
  return ordered;
}

function annotate(
  endpoint: EndpointDescriptor,
  variant: ToolVariant | undefined,
): ToolAnnotations {
  return {
    ...impliedAnnotations(endpoint.method),
    ...endpoint.annotations,
    ...variant?.annotations,
  };
}

function impliedAnnotations(method: string): ToolAnnotations {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "QUERY":
      return { readOnlyHint: true, idempotentHint: true };
    case "POST":
      return { destructiveHint: false };
    case "PUT":
      return { destructiveHint: true, idempotentHint: true };
    case "PATCH":
      return { destructiveHint: true };
    case "DELETE":
      return { destructiveHint: true, idempotentHint: true };
    default:
      return {};
  }
}

export function createToolDefinition(
  endpoint: EndpointDescriptor,
  name?: string,
  variant?: ToolVariant,
  relief?: CurationRelief,
  files?: FileOptions,
): ToolDefinition {
  const declared = variant?.description ?? endpoint.description;
  const description =
    declared === undefined || declared.trim() === ""
      ? `${endpoint.method} ${endpoint.route}`
      : declared;
  const outputSchema = buildOutputSchema(endpoint);
  return {
    name: name ?? variant?.name ?? createToolName(endpoint),
    description,
    inputSchema: buildInputSchema(endpoint, variant, relief, files),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(endpoint.deprecated === true ? { deprecated: true } : {}),
    annotations: annotate(endpoint, variant),
    auth: endpoint.auth,
  };
}
