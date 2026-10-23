import {
  snakeCase,
  type EndpointDescriptor,
  type ParameterSchema,
  type Revision,
  type SelectionDecision,
} from "@sezzlee/core";
import { OperationDropped, type DiagnosticSink } from "../diagnostics.js";
import {
  childPointer,
  operationKey,
  rootPointer,
  type HttpMethod,
  type JsonPointer,
  type OperationKey,
} from "../ir/brand.js";
import {
  arrayOf,
  entriesOf,
  objectOf,
  stringOf,
  type JsonObject,
} from "../ir/json.js";
import { resolveComponent } from "../normalize/refs.js";
import type { SchemaContext } from "../normalize/schema.js";
import { lowerRequestBody } from "./body.js";
import {
  lowerExtension,
  overlayExtension,
  scopeRevisionOf,
  type CarriedSchemas,
} from "./extension.js";
import { lowerParameters } from "./parameters.js";
import { lowerResponses } from "./responses.js";
import {
  authOf,
  carriersOf,
  effectiveSecurity,
  type SecurityModel,
  type SecurityRequirement,
} from "./security.js";
import { serverOf, type ServerOptions } from "./servers.js";

export interface SourcedEndpoint {
  readonly key: OperationKey;
  /** The path as the document writes it, before any hoisted prefix is removed. */
  readonly path: string;
  readonly at: JsonPointer;
  readonly descriptor: EndpointDescriptor;
  /** The base URL the route is appended to, with any hoisted prefix; `undefined` when unresolvable. */
  readonly baseUrl: string | undefined;
  readonly security: readonly SecurityRequirement[] | undefined;
  /** The operation-level marker `x-sezzlee.tool` declares; absent when it declares none. */
  readonly selection?: SelectionDecision;
  /** The operation `x-sezzlee.foldedInto` names, as `METHOD /path`. */
  readonly foldedInto?: string;
  /** The routes of operations folded into this one, in document order. */
  readonly alternateRoutes?: readonly string[];
}

export interface OperationOptions extends ServerOptions {
  readonly cookieDenyList: RegExp;
  readonly outputSchema: "document" | "omit";
  readonly requestBodyRequired: "document" | "always";
  readonly hoistPathPrefix?: string;
  readonly operations?: Readonly<Record<string, JsonObject>>;
}

const methodKeys = {
  get: "GET",
  put: "PUT",
  post: "POST",
  delete: "DELETE",
  options: "OPTIONS",
  head: "HEAD",
  patch: "PATCH",
  trace: "TRACE",
  query: "QUERY",
} as const satisfies Record<string, HttpMethod>;

type DescribableMethod = EndpointDescriptor["method"];

const describable: ReadonlySet<HttpMethod> = new Set<DescribableMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "QUERY",
]);

const toolNamePattern = /^[a-z][a-z0-9_]{0,255}$/;

function descriptionOf(operation: JsonObject): string | undefined {
  const summary = stringOf(operation["summary"])?.trim();
  const description = stringOf(operation["description"])?.trim();
  if (summary === undefined || summary === "") {
    return description === "" ? undefined : description;
  }
  if (
    description === undefined ||
    description === "" ||
    description.startsWith(summary)
  ) {
    return description === undefined || description === ""
      ? summary
      : description;
  }
  return `${summary}\n\n${description}`;
}

function hoisted(
  path: string,
  prefix: string | undefined,
): { route: string; prefix: string } {
  if (prefix === undefined || prefix === "" || prefix === "/") {
    return { route: path, prefix: "" };
  }
  const clean = prefix.replace(/\/+$/, "");
  if (path === clean) {
    return { route: "/", prefix: clean };
  }
  return path.startsWith(`${clean}/`)
    ? { route: path.slice(clean.length), prefix: clean }
    : { route: path, prefix: "" };
}

interface OperationSite {
  readonly path: string;
  readonly method: HttpMethod;
  readonly operation: JsonObject;
  readonly at: JsonPointer;
  readonly item: JsonObject;
  readonly itemAt: JsonPointer;
}

function sitesOf(
  document: JsonObject,
  diagnostics: DiagnosticSink,
): OperationSite[] {
  const sites: OperationSite[] = [];
  for (const [path, raw] of entriesOf(document["paths"])) {
    const itemAt = childPointer(rootPointer, "paths", path);
    let resolved: ReturnType<typeof resolveComponent>;
    try {
      resolved = resolveComponent(document, raw, itemAt);
    } catch (error) {
      if (!(error instanceof OperationDropped)) {
        throw error;
      }
      diagnostics.report(error.code, error.at, error.message);
      continue;
    }
    if (resolved === undefined) {
      continue;
    }
    const item = resolved.node;
    for (const [key, method] of Object.entries(methodKeys)) {
      const operation = objectOf(item[key]);
      if (operation !== undefined) {
        sites.push({
          path,
          method,
          operation,
          at: childPointer(itemAt, key),
          item,
          itemAt,
        });
      }
    }
    for (const [name, raw2] of entriesOf(item["additionalOperations"])) {
      const operation = objectOf(raw2);
      if (operation !== undefined) {
        sites.push({
          path,
          method: name.toUpperCase() as HttpMethod,
          operation,
          at: childPointer(itemAt, "additionalOperations", name),
          item,
          itemAt,
        });
      }
    }
  }
  return sites;
}

function lowerOperation(
  context: SchemaContext,
  site: OperationSite,
  schemes: SecurityModel,
  options: OperationOptions,
  inherited: Pick<Revision, "catalog" | "container">,
): SourcedEndpoint | undefined {
  const { operation, at, method } = site;
  if (operation["x-sezzlee-dropped"] === true) {
    return undefined;
  }
  if (!describable.has(method)) {
    throw new OperationDropped(
      "unsupported_method",
      at,
      `Method ${method} has no descriptor form.`,
    );
  }
  if (objectOf(operation["callbacks"]) !== undefined) {
    context.diagnostics.report(
      "callbacks_ignored",
      childPointer(at, "callbacks"),
      "Callbacks are requests the backend makes, not operations the agent calls; they are not carried.",
    );
  }
  const security = effectiveSecurity(operation, context.document);
  const credentialSlots = carriersOf(security, schemes);
  const identityCookies = new Set(
    [...schemes.values()].flatMap((scheme) =>
      scheme.type === "apiKey" && scheme.in === "cookie" ? [scheme.name] : [],
    ),
  );
  const lowered = lowerParameters(
    { ...context, cookieDenyList: options.cookieDenyList },
    {
      values: site.item["parameters"],
      at: childPointer(site.itemAt, "parameters"),
    },
    { values: operation["parameters"], at: childPointer(at, "parameters") },
    credentialSlots,
    identityCookies,
  );
  const requestBody = lowerRequestBody(
    context,
    operation["requestBody"],
    childPointer(at, "requestBody"),
    options.requestBodyRequired,
  );
  const responses = lowerResponses(
    context,
    operation["responses"],
    childPointer(at, "responses"),
    options.outputSchema === "document",
  );

  const operationId = stringOf(operation["operationId"])?.trim();
  let usableId: string | undefined;
  if (operationId !== undefined && operationId !== "") {
    if (toolNamePattern.test(snakeCase(operationId))) {
      usableId = operationId;
    } else {
      context.diagnostics.report(
        "operation_id_unusable",
        childPointer(at, "operationId"),
        `operationId '${operationId}' does not produce a valid tool name; the name is derived from the route instead.`,
      );
    }
  }
  const tags = arrayOf(operation["tags"])
    .map(stringOf)
    .filter((tag): tag is string => tag !== undefined && tag.trim() !== "");
  const extension = lowerExtension(context, operation, at);
  const operationRevision = extension.revision;
  const revision: Revision = {
    ...(inherited.catalog === undefined ? {} : { catalog: inherited.catalog }),
    ...(inherited.container === undefined
      ? {}
      : { container: inherited.container }),
    ...(operationRevision === undefined
      ? {}
      : { operation: operationRevision }),
  };
  const { route, prefix } = hoisted(site.path, options.hoistPathPrefix);
  const description = descriptionOf(operation);
  const carried = withCarriedSchemas(
    context,
    childPointer(at, "x-sezzlee"),
    { parameters: lowered.parameters, requestBody, responses },
    extension.schemas,
    options.outputSchema,
  );
  const carriers = [...credentialSlots, ...lowered.carriers];
  const descriptor: EndpointDescriptor = {
    ...(usableId === undefined ? {} : { operationId: usableId }),
    ...(tags[0] === undefined ? {} : { container: tags[0] }),
    method: method as DescribableMethod,
    route,
    ...(description === undefined ? {} : { description }),
    ...(operation["deprecated"] === true ? { deprecated: true } : {}),
    ...(carried.parameters.length === 0
      ? {}
      : { parameters: carried.parameters }),
    ...(carried.requestBody === undefined
      ? {}
      : { requestBody: carried.requestBody }),
    ...(carried.responses === undefined
      ? {}
      : { responses: carried.responses }),
    auth: {
      ...authOf(security, carriers),
      ...(extension.anonymous === true ? { anonymous: "yes" } : {}),
    },
    ...(tags.length === 0 ? {} : { tags }),
    ...(Object.keys(revision).length === 0 ? {} : { revision }),
    ...extension.curation,
  };
  const server = serverOf(
    [
      { servers: operation["servers"], at: childPointer(at, "servers") },
      {
        servers: site.item["servers"],
        at: childPointer(site.itemAt, "servers"),
      },
    ],
    {
      servers: context.document["servers"],
      at: childPointer(rootPointer, "servers"),
    },
    options,
    context.diagnostics,
  );
  return {
    key: operationKey(method, site.path),
    path: site.path,
    at,
    descriptor,
    baseUrl: server === undefined ? undefined : `${server}${prefix}`,
    security,
    ...(extension.selection === undefined
      ? {}
      : { selection: extension.selection }),
    ...(extension.foldedInto === undefined
      ? {}
      : { foldedInto: extension.foldedInto }),
  };
}

/**
 * Hands each folded route to the operation it names, as that operation's alternate route.
 *
 * Guard: the target must be a lowered operation of the same method that is not itself folded. A
 * route named into another method's operation, or into one dropped or folded away, would index the
 * tool under a path that does not reach it.
 */
function withAlternateRoutes(
  context: SchemaContext,
  endpoints: readonly SourcedEndpoint[],
): SourcedEndpoint[] {
  const byKey = new Map<string, SourcedEndpoint>(
    endpoints.map((endpoint) => [endpoint.key, endpoint]),
  );
  const alternates = new Map<string, string[]>();
  for (const endpoint of endpoints) {
    if (endpoint.foldedInto === undefined) {
      continue;
    }
    const target = byKey.get(endpoint.foldedInto);
    if (
      target === undefined ||
      target.foldedInto !== undefined ||
      target.descriptor.method !== endpoint.descriptor.method
    ) {
      context.diagnostics.report(
        "extension_fold_unmatched",
        childPointer(endpoint.at, "x-sezzlee", "foldedInto"),
        `${endpoint.foldedInto} names no unfolded operation of the same method; ${endpoint.key} is not carried as its alternate route.`,
      );
      continue;
    }
    alternates.set(target.key, [
      ...(alternates.get(target.key) ?? []),
      endpoint.descriptor.route,
    ]);
  }
  return endpoints.map((endpoint) => {
    const routes = alternates.get(endpoint.key);
    return routes === undefined
      ? endpoint
      : { ...endpoint, alternateRoutes: routes };
  });
}

interface Slots {
  readonly parameters: NonNullable<EndpointDescriptor["parameters"]>;
  readonly requestBody: EndpointDescriptor["requestBody"];
  readonly responses: EndpointDescriptor["responses"];
}

const parameterKey = (parameter: { name: string; in: string }): string =>
  `${parameter.in} ${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`;

/**
 * Lays the schemas an `x-sezzlee` carries over the ones the document gives, keeping the document's
 * wire form: parameter style and media type come from the document, schema, requiredness and
 * description from the extension.
 *
 * Guard: a carried slot the document cannot match is reported and the document's is kept. A
 * parameter the document does not declare has no wire form to borrow, and one the extension
 * leaves out would lose its schema to a guess.
 */
function withCarriedSchemas(
  context: SchemaContext,
  at: JsonPointer,
  document: Slots,
  carried: CarriedSchemas,
  outputSchema: OperationOptions["outputSchema"],
): Slots {
  let parameters = document.parameters;
  if (carried.parameters !== undefined) {
    const byKey = new Map(
      carried.parameters.map((parameter) => [
        parameterKey(parameter),
        parameter,
      ]),
    );
    const matched =
      byKey.size === parameters.length &&
      parameters.every((parameter) => byKey.has(parameterKey(parameter)));
    if (matched) {
      parameters = parameters.map((parameter) => {
        const { description: _description, ...wire } = parameter;
        const schema = byKey.get(parameterKey(parameter)) as ParameterSchema;
        return {
          ...wire,
          required: schema.required,
          schema: schema.schema,
          ...(schema.description === undefined
            ? {}
            : { description: schema.description }),
        };
      });
    } else {
      context.diagnostics.report(
        "extension_schema_mismatch",
        childPointer(at, "parameters"),
        `The carried parameters (${[...byKey.keys()].join(", ") || "none"}) are not the document's (${parameters.map(parameterKey).join(", ") || "none"}); the document's schemas are kept.`,
      );
    }
  }
  let requestBody = document.requestBody;
  if (carried.requestBody !== undefined) {
    if (requestBody === undefined) {
      context.diagnostics.report(
        "extension_schema_mismatch",
        childPointer(at, "requestBody"),
        "The operation declares no request body for the carried one to describe; it is not carried.",
      );
    } else {
      const {
        schema: _schema,
        required: _required,
        description: _description,
        ...wire
      } = requestBody;
      requestBody = { ...wire, ...carried.requestBody };
    }
  }
  const responses =
    carried.responses === undefined || outputSchema === "omit"
      ? document.responses
      : Object.keys(carried.responses).length === 0
        ? undefined
        : carried.responses;
  return { parameters, requestBody, responses };
}

type ScopeRevision = number | undefined | "dropped";

function scopeOf(
  context: SchemaContext,
  holder: JsonObject,
  at: JsonPointer,
): ScopeRevision {
  try {
    return scopeRevisionOf(context, holder, at);
  } catch (error) {
    if (!(error instanceof OperationDropped)) {
      throw error;
    }
    context.diagnostics.report(error.code, error.at, error.message);
    return "dropped";
  }
}

export function lowerOperations(
  context: SchemaContext,
  schemes: SecurityModel,
  options: OperationOptions,
): SourcedEndpoint[] {
  if (objectOf(context.document["webhooks"]) !== undefined) {
    context.diagnostics.report(
      "webhooks_ignored",
      childPointer(rootPointer, "webhooks"),
      "Webhooks are requests the backend makes, not operations the agent calls; they are not carried.",
    );
  }
  const catalog = scopeOf(context, context.document, rootPointer);
  if (catalog === "dropped") {
    return [];
  }
  const containers = new Map<JsonPointer, ScopeRevision>();
  const endpoints: SourcedEndpoint[] = [];
  const sites = sitesOf(context.document, context.diagnostics);
  const keys = new Set<string>(
    sites.map((site) => operationKey(site.method, site.path)),
  );
  for (const key of Object.keys(options.operations ?? {})) {
    if (!keys.has(key)) {
      context.diagnostics.report(
        "extension_target_unknown",
        rootPointer,
        `The config's operations["${key}"] names no operation of the document; check the method and the path as the document writes it, before any hoisting.`,
      );
    }
  }
  for (const listed of sites) {
    const overlay =
      options.operations?.[operationKey(listed.method, listed.path)];
    const site =
      overlay === undefined
        ? listed
        : {
            ...listed,
            operation: overlayExtension(
              context,
              listed.operation,
              listed.at,
              overlay,
            ),
          };
    if (!containers.has(site.itemAt)) {
      containers.set(site.itemAt, scopeOf(context, site.item, site.itemAt));
    }
    const container = containers.get(site.itemAt);
    if (container === "dropped") {
      continue;
    }
    try {
      const endpoint = lowerOperation(context, site, schemes, options, {
        ...(catalog === undefined ? {} : { catalog }),
        ...(container === undefined ? {} : { container }),
      });
      if (endpoint !== undefined) {
        endpoints.push(endpoint);
      }
    } catch (error) {
      if (!(error instanceof OperationDropped)) {
        throw error;
      }
      context.diagnostics.report(error.code, error.at, error.message);
    }
  }
  return withAlternateRoutes(context, endpoints);
}
