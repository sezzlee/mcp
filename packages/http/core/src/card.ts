import type { JsonSchemaObject } from "./generated/endpoint-descriptor.js";
import type { ToolDefinition } from "./generated/tool-definition.js";
import type { VisibilityDecision } from "./visibility.js";

export const cardDescriptionBudget = 160;
export const defaultSearchLimit = 20;
export const maxSearchLimit = 50;
/**
 * How many distinct tags a `search_tools` answer lists before offering none at all.
 *
 * Guard: the vocabulary describes the catalog, not the query, so none of the narrowing arguments
 * shrinks it and an over-budget answer would be unactionable. Truncating instead would be worse
 * than omitting: an agent that does not see a tag concludes it does not exist.
 */
export const maxSearchTagVocabulary = 200;

export interface Card {
  readonly name: string;
  readonly description: string;
  readonly parameters: string;
  readonly deprecated?: boolean;
  readonly authUncertain?: boolean;
}

export function truncateDescription(text: string): string {
  if (text.length <= cardDescriptionBudget) {
    return text;
  }
  const cut = text.lastIndexOf(" ", cardDescriptionBudget);
  const body =
    cut > cardDescriptionBudget / 2
      ? text.slice(0, cut)
      : text.slice(0, cardDescriptionBudget);
  return `${body}…`;
}

/**
 * Guard: the schema may be a host-supplied verbatim schema that no validator has
 * seen, so `properties`, `required`, a member schema and a member `type` can each
 * be any JSON value. Each unusable shape contributes nothing rather than throwing.
 * Without the narrowing a malformed member threw here, which took down the whole
 * `search_tools` call rather than one card.
 */
export function summarizeParameters(inputSchema: JsonSchemaObject): string {
  const properties: unknown = inputSchema.properties;
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties)
  ) {
    return "";
  }
  const declared: unknown = inputSchema.required;
  const required = new Set(
    Array.isArray(declared)
      ? declared.filter((name): name is string => typeof name === "string")
      : [],
  );
  const defs: unknown = inputSchema.$defs;
  const parts: string[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    const type = typeLabel(
      schema,
      typeof defs === "object" && defs !== null && !Array.isArray(defs)
        ? (defs as Record<string, unknown>)
        : {},
    );
    parts.push(
      required.has(name) ? `${name}: ${type} (required)` : `${name}: ${type}`,
    );
  }
  return parts.join(", ");
}

/**
 * Projects a tool's published `inputSchema` into the terms the search index
 * carries under `parameters`: each root property key, that property's
 * `description` when it is a string, and — for a property named in `grouped` —
 * its own member keys, one level down.
 *
 * Guard: `inputSchema` may be a host-supplied verbatim schema that no validator
 * has seen, so `properties`, a member schema and a `description` can each be any
 * JSON value. Narrowing each one keeps a malformed schema from throwing during
 * catalog construction.
 */
export function searchParameters(
  inputSchema: JsonSchemaObject,
  grouped: ReadonlySet<string> = new Set(),
): readonly string[] {
  const properties: unknown = inputSchema.properties;
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties)
  ) {
    return [];
  }
  const terms: string[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    terms.push(name);
    const description: unknown = (schema as { description?: unknown } | null)
      ?.description;
    if (typeof description === "string") {
      terms.push(description);
    }
    if (grouped.has(name)) {
      terms.push(...memberTerms(name, schema));
    }
  }
  return terms;
}

/**
 * Guard: a grouped query object contributes one root key, so its members would
 * stop being searchable and an agent looking for `status` would no longer find
 * the tool that filters by it. Only a `deepObject` parameter's members are
 * indexed — a nested body object's are not, because a body nests arbitrarily
 * and its members are not addressable filters
 * (`nested-and-defs-parameters-not-indexed.json`).
 */
function memberTerms(group: string, schema: unknown): readonly string[] {
  const members: unknown = (schema as { properties?: unknown } | null)
    ?.properties;
  if (
    typeof members !== "object" ||
    members === null ||
    Array.isArray(members)
  ) {
    return [];
  }
  return Object.keys(members).map((member) => `${group}.${member}`);
}

export function createCard(
  tool: ToolDefinition,
  decision: VisibilityDecision = "allow",
): Card {
  const card: Card = {
    name: tool.name,
    description: truncateDescription(tool.description),
    parameters: summarizeParameters(tool.inputSchema),
    ...(tool.deprecated === true ? { deprecated: true } : {}),
  };
  return decision === "unknown" ? { ...card, authUncertain: true } : card;
}

/**
 * The shape `load_tool` returns and `search_tools` returns per result under
 * `detail: "schema"`.
 */
export type ToolDetail = Pick<
  ToolDefinition,
  "name" | "description" | "inputSchema" | "outputSchema" | "annotations"
> & { readonly deprecated?: boolean; readonly authUncertain?: boolean };

/**
 * Projects a tool into its loaded shape: name, untruncated description, input
 * schema, output schema when the endpoint declares a success body, and
 * annotations.
 *
 * Guard: `auth` is picked away rather than spread past, because a policy name
 * MUST NOT reach the agent ([visibility.md](../../spec/visibility.md) invariant
 * 3). `Pick` makes `{ ...tool }` a type error here, and
 * `detail/auth-is-never-emitted.json` fails on any implementation that emits the member
 * anyway.
 */
export function createDetail(
  tool: ToolDefinition,
  decision: VisibilityDecision = "allow",
): ToolDetail {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
    annotations: tool.annotations,
    ...(tool.deprecated === true ? { deprecated: true } : {}),
    ...(decision === "unknown" ? { authUncertain: true } : {}),
  };
}

const localDefPrefix = "#/$defs/";

/**
 * Guard: a property that names one of the root's `$defs` takes its target's type. An SDK hoists a
 * type used twice into `$defs`, and labelling the reference `any` would tell the agent the property
 * accepts anything. A chain that loops or leaves the table stays `any`.
 */
function typeLabel(
  schema: unknown,
  defs: Readonly<Record<string, unknown>>,
  seen: ReadonlySet<string> = new Set(),
): string {
  const ref: unknown = (schema as { $ref?: unknown } | null)?.$ref;
  if (typeof ref === "string" && ref.startsWith(localDefPrefix)) {
    const name = ref
      .slice(localDefPrefix.length)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
    return seen.has(name) || !Object.hasOwn(defs, name)
      ? "any"
      : typeLabel(defs[name], defs, new Set([...seen, name]));
  }
  const type: unknown = (schema as { type?: unknown } | null)?.type;
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type)) {
    for (const candidate of type) {
      if (typeof candidate === "string" && candidate !== "null") {
        return candidate;
      }
    }
  }
  return "any";
}
