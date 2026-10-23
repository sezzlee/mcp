import {
  ClassSerializerInterceptor,
  ParseArrayPipe,
  ParseBoolPipe,
  ParseEnumPipe,
  ParseFloatPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  RequestMethod,
  VERSION_NEUTRAL,
  VersioningType,
  type VersioningOptions,
} from "@nestjs/common";
import { createRequire } from "node:module";
import type {
  EndpointDescriptor,
  JsonSchemaObject,
  SchemaSimplificationOptions,
} from "@sezzlee/core";
import {
  allowsAdditional,
  declaredSchemaProblem,
  flattenableBody,
  simplifySchema,
  typeOf,
} from "@sezzlee/core";
import {
  markersOf,
  type ArgumentRule,
  type McpResponseDeclaration,
  type McpToolOptions,
  type McpVariantOptions,
} from "../decorators.js";
import { bodyEncodingOf, type FileBinding } from "./body-encoding.js";
import { atLeast, severityOf, type CatalogSeverity } from "./diagnostics.js";
import { readStandardSchema } from "./standard-schema.js";
import {
  asRecord,
  documentedBody,
  documentedParameter,
  documentedTags,
  documentedType,
  type DocumentedParameter,
} from "./swagger-metadata.js";
import {
  NestTypeShapeBinder,
  type SerializationView,
  type TypeShapeBinderOptions,
} from "./type-shape.js";

const load = createRequire(import.meta.url);

const {
  GUARDS_METADATA,
  HOST_METADATA,
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  MODULE_PATH,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
  SSE_METADATA,
  VERSION_METADATA,
} = load("@nestjs/common/constants") as {
  GUARDS_METADATA: string;
  HOST_METADATA: string;
  INTERCEPTORS_METADATA: string;
  HTTP_CODE_METADATA: string;
  METHOD_METADATA: string;
  MODULE_PATH: string;
  PATH_METADATA: string;
  ROUTE_ARGS_METADATA: string;
  SSE_METADATA: string;
  VERSION_METADATA: string;
};

const { CLASS_SERIALIZER_OPTIONS } = load(
  "@nestjs/common/serializer/class-serializer.constants",
) as { CLASS_SERIALIZER_OPTIONS: string };

const { RouteParamtypes } = load(
  "@nestjs/common/enums/route-paramtypes.enum",
) as { RouteParamtypes: Record<string, number> };

const { RoutePathFactory } = load("@nestjs/core/router/route-path-factory") as {
  RoutePathFactory: new (applicationConfig: unknown) => RoutePaths;
};

const BODY = RouteParamtypes["BODY"] as number;
const QUERY = RouteParamtypes["QUERY"] as number;
const PARAM = RouteParamtypes["PARAM"] as number;
const HEADERS = RouteParamtypes["HEADERS"] as number;
const FILE = RouteParamtypes["FILE"] as number;
const FILES = RouteParamtypes["FILES"] as number;
const RAW_BODY = RouteParamtypes["RAW_BODY"] as number;

export interface RoutePathMetadata {
  readonly ctrlPath?: string;
  readonly methodPath?: string;
  readonly globalPrefix?: string;
  readonly modulePath?: string;
  readonly controllerVersion?: unknown;
  readonly methodVersion?: unknown;
  readonly versioningOptions?: unknown;
}

export interface RoutePaths {
  create(metadata: RoutePathMetadata, requestMethod?: number): string[];
}

/** `RoutePathFactory` reads `getGlobalPrefixOptions()`; with no application there is no exclusion list. */
export function createRoutePaths(applicationConfig?: unknown): RoutePaths {
  return new RoutePathFactory(
    applicationConfig ?? { getGlobalPrefixOptions: () => ({}) },
  );
}

const withoutApplication = createRoutePaths();

export interface DiscoveryDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface ControllerCandidate {
  readonly metatype: NewableFunction;
  readonly modulePath?: string;
}

/**
 * Implemented by an interceptor that changes the shape of a successful response, such as one that
 * wraps every body in `{ data }`. It receives the JSON Schema of what the handler returns and
 * answers the schema of what the interceptor sends, or `undefined` when that shape is not known.
 */
export interface McpResponseDescriber {
  describeResponse(schema: JsonSchemaObject): JsonSchemaObject | undefined;
}

export interface VisibilityDeclaration {
  readonly anonymous?: "yes" | "no" | "unknown";
  readonly policies?: readonly string[];
}

/**
 * What an endpoint hook sees: the handler's identity and a description.
 *
 * @param declared for `options.description`, the description the handler's metadata declares; for
 * `options.endpointTags` and `options.endpointSearchTerms`, the description the tool is published
 * with
 */
export interface McpEndpointInfo {
  readonly method: string;
  readonly route: string;
  readonly container: string;
  readonly handler: (...args: never[]) => unknown;
  readonly declared: string | undefined;
}

export interface DiscoveryOptions {
  readonly globalPrefix?: string;
  readonly versioningOptions?: VersioningOptions;
  readonly routePaths?: RoutePaths;
  readonly schema?: TypeShapeBinderOptions;
  readonly globalGuards?: readonly unknown[];
  readonly globalInterceptors?: readonly unknown[];
  /**
   * The one instance Nest built of an interceptor class bound to the controller or one of its
   * handlers; `undefined` when there is none, as for a request-scoped or transient interceptor.
   */
  readonly interceptorInstance?: (
    interceptor: NewableFunction,
    controller: NewableFunction,
  ) => object | undefined;
  readonly severity?: (code: string) => CatalogSeverity;
  readonly report?: (diagnostic: DiscoveryDiagnostic) => void;
  readonly queryGrouping?: "flatten" | "group";
  readonly description?: (endpoint: McpEndpointInfo) => string | undefined;
}

export interface DiscoveredEndpoint {
  readonly descriptor: EndpointDescriptor;
  readonly controller: NewableFunction;
  readonly handlerName: string;
  readonly handler: (...args: never[]) => unknown;
  readonly containerMarkers: readonly boolean[];
  readonly operationMarkers: readonly boolean[];
  readonly hints: McpToolOptions;
  readonly revisions: {
    readonly container: number | undefined;
    readonly operation: number | undefined;
  };
}

const methodNames: Partial<
  Record<RequestMethod, EndpointDescriptor["method"]>
> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.HEAD]: "HEAD",
};

const pipeScalars: ReadonlyArray<readonly [unknown, JsonSchemaObject]> = [
  [ParseIntPipe, { type: "integer" }],
  [ParseFloatPipe, { type: "number" }],
  [ParseBoolPipe, { type: "boolean" }],
  [ParseUUIDPipe, { type: "string", format: "uuid" }],
  [ParseEnumPipe, { type: "string" }],
];

const queryScalars = new Set(["string", "number", "integer", "boolean"]);

interface ArgumentEntry {
  readonly index: number;
  readonly data?: unknown;
  readonly pipes?: readonly unknown[];
  readonly schema?: unknown;
}

interface ValidatedArgument {
  readonly schema: JsonSchemaObject;
  readonly rejectsMissing: boolean | undefined;
}

export function discoverEndpoints(
  controllers: readonly ControllerCandidate[],
  options: DiscoveryOptions = {},
): DiscoveredEndpoint[] {
  const found: DiscoveredEndpoint[] = [];
  for (const candidate of controllers) {
    found.push(...fromController(candidate, options));
  }
  return found;
}

/**
 * The version a handler answers that a replayed request cannot reach, or nothing. Only URI
 * versioning writes the version into the path; under the other types a request without a version
 * reaches the neutral or default version alone.
 */
function unreachableVersion(
  versioning: VersioningOptions | undefined,
  version: unknown,
): string | undefined {
  if (
    versioning === undefined ||
    versioning.type === VersioningType.URI ||
    version === undefined
  ) {
    return undefined;
  }
  const declared: unknown[] = Array.isArray(version) ? version : [version];
  const fallback: unknown = versioning.defaultVersion;
  const reachable: unknown[] = [
    VERSION_NEUTRAL,
    ...(Array.isArray(fallback) ? fallback : [fallback]),
  ];
  return declared.some((candidate) => reachable.includes(candidate))
    ? undefined
    : declared.map(String).join(", ");
}

/** `RouterModule` writes the module path under a key scoped to the application instance, falling back to the bare key. */
export function modulePathOf(
  moduleMetatype: unknown,
  applicationId: string,
): string | undefined {
  if (typeof moduleMetatype !== "function") {
    return undefined;
  }
  const scoped = Reflect.getMetadata(
    MODULE_PATH + applicationId,
    moduleMetatype,
  ) as string | undefined;
  return (
    scoped ??
    (Reflect.getMetadata(MODULE_PATH, moduleMetatype) as string | undefined)
  );
}

function fromController(
  candidate: ControllerCandidate,
  options: DiscoveryOptions,
): DiscoveredEndpoint[] {
  const controller = candidate.metatype;
  const prototype = controller.prototype as Record<string, unknown>;
  const classPaths = pathsOf(controller);
  const controllerVersion =
    (Reflect.getMetadata(VERSION_METADATA, controller) as unknown) ??
    options.versioningOptions?.defaultVersion;
  const containerMarkers = markersOf(controller);
  const results: DiscoveredEndpoint[] = [];
  if (routesOnHostPattern(controller)) {
    for (const handlerName of handlerNames(prototype)) {
      const handler = prototype[handlerName] as object;
      if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) {
        continue;
      }
      options.report?.({
        code: "unsupported_binding",
        message: `${controller.name}.${handlerName} is routed on a host pattern; the replayed request cannot choose the host, so a call would reach another host's handler or none. Endpoint skipped.`,
      });
    }
    return results;
  }

  for (const handlerName of handlerNames(prototype)) {
    const handler = prototype[handlerName] as (...args: never[]) => unknown;
    const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
      RequestMethod | undefined;
    if (verb === undefined) {
      continue;
    }
    const method = methodNames[verb];
    const operationMarkers = markersOf(handler);
    const hints = mergeHints(containerMarkers, operationMarkers);

    if (Reflect.getMetadata(SSE_METADATA, handler) === true) {
      options.report?.({
        code: "unsupported_binding",
        message: `${controller.name}.${handlerName} streams server-sent events, which never end, so a tool call could only time out; endpoint skipped.`,
      });
      continue;
    }

    if (method === undefined) {
      options.report?.({
        code: "unsupported_method",
        message: `${controller.name}.${handlerName} is bound to an HTTP method with no neutral-model counterpart; endpoint skipped.`,
      });
      continue;
    }

    const methodVersion = Reflect.getMetadata(
      VERSION_METADATA,
      handler,
    ) as unknown;
    const unreachable = unreachableVersion(
      options.versioningOptions,
      methodVersion ?? controllerVersion,
    );
    if (unreachable !== undefined) {
      options.report?.({
        code: "version_not_carried",
        message: `${controller.name}.${handlerName} answers version ${unreachable} under ${VersioningType[options.versioningOptions?.type ?? VersioningType.URI]} versioning; the replayed request carries no version, so a call would reach another version's handler.`,
      });
      if (
        atLeast(
          (options.severity ?? severityOf)("version_not_carried"),
          "endpointDropped",
        )
      ) {
        continue;
      }
    }

    for (const route of routesOf(
      candidate,
      classPaths,
      pathsOf(handler),
      controllerVersion,
      methodVersion,
      verb,
      options,
    )) {
      if (/[*]/.test(route)) {
        options.report?.({
          code: "unsupported_binding",
          message: `${controller.name}.${handlerName} uses a wildcard route segment, which the neutral route model cannot express; endpoint skipped.`,
        });
        continue;
      }
      const built = describe(
        controller,
        handlerName,
        handler,
        method,
        route,
        hints,
        options,
      );
      if (built === undefined) {
        continue;
      }
      results.push({
        descriptor: built,
        controller,
        handlerName,
        handler,
        containerMarkers: containerMarkers.map((marker) => marker.include),
        operationMarkers: operationMarkers.map((marker) => marker.include),
        hints,
        revisions: {
          container: declaredRevision(containerMarkers),
          operation: declaredRevision(operationMarkers),
        },
      });
    }
  }
  return results;
}

/**
 * The Express router matches a controller's `host` against the replayed request's `Host` header,
 * which is the MCP request's own: a pattern there (`:account.example.com`, a RegExp) is a value the
 * agent cannot choose.
 *
 * Guard: Nest hands the whole host to path-to-regexp, which starts a parameter at any unescaped
 * `:`, a wildcard at `*` and an optional group at `{` (`(` in older releases), inside a label too:
 * `tenant-:account.example.com` is a pattern. A plain hostname has none of them.
 */
function routesOnHostPattern(controller: NewableFunction): boolean {
  const declared: unknown = Reflect.getMetadata(HOST_METADATA, controller);
  const hosts: unknown[] = Array.isArray(declared) ? declared : [declared];
  return hosts.some(
    (host) =>
      host instanceof RegExp ||
      (typeof host === "string" && /(^|[^\\])[:*{(]/.test(host)),
  );
}

function routesOf(
  candidate: ControllerCandidate,
  classPaths: readonly string[],
  methodPaths: readonly string[],
  controllerVersion: unknown,
  methodVersion: unknown,
  requestMethod: RequestMethod,
  options: DiscoveryOptions,
): string[] {
  const factory = options.routePaths ?? withoutApplication;
  const routes = new Set<string>();
  for (const ctrlPath of classPaths) {
    for (const methodPath of methodPaths) {
      const created = factory.create(
        {
          ctrlPath,
          methodPath,
          ...(options.globalPrefix === undefined
            ? {}
            : { globalPrefix: options.globalPrefix }),
          ...(candidate.modulePath === undefined
            ? {}
            : { modulePath: candidate.modulePath }),
          ...(controllerVersion === undefined ? {} : { controllerVersion }),
          ...(methodVersion === undefined ? {} : { methodVersion }),
          ...(options.versioningOptions === undefined
            ? {}
            : { versioningOptions: options.versioningOptions }),
        },
        requestMethod,
      );
      for (const route of created) {
        routes.add(normalizeRoute(route));
      }
    }
  }
  return [...routes];
}

function describe(
  controller: NewableFunction,
  handlerName: string,
  handler: (...args: never[]) => unknown,
  method: EndpointDescriptor["method"],
  route: string,
  hints: McpToolOptions,
  options: DiscoveryOptions,
): EndpointDescriptor | undefined {
  const args = argumentsOf(controller, handlerName);
  const paramTypes = (Reflect.getMetadata(
    "design:paramtypes",
    controller.prototype as object,
    handlerName,
  ) ?? []) as unknown[];

  const reported = new Set<string>();
  const tracked: DiscoveryOptions = {
    ...options,
    report: (diagnostic) => {
      reported.add(`${diagnostic.code}\u0000${diagnostic.message}`);
      options.report?.(diagnostic);
    },
  };

  const declared: NonNullable<EndpointDescriptor["parameters"]> = [];
  const expanded: NonNullable<EndpointDescriptor["parameters"]> = [];
  let bodySchema: JsonSchemaObject | undefined;
  let bodyFields: Record<string, JsonSchemaObject> | undefined;
  let unsupported = false;
  let unresolvedQuery = false;
  const files: FileBinding[] = [];

  const validations = new Map<ArgumentEntry, ValidatedArgument | undefined>();
  const validatedOf = (entry: ArgumentEntry): ValidatedArgument | undefined => {
    if (validations.has(entry)) {
      return validations.get(entry);
    }
    const reading = readStandardSchema(entry.schema, "input");
    if (reading?.kind === "unreadable") {
      tracked.report?.({
        code: "unreadable_shape",
        message: `${controller.name}.${handlerName} validates argument ${String(entry.index)} against a schema, but ${reading.reason}; its declared type is read instead.`,
      });
    }
    const validated =
      reading?.kind === "read"
        ? {
            schema: reading.schema,
            rejectsMissing: rejectsMissing(entry.schema),
          }
        : undefined;
    validations.set(entry, validated);
    return validated;
  };

  for (const [key, entry] of Object.entries(args)) {
    const kind = Number(key.split(":")[0]);
    const name = typeof entry.data === "string" ? entry.data : undefined;
    const declaredType = paramTypes[entry.index];
    const validated = validatedOf(entry);

    switch (kind) {
      case QUERY: {
        if (name !== undefined) {
          const grouped =
            options.queryGrouping === "group"
              ? groupedQueryFor(
                  controller,
                  handlerName,
                  name,
                  declaredType,
                  tracked,
                  validated?.schema,
                )
              : undefined;
          declared.push(
            grouped ??
              namedParameter(
                entry,
                declaredType,
                name,
                "query",
                documentedParameter(controller, handler, "query", name),
                validated,
              ),
          );
          break;
        }
        const members = queryFor(
          controller,
          handlerName,
          declaredType,
          tracked,
          validated?.schema,
        );
        if (members === undefined) {
          unresolvedQuery = true;
          break;
        }
        expanded.push(...members);
        break;
      }
      case HEADERS:
        if (name === undefined) {
          options.report?.({
            code: "unbound_header_object",
            message: `${controller.name}.${handlerName} binds the whole header object; its members cannot be read, so they are omitted from the tool. Bind the headers the tool needs by name.`,
          });
          break;
        }
        declared.push(
          namedParameter(
            entry,
            declaredType,
            name,
            "header",
            documentedParameter(controller, handler, "header", name),
            validated,
          ),
        );
        break;
      case BODY:
        if (name === undefined) {
          bodySchema =
            validated?.schema ?? wholeBodyFor(handler, declaredType, tracked);
        } else {
          bodyFields ??= {};
          bodyFields[name] =
            validated?.schema ?? bodyFor(declaredType, tracked);
        }
        break;
      case FILE:
        files.push("single");
        break;
      case FILES:
        files.push("multiple");
        break;
      case RAW_BODY:
        unsupported = true;
        break;
      default:
        break;
    }
  }

  if (unsupported) {
    options.report?.({
      code: "unsupported_binding",
      message: `${controller.name}.${handlerName} binds the raw body, which sezzlee has no writer for; endpoint skipped.`,
    });
    return undefined;
  }
  if (bodySchema !== undefined && bodyFields !== undefined) {
    options.report?.({
      code: "multiple_body_bindings",
      message: `${controller.name}.${handlerName} mixes a whole-body binding with named body members; endpoint skipped.`,
    });
    return undefined;
  }
  if (
    unresolvedQuery &&
    atLeast(
      (options.severity ?? severityOf)("unresolved_query_shape"),
      "endpointDropped",
    )
  ) {
    return undefined;
  }
  if (bodyFields !== undefined) {
    bodySchema = { type: "object", properties: bodyFields };
  }
  const encoding = bodyEncodingOf({
    where: `${controller.name}.${handlerName}`,
    controller,
    handler,
    hints,
    files,
    schema: bodySchema,
    report: options.report,
  });
  if (encoding === undefined) {
    return undefined;
  }
  bodySchema = encoding.schema;

  const pathParameters = placeholdersOf(route).map((placeholder) => {
    const documented = documentedParameter(
      controller,
      handler,
      "path",
      placeholder,
    );
    return {
      name: placeholder,
      in: "path" as const,
      required: true,
      schema: pathSchema(
        args,
        paramTypes,
        placeholder,
        documented,
        validatedOf,
      ) ??
        documented?.schema ?? { type: "string" },
      ...(documented?.description === undefined
        ? {}
        : { description: documented.description }),
    };
  });

  const claimed = new Set([
    ...pathParameters.map((parameter) => parameter.name),
    ...declared.map((parameter) => parameter.name),
  ]);
  for (const parameter of expanded.filter((member) =>
    claimed.has(member.name),
  )) {
    options.report?.({
      code: "query_member_shadowed",
      message: `${controller.name}.${handlerName} flattens a query member named '${parameter.name}', which a path parameter or a named binding already claims; the member is omitted from the tool. Rename it, or bind it by name.`,
    });
  }
  const parameters = [
    ...pathParameters,
    ...declared.filter((parameter) => parameter.in !== "path"),
    ...expanded.filter((parameter) => !claimed.has(parameter.name)),
  ].map((parameter) => applyParameterHints(parameter, hints));

  const responses = responsesOf(
    controller,
    handlerName,
    handler,
    method,
    hints,
    options,
    reported,
  );

  const descriptor: EndpointDescriptor = {
    operationId: handlerName,
    container: controller.name,
    method,
    route,
    auth: authOf(controller, handler, options.globalGuards ?? []),
    tags: documentedTags(controller, handler),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(bodySchema === undefined
      ? {}
      : {
          requestBody: {
            schema: bodySchema,
            ...(hints.bodyRequired === undefined
              ? {}
              : { required: hints.bodyRequired }),
            ...(encoding.contentType === undefined
              ? {}
              : { contentType: encoding.contentType }),
          },
        }),
    ...(responses === undefined ? {} : { responses }),
  };

  const description = descriptionOf(
    controller,
    handler,
    method,
    route,
    hints,
    options,
  );
  return description === undefined
    ? descriptor
    : { ...descriptor, description };
}

function authOf(
  controller: NewableFunction,
  handler: (...args: never[]) => unknown,
  globalGuards: readonly unknown[],
): EndpointDescriptor["auth"] {
  const guards = [
    ...globalGuards,
    ...guardsOn(controller),
    ...guardsOn(handler),
  ];
  if (guards.length === 0) {
    return { anonymous: "unknown", policies: [], imperative: false };
  }

  let anonymous: EndpointDescriptor["auth"]["anonymous"] | undefined;
  const policies: string[] = [];

  for (const guard of guards) {
    const declaration = declarationOf(guard);
    if (declaration === undefined) {
      continue;
    }
    if (declaration.anonymous !== undefined) {
      anonymous =
        declaration.anonymous === "no" || anonymous === "no"
          ? "no"
          : declaration.anonymous;
    }
    for (const policy of declaration.policies ?? []) {
      if (!policies.includes(policy)) {
        policies.push(policy);
      }
    }
  }

  return {
    anonymous: anonymous ?? "unknown",
    policies,
    imperative: guards.some((guard) => declarationOf(guard) === undefined),
  };
}

function declarationOf(guard: unknown): VisibilityDeclaration | undefined {
  const instance =
    typeof guard === "function"
      ? (guard as { prototype?: unknown }).prototype
      : guard;
  const describe = (instance as { describeVisibility?: unknown } | null)
    ?.describeVisibility;
  if (typeof describe !== "function") {
    return undefined;
  }
  try {
    return (describe as () => VisibilityDeclaration).call(instance);
  } catch {
    return undefined;
  }
}

function guardsOn(target: object | NewableFunction): unknown[] {
  const declared = Reflect.getMetadata(GUARDS_METADATA, target) as
    unknown[] | undefined;
  return declared ?? [];
}

function descriptionOf(
  controller: NewableFunction,
  handler: (...args: never[]) => unknown,
  method: EndpointDescriptor["method"],
  route: string,
  hints: McpToolOptions,
  options: DiscoveryOptions,
): string | undefined {
  if (hints.description !== undefined && hints.description.length > 0) {
    return hints.description;
  }
  const operation = Reflect.getMetadata("swagger/apiOperation", handler) as
    { description?: string; summary?: string } | undefined;
  const text = operation?.description ?? operation?.summary;
  const declared = text !== undefined && text.length > 0 ? text : undefined;
  const supplied = options.description?.({
    method,
    route,
    container: controller.name,
    handler,
    declared,
  });
  return supplied !== undefined && supplied.trim() !== "" ? supplied : declared;
}

/**
 * Constructors `design:returntype` writes when it has erased the type it was asked about.
 *
 * TypeScript emits the declared return type with its generics gone, so `Promise<OrderDto>` reaches
 * runtime as `Promise` and `OrderDto[]` as `Array`; `any`, `unknown` and an inferred return all
 * arrive as `Object`. Binding one of these produces a schema for the wrong type — `Promise` has no
 * validator metadata at all — so the inference tier must decline rather than publish it.
 */
const erasedReturnTypes = new Set<unknown>([Promise, Array, Object, Function]);

function readableReturnType(candidate: unknown): candidate is NewableFunction {
  return typeof candidate === "function" && !erasedReturnTypes.has(candidate);
}

function defaultStatusOf(
  handler: (...args: never[]) => unknown,
  method: EndpointDescriptor["method"],
): string {
  const declared = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as
    number | undefined;
  return declared === undefined
    ? method === "POST"
      ? "201"
      : "200"
    : String(declared);
}

/**
 * Writes a response body's schema, keeping the read-only members the request side drops.
 *
 * A get-only member is a response field precisely because it is read-only, so dropping it would
 * hide the field from the agent (schema-conversion-rules.md Table 4). One DTO bound as both request
 * body and response would otherwise report every shape diagnostic twice, so `reported` — seeded by
 * the request pass — bounds the second pass to what this endpoint has not already said.
 */
function responseSchemaOf(
  declaredType: unknown,
  isArray: boolean,
  options: DiscoveryOptions,
  reported: Set<string>,
  serializedAs?: NewableFunction,
): JsonSchemaObject {
  const { schema, diagnostics } = shapeOf(
    serializedAs ?? declaredType,
    options,
    {
      dropReadOnlyProperties: false,
    },
  );
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.message}`;
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);
    options.report?.(diagnostic);
  }
  return isArray ? { type: "array", items: schema } : schema;
}

function bodyOfDeclaration(
  declaration: McpResponseDeclaration,
  options: DiscoveryOptions,
  reported: Set<string>,
  where: string,
): { schema?: JsonSchemaObject } {
  const reading = readStandardSchema(declaration, "output");
  if (reading !== undefined) {
    if (reading.kind === "read") {
      return { schema: reading.schema };
    }
    options.report?.({
      code: "unreadable_shape",
      message: `${where} declares a response schema, but ${reading.reason}; the status is published without a body schema.`,
    });
    return {};
  }
  if (typeof declaration === "function") {
    return { schema: responseSchemaOf(declaration, false, options, reported) };
  }
  if (Array.isArray(declaration)) {
    return {
      schema: responseSchemaOf(
        (declaration as readonly NewableFunction[])[0],
        true,
        options,
        reported,
      ),
    };
  }
  return "schema" in declaration ? { schema: declaration.schema } : {};
}

function declaredResponses(
  hints: McpToolOptions,
  options: DiscoveryOptions,
  reported: Set<string>,
  where: string,
): EndpointDescriptor["responses"] | undefined {
  const entries = Object.entries(hints.responses ?? {});
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    entries.map(([status, declaration]) => [
      status,
      bodyOfDeclaration(declaration, options, reported, where),
    ]),
  );
}

function swaggerResponses(
  handler: (...args: never[]) => unknown,
  options: DiscoveryOptions,
  reported: Set<string>,
  serializedAs: NewableFunction | undefined,
): EndpointDescriptor["responses"] | undefined {
  const metadata = Reflect.getMetadata("swagger/apiResponse", handler) as
    | Record<string, { type?: unknown; isArray?: boolean } | undefined>
    | undefined;
  const entries = Object.entries(metadata ?? {}).filter(([status]) =>
    /^[1-5][0-9]{2}$/.test(status),
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    entries.map(([status, entry]) => {
      const { type, isArray } = documentedType(entry?.type, entry?.isArray);
      return [
        status,
        readableReturnType(type)
          ? {
              schema: responseSchemaOf(
                type,
                isArray,
                options,
                reported,
                serializedAs,
              ),
            }
          : {},
      ];
    }),
  );
}

function inferredResponses(
  controller: NewableFunction,
  handlerName: string,
  handler: (...args: never[]) => unknown,
  method: EndpointDescriptor["method"],
  options: DiscoveryOptions,
  reported: Set<string>,
  serializedAs: NewableFunction | undefined,
): EndpointDescriptor["responses"] | undefined {
  const returnType = Reflect.getMetadata(
    "design:returntype",
    controller.prototype as object,
    handlerName,
  ) as unknown;
  if (!readableReturnType(returnType)) {
    return undefined;
  }
  return {
    [defaultStatusOf(handler, method)]: {
      schema: responseSchemaOf(
        returnType,
        false,
        options,
        reported,
        serializedAs,
      ),
    },
  };
}

function responsesOf(
  controller: NewableFunction,
  handlerName: string,
  handler: (...args: never[]) => unknown,
  method: EndpointDescriptor["method"],
  hints: McpToolOptions,
  options: DiscoveryOptions,
  reported: Set<string>,
): EndpointDescriptor["responses"] | undefined {
  const where = `${controller.name}.${handlerName}`;
  const declared = declaredResponses(hints, options, reported, where);
  if (declared !== undefined) {
    return declared;
  }
  const chain = [
    ...(options.globalInterceptors ?? []),
    ...interceptorsOn(controller),
    ...interceptorsOn(handler),
  ];
  const serializer = serializationOf(chain, controller, handler);
  const read: DiscoveryOptions =
    serializer === undefined
      ? options
      : {
          ...options,
          schema: { ...options.schema, serialization: serializer.view },
        };
  const found =
    swaggerResponses(handler, read, reported, serializer?.type) ??
    inferredResponses(
      controller,
      handlerName,
      handler,
      method,
      read,
      reported,
      serializer?.type,
    );
  return found === undefined
    ? undefined
    : describedResponses(found, chain, controller, where, options);
}

function interceptorsOn(target: object): unknown[] {
  const declared: unknown = Reflect.getMetadata(INTERCEPTORS_METADATA, target);
  return Array.isArray(declared) ? declared : [];
}

function isClassSerializer(interceptor: unknown): boolean {
  return typeof interceptor === "function"
    ? interceptor === ClassSerializerInterceptor ||
        interceptor.prototype instanceof ClassSerializerInterceptor
    : interceptor instanceof ClassSerializerInterceptor;
}

/**
 * The `classToPlain` options a `ClassSerializerInterceptor` in the chain writes the response with:
 * its own defaults under the handler's or else the controller's `@SerializeOptions()`, as the
 * interceptor merges them.
 */
function serializationOf(
  chain: readonly unknown[],
  controller: NewableFunction,
  handler: object,
): { view: SerializationView; type?: NewableFunction } | undefined {
  const serializer = chain.find(isClassSerializer);
  if (serializer === undefined) {
    return undefined;
  }
  const defaults: unknown =
    typeof serializer === "object" && serializer !== null
      ? (serializer as { defaultOptions?: unknown }).defaultOptions
      : undefined;
  const context: unknown =
    Reflect.getMetadata(CLASS_SERIALIZER_OPTIONS, handler) ??
    Reflect.getMetadata(CLASS_SERIALIZER_OPTIONS, controller);
  const merged = { ...asRecord(defaults), ...asRecord(context) };
  const strategy = merged["strategy"];
  const type = merged["type"];
  return {
    view: {
      ...(typeof strategy === "string" ? { strategy } : {}),
      ...(merged["excludeExtraneousValues"] === true
        ? { excludeExtraneousValues: true }
        : {}),
    },
    ...(typeof type === "function" ? { type: type as NewableFunction } : {}),
  };
}

/**
 * Passes each success body through the chain's `describeResponse` hooks, innermost first, because a
 * response leaves the handler through the method's interceptors before the controller's and the
 * global ones. The root `$defs` is held aside while a hook wraps the body, since every reference
 * into it is written from the root.
 *
 * Guard: a hook runs on the instance Nest built, never on the class's prototype, where its fields
 * and injected dependencies are absent: an envelope key read from `this` came back `undefined` and
 * the schema named a property `"undefined"`, which is still a valid schema. A class Nest holds no
 * single instance of loses its success schemas instead.
 */
function describedResponses(
  responses: NonNullable<EndpointDescriptor["responses"]>,
  chain: readonly unknown[],
  controller: NewableFunction,
  where: string,
  options: DiscoveryOptions,
): NonNullable<EndpointDescriptor["responses"]> {
  const describers = chain.flatMap((interceptor) => {
    const target: unknown =
      typeof interceptor === "function"
        ? options.interceptorInstance?.(interceptor, controller)
        : interceptor;
    const declared: unknown =
      typeof interceptor === "function" ? interceptor.prototype : interceptor;
    return typeof describerOf(declared) === "function"
      ? [
          {
            describe: describerOf(target),
            name: nameOfInterceptor(interceptor),
            target,
          },
        ]
      : [];
  });
  if (describers.length === 0) {
    return responses;
  }
  const unresolved = describers.find(({ describe }) => describe === undefined);
  if (unresolved !== undefined) {
    options.report?.({
      code: "unreadable_shape",
      message: `${where}: ${unresolved.name}.describeResponse is not run, because Nest holds no single instance of ${unresolved.name} (it is request-scoped or transient); its success statuses are published without a body schema.`,
    });
  }
  return Object.fromEntries(
    Object.entries(responses).map(([status, response]) => {
      if (!/^2/.test(status) || response.schema === undefined) {
        return [status, response];
      }
      if (unresolved !== undefined) {
        return [status, {}];
      }
      const { $defs, ...body } = response.schema;
      let schema: JsonSchemaObject | undefined = body;
      for (const { target, describe, name } of [...describers].reverse()) {
        if (schema === undefined || describe === undefined) {
          break;
        }
        try {
          schema = describe.call(target, structuredClone(schema));
        } catch (error) {
          options.report?.({
            code: "unreadable_shape",
            message: `${where}: ${name}.describeResponse threw (${error instanceof Error ? error.message : String(error)}); the status is published without a body schema.`,
          });
          return [status, {}];
        }
      }
      if (schema === undefined) {
        return [status, {}];
      }
      const described: JsonSchemaObject =
        $defs === undefined ? schema : { ...schema, $defs };
      const problem = declaredSchemaProblem(described);
      if (problem !== undefined) {
        options.report?.({
          code: "unreadable_shape",
          message: `${where}: the response an interceptor describes ${problem}; the status is published without a body schema.`,
        });
        return [status, {}];
      }
      return [status, { schema: described }];
    }),
  );
}

function describerOf(
  target: unknown,
): McpResponseDescriber["describeResponse"] | undefined {
  const describe = (target as Partial<McpResponseDescriber> | null | undefined)
    ?.describeResponse;
  return typeof describe === "function" ? describe : undefined;
}

function nameOfInterceptor(interceptor: unknown): string {
  return typeof interceptor === "function"
    ? interceptor.name
    : ((interceptor as { constructor?: { name?: string } } | null)?.constructor
        ?.name ?? "an interceptor");
}

function shapeOf(
  declaredType: unknown,
  options: DiscoveryOptions,
  simplification: SchemaSimplificationOptions = {},
): { schema: JsonSchemaObject; diagnostics: DiscoveryDiagnostic[] } {
  const collected: DiscoveryDiagnostic[] = [];
  const binder = new NestTypeShapeBinder({
    ...options.schema,
    report: (diagnostic) => collected.push(diagnostic),
  });
  const { schema, diagnostics } = simplifySchema(
    binder.bind(declaredType),
    simplification,
  );
  collected.push(...diagnostics);
  return { schema, diagnostics: collected };
}

/**
 * `@ApiBody({ type })` stands in only for a parameter whose own type is erased: the pipe validates
 * against the declared parameter type, so where one is readable it is what a call must satisfy.
 */
function wholeBodyFor(
  handler: object,
  declaredType: unknown,
  options: DiscoveryOptions,
): JsonSchemaObject {
  const documented = readableReturnType(declaredType)
    ? undefined
    : documentedBody(handler);
  if (documented === undefined) {
    return bodyFor(declaredType, options);
  }
  const schema = bodyFor(documented.type, options);
  return documented.isArray ? { type: "array", items: schema } : schema;
}

export function bodyFor(
  declaredType: unknown,
  options: DiscoveryOptions,
): JsonSchemaObject {
  const { schema, diagnostics } = shapeOf(declaredType, options);
  for (const diagnostic of diagnostics) {
    options.report?.(diagnostic);
  }
  return schema;
}

function isQueryable(schema: JsonSchemaObject): boolean {
  const type = typeOf(schema);
  if (type === "array") {
    const items = schema.items;
    return items !== undefined && queryScalars.has(typeOf(items) ?? "");
  }
  return queryScalars.has(type ?? "");
}

function queryFor(
  controller: NewableFunction,
  handlerName: string,
  declaredType: unknown,
  options: DiscoveryOptions,
  validated?: JsonSchemaObject,
): EndpointDescriptor["parameters"] | undefined {
  const { schema, diagnostics } =
    validated === undefined
      ? shapeOf(declaredType, options)
      : { schema: validated, diagnostics: [] };
  const flattenable = flattenableBody(schema);
  const properties = flattenable?.properties ?? {};
  const unresolved = (): undefined => {
    options.report?.({
      code: "unresolved_query_shape",
      message: `${controller.name}.${handlerName} binds the whole query object but no member of '${nameOf(declaredType)}' can be read, so the tool would carry no filters. Decorate its properties with class-validator or @ApiProperty, or declare options.schema.typeShape.`,
    });
    return undefined;
  };

  if (allowsAdditional(schema) || Object.keys(properties).length === 0) {
    return unresolved();
  }

  const required = new Set(flattenable?.required ?? []);
  const parameters: NonNullable<EndpointDescriptor["parameters"]> = [];
  const skipped: string[] = [];
  for (const [name, property] of Object.entries(properties)) {
    if (!isQueryable(property)) {
      skipped.push(name);
      continue;
    }
    parameters.push({
      name,
      in: "query",
      required: required.has(name),
      schema: property,
    });
  }

  if (parameters.length === 0) {
    return unresolved();
  }

  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== "unreadable_shape") {
      options.report?.(diagnostic);
    }
  }
  if (skipped.length > 0) {
    options.report?.({
      code: "unbound_query_object",
      message: `${controller.name}.${handlerName} binds the whole query object; ${skipped.join(", ")} cannot be expressed as query parameters and are omitted from the tool.`,
    });
  }
  return parameters;
}

/**
 * Folds a named `@Query('x')` DTO into one object-valued parameter.
 *
 * Declining is not a failure: an unreadable or inexpressible shape falls back
 * to the binding this SDK already produced, so turning grouping on cannot drop
 * an endpoint that stands today. Express parses the bracket form only under
 * `query parser: 'extended'`, which {@link SezzleeCatalog} checks once the
 * catalog is built.
 */
function groupedQueryFor(
  controller: NewableFunction,
  handlerName: string,
  groupAs: string,
  declaredType: unknown,
  options: DiscoveryOptions,
  validated?: JsonSchemaObject,
): DescriptorParameter | undefined {
  const { schema } =
    validated === undefined
      ? shapeOf(declaredType, options)
      : { schema: validated };
  const flattenable = flattenableBody(schema);
  const required = new Set(flattenable?.required ?? []);
  const members: Record<string, JsonSchemaObject> = {};
  const skipped: string[] = [];
  for (const [name, property] of Object.entries(
    flattenable?.properties ?? {},
  )) {
    if (isQueryable(property)) {
      members[name] = property;
    } else {
      skipped.push(name);
    }
  }
  const decline = (why: string): undefined => {
    options.report?.({
      code: "unbound_query_object",
      message: `${controller.name}.${handlerName} binds the query object '${groupAs}', but ${why}, so it is not grouped. Decorate its properties with class-validator or @ApiProperty, or declare options.schema.typeShape.`,
    });
    return undefined;
  };
  if (allowsAdditional(schema)) {
    return decline(`'${nameOf(declaredType)}' is open-ended`);
  }
  const names = Object.keys(members);
  if (names.length === 0) {
    return decline(
      `no member of '${nameOf(declaredType)}' can be expressed as a query value`,
    );
  }
  if (skipped.length > 0) {
    options.report?.({
      code: "unbound_query_object",
      message: `${controller.name}.${handlerName} binds the query object '${groupAs}'; ${skipped.join(", ")} cannot be expressed as query values and are omitted from the '${groupAs}' argument.`,
    });
  }
  const requiredMembers = names.filter((name) => required.has(name));
  return {
    name: groupAs,
    in: "query",
    required: false,
    style: "deepObject",
    objectNotation: "bracket",
    schema: {
      type: "object",
      properties: members,
      ...(requiredMembers.length === 0 ? {} : { required: requiredMembers }),
      additionalProperties: false,
    },
  };
}

type DescriptorParameter = NonNullable<
  EndpointDescriptor["parameters"]
>[number];

function applyParameterHints(
  parameter: DescriptorParameter,
  hints: McpToolOptions,
): DescriptorParameter {
  const hint = hints.parameters?.[parameter.name];
  if (hint === undefined) {
    return parameter;
  }
  return {
    ...parameter,
    ...(hint.required === undefined || parameter.in === "path"
      ? {}
      : { required: hint.required }),
    ...(hint.style === undefined ? {} : { style: hint.style }),
    ...(hint.explode === undefined ? {} : { explode: hint.explode }),
  };
}

/**
 * Asks a Standard Schema whether it rejects a missing value. Validation that only resolves
 * asynchronously, or throws, gives no answer.
 */
function rejectsMissing(declared: unknown): boolean | undefined {
  const validate = (
    declared as { "~standard"?: { validate?: unknown } } | undefined
  )?.["~standard"]?.validate;
  if (typeof validate !== "function") {
    return undefined;
  }
  try {
    const result: unknown = (validate as (value: unknown) => unknown)(
      undefined,
    );
    if (result instanceof Promise) {
      result.catch(() => undefined);
      return undefined;
    }
    return (result as { issues?: unknown } | undefined)?.issues !== undefined;
  } catch {
    return undefined;
  }
}

function nameOf(declaredType: unknown): string {
  return typeof declaredType === "function"
    ? declaredType.name
    : "the query type";
}

/**
 * A schema the pipe validates against is what a call must satisfy, so it outranks the documented and
 * the declared type. A named query or header that is absent reaches it as `undefined`, which is why
 * whether it is required is asked of the schema itself rather than read from its JSON form.
 */
function namedParameter(
  entry: ArgumentEntry,
  declaredType: unknown,
  name: string,
  location: "query" | "header",
  documented: DocumentedParameter | undefined,
  validated: ValidatedArgument | undefined,
): DescriptorParameter {
  const schema =
    validated !== undefined && isQueryable(validated.schema)
      ? validated
      : undefined;
  return {
    name,
    in: location,
    required: schema?.rejectsMissing ?? documented?.required ?? false,
    schema: schema?.schema ?? scalarFor(entry, declaredType, documented),
    ...(documented?.description === undefined
      ? {}
      : { description: documented.description }),
  };
}

function scalarFor(
  entry: ArgumentEntry,
  declaredType: unknown,
  documented?: DocumentedParameter,
): JsonSchemaObject {
  const piped = pipeSchema(entry.pipes);
  if (piped !== undefined) {
    return piped;
  }
  if (documented?.schema !== undefined) {
    return documented.schema;
  }
  if (declaredType === Number) {
    return { type: "number" };
  }
  if (declaredType === Boolean) {
    return { type: "boolean" };
  }
  return { type: "string" };
}

function pipeSchema(
  pipes: readonly unknown[] | undefined,
): JsonSchemaObject | undefined {
  for (const pipe of pipes ?? []) {
    const constructor =
      typeof pipe === "function"
        ? pipe
        : (pipe as { constructor?: unknown } | null)?.constructor;
    if (constructor === ParseArrayPipe) {
      return { type: "array", items: { type: "string" } };
    }
    for (const [candidate, schema] of pipeScalars) {
      if (constructor === candidate) {
        return { ...schema };
      }
    }
  }
  return undefined;
}

function pathSchema(
  args: Record<string, ArgumentEntry>,
  paramTypes: readonly unknown[],
  placeholder: string,
  documented: DocumentedParameter | undefined,
  validatedOf: (entry: ArgumentEntry) => ValidatedArgument | undefined,
): JsonSchemaObject | undefined {
  for (const [key, entry] of Object.entries(args)) {
    const kind = Number(key.split(":")[0]);
    if (kind !== PARAM) {
      continue;
    }
    const validated = validatedOf(entry)?.schema;
    if (entry.data === undefined) {
      const member = validated?.properties?.[placeholder];
      if (member !== undefined && isQueryable(member)) {
        return member;
      }
      continue;
    }
    if (entry.data !== placeholder) {
      continue;
    }
    return validated !== undefined && isQueryable(validated)
      ? validated
      : scalarFor(entry, paramTypes[entry.index], documented);
  }
  return undefined;
}

function argumentsOf(
  controller: NewableFunction,
  handlerName: string,
): Record<string, ArgumentEntry> {
  return (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handlerName) ??
    {}) as Record<string, ArgumentEntry>;
}

function declaredRevision(
  markers: ReturnType<typeof markersOf>,
): number | undefined {
  let revision: number | undefined;
  for (const marker of markers) {
    revision = marker.options.revision ?? revision;
  }
  return revision;
}

/**
 * Flat last-wins merge, except for curation and the revision.
 *
 * `arguments` merges per argument and per field so a container-level rule that hides a tenant
 * identifier survives a method-level rule that only renames something else. A flat replacement
 * would silently unhide it. `revision` is kept out entirely: its levels are read apart
 * ({@link declaredRevision}), because a method's revision replacing its controller's would hide a
 * raised controller revision from that method's tool version.
 */
function mergeHints(
  container: ReturnType<typeof markersOf>,
  operation: ReturnType<typeof markersOf>,
): McpToolOptions {
  const merged: Record<string, unknown> = {};
  const curation: Record<string, ArgumentRule> = {};
  const variants: McpVariantOptions[] = [];
  for (const marker of [...container, ...operation]) {
    for (const [key, value] of Object.entries(marker.options)) {
      if (value === undefined || key === "revision") {
        continue;
      }
      if (key === "arguments") {
        Object.assign(curation, value as Record<string, ArgumentRule>);
        continue;
      }
      if (key === "variants") {
        variants.push(...(value as McpVariantOptions[]));
        continue;
      }
      merged[key] = value;
    }
  }
  if (Object.keys(curation).length > 0) {
    merged["arguments"] = curation;
  }
  if (variants.length > 0) {
    merged["variants"] = variants;
  }
  return merged as McpToolOptions;
}

function handlerNames(prototype: Record<string, unknown>): string[] {
  const names = new Set<string>();
  let current: object | null = prototype;
  while (current !== null && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (
        name !== "constructor" &&
        typeof (current as Record<string, unknown>)[name] === "function"
      ) {
        names.add(name);
      }
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names];
}

function pathsOf(target: object | NewableFunction): string[] {
  const declared = Reflect.getMetadata(PATH_METADATA, target) as
    string | string[] | undefined;
  if (declared === undefined) {
    return [""];
  }
  const paths = Array.isArray(declared) ? declared : [declared];
  return paths.length === 0 ? [""] : paths;
}

/**
 * Writes a Nest route as a template. An optional part — an Express 5 group (`files{/:name}`) or an
 * Express 4 `:name?` — is written present: the catalog would otherwise fold its spellings into the
 * shortest, the one without the parameter, and the agent could never send it.
 */
export function normalizeRoute(route: string): string {
  const segments: string[] = [];
  for (const segment of route.replace(/[{}]/g, "").split("/")) {
    const trimmed = segment.trim();
    if (trimmed.length > 0 && trimmed !== "/") {
      segments.push(normalizeSegment(trimmed));
    }
  }
  return `/${segments.join("/")}`;
}

/**
 * Writes every `:name` in a segment as `{name}`, wherever it sits: `:id.json` and `:from-:to` are
 * one parameter followed by literal text, and Express 4's `:id(\\d+)` constraint and `?` marker
 * belong to the parameter, not to its name.
 */
function normalizeSegment(segment: string): string {
  return segment.replace(/:(\w+)(?:\([^)]*\))?\??/g, "{$1}");
}

function placeholdersOf(route: string): string[] {
  const found: string[] = [];
  for (const match of route.matchAll(/\{([^}]+)\}/g)) {
    found.push(match[1] as string);
  }
  return found;
}
