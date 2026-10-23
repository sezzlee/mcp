import type { OperationDecision } from "./catalog/pipeline.js";
import type {
  ArgumentCuration,
  EndpointDescriptor,
  ToolVariant,
} from "./generated/endpoint-descriptor.js";
import type {
  FamilyDeclaration,
  FamilyMember,
  OperationExtension,
  ScopeExtension,
} from "./generated/openapi-extension.js";

export const openApiExtensionKey = "x-sezzlee";

/**
 * A catalog described as `x-sezzlee` extensions (openapi-ingestion.md §The x-sezzlee extension).
 *
 * @param operations keyed by `METHOD /path`; the same map is a valid `operations` block of the
 * gateway's configuration
 * @param paths keyed by the OpenAPI path template
 */
export interface OpenApiExtensions {
  readonly document?: ScopeExtension;
  readonly paths: ReadonlyMap<string, ScopeExtension>;
  readonly operations: ReadonlyMap<string, OperationExtension>;
}

/**
 * Describes a built catalog as the `x-sezzlee` extensions an OpenAPI gateway rebuilds it from.
 *
 * Every candidate operation carries `tool`, so the gateway publishes what the catalog published
 * whatever its own selection default is.
 */
export function openApiExtensions(
  operations: ReadonlyMap<string, OperationDecision>,
): OpenApiExtensions {
  const extensions = new Map<string, OperationExtension>();
  const containers = new Map<string, Set<number | undefined>>();
  const catalogs = new Set<number | undefined>();
  for (const [key, decision] of operations) {
    extensions.set(key, extensionOf(decision));
    const descriptor = decision.descriptor;
    if (descriptor === undefined) {
      continue;
    }
    const levels = containers.get(descriptor.route) ?? new Set();
    levels.add(descriptor.revision?.container);
    containers.set(descriptor.route, levels);
    catalogs.add(descriptor.revision?.catalog);
  }
  const paths = new Map<string, ScopeExtension>();
  for (const [route, levels] of containers) {
    const revision = soleRevision(levels);
    if (revision !== undefined) {
      paths.set(route, { revision });
    }
  }
  const catalog = soleRevision(catalogs);
  return {
    ...(catalog === undefined ? {} : { document: { revision: catalog } }),
    paths,
    operations: extensions,
  };
}

const methods = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
] as const;

/**
 * What {@link annotateOpenApiDocument} could not match, keyed `METHOD /path`.
 *
 * @param excluded operations of the document the extensions do not name, written `tool: false`
 * @param undocumented operations the catalog publishes from that the document does not carry, so a
 * gateway reading it cannot publish their tools
 */
export interface AnnotationReport {
  readonly excluded: readonly string[];
  readonly undocumented: readonly string[];
}

/**
 * Writes the extensions into an OpenAPI document in place, replacing any already there.
 *
 * Guard: an operation the extensions do not name is written `tool: false`. The catalog decided
 * every route it saw, so one it does not name is one it did not publish: its own MCP route, a
 * handler it dropped, or a route outside its discovery. Left unmarked, it would fall to a gateway's
 * selection default, and a gateway that includes by default would publish it.
 */
export function annotateOpenApiDocument(
  document: object,
  extensions: OpenApiExtensions,
): AnnotationReport {
  const paths = isRecord(document) ? document["paths"] : undefined;
  if (isRecord(document) && extensions.document !== undefined) {
    document[openApiExtensionKey] = structuredClone(extensions.document);
  }
  const documented = new Map<string, Record<string, unknown>>();
  for (const [path, item] of Object.entries(isRecord(paths) ? paths : {})) {
    if (!isRecord(item)) {
      continue;
    }
    const scope = extensions.paths.get(path);
    if (scope !== undefined) {
      item[openApiExtensionKey] = structuredClone(scope);
    }
    for (const method of methods) {
      const operation = item[method];
      if (isRecord(operation)) {
        documented.set(`${method.toUpperCase()} ${path}`, operation);
      }
    }
  }
  const excluded: string[] = [];
  for (const [key, operation] of documented) {
    const extension = extensions.operations.get(key);
    if (extension === undefined) {
      excluded.push(key);
    }
    operation[openApiExtensionKey] = structuredClone(
      extension ?? { tool: false },
    );
  }
  const undocumented = [...extensions.operations]
    .filter(
      ([key, extension]) => extension.tool === true && !documented.has(key),
    )
    .map(([key]) => key);
  return { excluded, undocumented };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function soleRevision(
  levels: ReadonlySet<number | undefined>,
): number | undefined {
  const [only] = levels;
  return levels.size === 1 ? only : undefined;
}

/**
 * Guard: the published name is written whole, prefix included, instead of the declarations it
 * came from. A generator writes no operationId for most handlers, so a gateway left to derive the
 * name would read the route where the SDK read the handler, and the tool would be renamed between
 * the two hosts.
 */
function extensionOf(decision: OperationDecision): OperationExtension {
  const { descriptor, toolName, foldedInto } = decision;
  if (descriptor === undefined) {
    return foldedInto === undefined
      ? { tool: false }
      : { tool: false, foldedInto };
  }
  const annotations = descriptor.annotations;
  const family = descriptor.family;
  const single = descriptor.variants === undefined;
  return {
    tool: true,
    ...(toolName === undefined || !single ? {} : { toolName }),
    ...(descriptor.description === undefined || !single
      ? {}
      : { description: descriptor.description }),
    ...(descriptor.tags === undefined ? {} : { tags: [...descriptor.tags] }),
    ...schemasOf(descriptor),
    ...(anyCaller(descriptor.auth) ? { anonymous: true } : {}),
    ...(annotations === undefined || Object.keys(annotations).length === 0
      ? {}
      : { annotations }),
    ...(descriptor.arguments === undefined
      ? {}
      : { arguments: descriptor.arguments }),
    ...(family === undefined
      ? descriptor.variants === undefined
        ? {}
        : { variants: descriptor.variants }
      : { family: familyOf(family.parameter, descriptor) }),
    ...(descriptor.searchTerms === undefined
      ? {}
      : { searchTerms: descriptor.searchTerms }),
    ...(descriptor.revision?.operation === undefined
      ? {}
      : { revision: descriptor.revision.operation }),
  };
}

/**
 * Guard: only an operation any caller may make is marked. A gateway knows nothing of its caller, so
 * a policy or an imperative guard the SDK evaluates per caller would read as certain there.
 */
const anyCaller = (auth: EndpointDescriptor["auth"]): boolean =>
  auth.anonymous === "yes" && auth.policies.length === 0 && !auth.imperative;

/**
 * Guard: every slot is written, an empty one included, so the gateway reads the schemas the SDK
 * published rather than the generator's: a schema the SDK could not read stays unread there too.
 * `publishedSchemas` keeps the gateway from normalizing them as Schema Objects of the document,
 * which drops `default` and merges `allOf`, so a host-declared schema would reach it changed.
 */
function schemasOf(
  descriptor: EndpointDescriptor,
): Required<
  Pick<OperationExtension, "parameters" | "responses" | "publishedSchemas">
> &
  Pick<OperationExtension, "requestBody"> {
  const body = descriptor.requestBody;
  return {
    publishedSchemas: true,
    parameters: (descriptor.parameters ?? []).map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required,
      schema: parameter.schema,
      ...(parameter.description === undefined
        ? {}
        : { description: parameter.description }),
    })),
    ...(body === undefined
      ? {}
      : {
          requestBody: {
            schema: body.schema,
            ...(body.required === undefined ? {} : { required: body.required }),
            ...(body.description === undefined
              ? {}
              : { description: body.description }),
          },
        }),
    responses: descriptor.responses ?? {},
  };
}

/**
 * Guard: a variant whose dispatch key is not a hidden constant cannot be written as a member, and
 * the catalog itself refuses it as `family_key_unfilled`, so it is left out rather than published
 * with a guessed key.
 */
function familyOf(
  parameter: string,
  descriptor: EndpointDescriptor,
): FamilyDeclaration {
  const members = (descriptor.variants ?? []).flatMap(
    (variant): FamilyMember[] => {
      const dispatch = variant.arguments?.find(
        (argument) =>
          argument.name === parameter && argument.hidden?.kind === "constant",
      );
      const key = dispatch?.hidden?.value;
      if (
        dispatch === undefined ||
        (typeof key !== "string" && typeof key !== "number")
      ) {
        return [];
      }
      return [memberOf(variant, key, without(variant.arguments, dispatch))];
    },
  );
  return { parameter, members };
}

function without(
  curations: readonly ArgumentCuration[] | undefined,
  removed: ArgumentCuration,
): ArgumentCuration[] {
  return (curations ?? []).filter((curation) => curation !== removed);
}

function memberOf(
  variant: ToolVariant,
  key: string | number,
  rest: readonly ArgumentCuration[],
): FamilyMember {
  const { arguments: _arguments, ...fields } = variant;
  return {
    key,
    ...fields,
    ...(rest.length === 0 ? {} : { arguments: [...rest] }),
  };
}
