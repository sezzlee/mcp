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
 * Writes the extensions into an OpenAPI document in place, replacing any already there. Operations
 * the extensions do not name are left as they are.
 */
export function annotateOpenApiDocument(
  document: object,
  extensions: OpenApiExtensions,
): void {
  if (!isRecord(document)) {
    return;
  }
  if (extensions.document !== undefined) {
    document[openApiExtensionKey] = structuredClone(extensions.document);
  }
  const paths = document["paths"];
  if (!isRecord(paths)) {
    return;
  }
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    const scope = extensions.paths.get(path);
    if (scope !== undefined) {
      item[openApiExtensionKey] = structuredClone(scope);
    }
    for (const method of methods) {
      const operation = item[method];
      const extension = extensions.operations.get(
        `${method.toUpperCase()} ${path}`,
      );
      if (isRecord(operation) && extension !== undefined) {
        operation[openApiExtensionKey] = structuredClone(extension);
      }
    }
  }
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
  const { descriptor, toolName } = decision;
  if (descriptor === undefined) {
    return { tool: false };
  }
  const annotations = descriptor.annotations;
  const family = descriptor.family;
  return {
    tool: true,
    ...(toolName === undefined || descriptor.variants !== undefined
      ? {}
      : { toolName }),
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
