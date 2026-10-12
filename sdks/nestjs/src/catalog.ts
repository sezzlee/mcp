import {
  Inject,
  Injectable,
  Optional,
  RequestMethod,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import {
  ApplicationConfig,
  DiscoveryService,
  HttpAdapterHost,
  ModulesContainer,
} from "@nestjs/core";
import {
  assertCatalogValid,
  buildCatalog,
  combineMarkers,
  declareRevision,
  matchesRoute,
  openApiExtensions,
  SezzleeTemplateError,
  textMediaType,
  urlEncodedMediaType,
  type ArgumentCuration,
  type CatalogBuild,
  type CatalogEntry as CoreCatalogEntry,
  type DiagnosticReporter,
  type EndpointDescriptor,
  type FileOptions,
  type OpenApiExtensions,
  type ToolAnnotations,
  type ToolRanker,
  type ToolVariant,
} from "@sezzlee/core";
import { severityOf, type CatalogDiagnostic } from "./discovery/diagnostics.js";
import {
  createRoutePaths,
  discoverEndpoints,
  modulePathOf,
  normalizeRoute,
  type DiscoveredEndpoint,
} from "./discovery/endpoint-discovery.js";
import type { ArgumentRule, McpVariantOptions } from "./decorators.js";
import {
  loadFamilies,
  resolveFamily,
  type FamilyLoads,
  type FamilyResolution,
} from "./families.js";
import {
  SEZZLEE_OPTIONS,
  type CurationRule,
  type SezzleeOptions,
} from "./options.js";
import { extensionTokens } from "./extension-points.js";
import { protectedResourceMetadataPath } from "./transport/protected-resource-metadata.js";

export { cleanTags } from "@sezzlee/core";

export interface NestSource {
  readonly controller: NewableFunction;
  readonly handlerName: string;
}

export type CatalogEntry = CoreCatalogEntry<NestSource>;

export interface CatalogSnapshot extends CatalogBuild<NestSource> {
  readonly discovered: number;
}

type LoweredFamily = Extract<FamilyResolution, { kind: "members" }>;

@Injectable()
export class SezzleeCatalog implements OnApplicationBootstrap {
  private snapshot: CatalogSnapshot | undefined;
  private currentGeneration = 0;
  private readonly listeners = new Set<() => void>();
  private loads: FamilyLoads | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly modules: ModulesContainer,
    private readonly applicationConfig: ApplicationConfig,
    @Inject(SEZZLEE_OPTIONS) private readonly options: SezzleeOptions,
    @Optional() private readonly adapterHost?: HttpAdapterHost,
    @Optional()
    @Inject(extensionTokens.toolRanker)
    private readonly toolRanker: ToolRanker | null = null,
  ) {}

  get ranker(): ToolRanker | null {
    return this.toolRanker;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get current(): CatalogSnapshot {
    this.snapshot ??= this.build(this.loads);
    return this.snapshot;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Rebuilds the catalog, loading family members first when any source is registered.
   *
   * Without a source the rebuild happens before this returns, as it always has. With one, reloads
   * run one at a time, and a rebuild that would turn a valid catalog fatal is refused and the
   * current catalog kept ([tool-families.md] §Membership): member data added under a name another
   * tool already has would otherwise take every tool offline.
   *
   * @throws SezzleeCatalogError through the returned promise when the rebuild is refused
   */
  reload(): Promise<void> {
    if (this.options.families.sources.size === 0) {
      this.commit(this.build(this.loads));
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      const loads = await loadFamilies(this.options.families, this.loads);
      const candidate = this.build(loads);
      if (candidate.fatal.length > 0 && this.current.fatal.length === 0) {
        assertCatalogValid(candidate.fatal);
      }
      this.loads = loads;
      this.commit(candidate);
    });
  }

  /**
   * Loads family members once the application's own providers are ready, since a source usually
   * reads from one of them. A catalog built earlier carries `family_not_loaded` and is rebuilt
   * here, which signals `listChanged`.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.options.families.sources.size === 0) {
      return;
    }
    await this.enqueue(async () => {
      this.loads = await loadFamilies(this.options.families, this.loads);
      if (this.snapshot !== undefined) {
        this.commit(this.build(this.loads));
      }
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.pending.then(task);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private commit(snapshot: CatalogSnapshot): void {
    this.snapshot = snapshot;
    this.currentGeneration += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  get diagnostics(): readonly CatalogDiagnostic[] {
    return this.current.diagnostics;
  }

  find(name: string): CatalogEntry | undefined {
    return this.current.byName.get(name);
  }

  ensureValid(): void {
    assertCatalogValid(this.current.fatal);
  }

  /**
   * The current catalog as `x-sezzlee` extensions, for an OpenAPI gateway to rebuild it from; write
   * them into a document with `annotateOpenApiDocument`.
   */
  openApiExtensions(): OpenApiExtensions {
    return openApiExtensions(this.current.operations);
  }

  /**
   * Guard: Express 5 defaults `query parser` to `simple`, which does not parse
   * brackets — `?filter[status]=x` then arrives as one literal key and the DTO
   * binds nothing. A tool that composes a filter the backend silently ignores
   * returns an unfiltered result set, which is the failure
   * `unresolved_query_shape` exists to prevent, so this is fatal rather than a
   * warning. Only Express is checked: `getInstance().get` is a route
   * registrar on Fastify, not a settings reader.
   */
  private reportUnparsedBrackets(
    entries: readonly CatalogEntry[],
    report: DiagnosticReporter,
  ): void {
    const bracketed = entries.filter((entry) =>
      (entry.descriptor.parameters ?? []).some(
        (parameter) =>
          parameter.style === "deepObject" &&
          (parameter.objectNotation ?? "bracket") === "bracket",
      ),
    );
    if (bracketed.length === 0) {
      return;
    }
    const adapter = this.adapterHost?.httpAdapter;
    if (adapter === undefined || adapter.getType() !== "express") {
      return;
    }
    const instance = adapter.getInstance<{ get(name: string): unknown }>();
    const parser: unknown = instance.get("query parser");
    if (parser === "extended" || typeof parser === "function") {
      return;
    }
    report({
      code: "query_parser_not_extended",
      message: `Tool '${bracketed[0]?.tool.name}' composes a bracketed query object, but this application's Express 'query parser' is '${String(parser)}', which delivers one literal key instead of an object. Call app.set('query parser', 'extended'), or declare objectNotation on the parameter.`,
    });
  }

  /**
   * Guard: Express parses a body only for the media types a registered parser declares, and an
   * unparsed body reaches the handler as `req.body === undefined` with no error (form-body-probe
   * N6) — a tool the backend answers as if every field were absent. The default parsers are
   * `jsonParser` and `urlencodedParser`, visible by name on the router stack (N7); a text body
   * needs `app.useBodyParser('text')`. Only Express is checked, for `reportUnparsedBrackets`'s
   * reason.
   */
  private lacksBodyParser(descriptor: EndpointDescriptor): string | undefined {
    const contentType = descriptor.requestBody?.contentType;
    const needed =
      contentType === textMediaType
        ? "textParser"
        : contentType === urlEncodedMediaType
          ? "urlencodedParser"
          : undefined;
    const adapter = this.adapterHost?.httpAdapter;
    if (
      needed === undefined ||
      adapter === undefined ||
      adapter.getType() !== "express"
    ) {
      return undefined;
    }
    const instance = adapter.getInstance<{
      router?: { stack?: readonly { name?: string }[] };
      _router?: { stack?: readonly { name?: string }[] };
    }>();
    const stack = instance.router?.stack ?? instance._router?.stack ?? [];
    return stack.some((layer) => layer.name === needed) ? undefined : needed;
  }

  private build(loads: FamilyLoads | undefined): CatalogSnapshot {
    const prior: CatalogDiagnostic[] = [];
    const report: DiagnosticReporter = (diagnostic) => {
      prior.push(diagnostic);
    };

    const routePaths = createRoutePaths(this.applicationConfig);
    const globalPrefix = this.applicationConfig.getGlobalPrefix();
    const versioningOptions = this.applicationConfig.getVersioning();
    const mcpPath = this.options.resourceServer?.mcpPath ?? "/mcp";
    this.checkMetadataPath(globalPrefix, mcpPath, routePaths, report);
    const refDescription = this.options.files.resolver?.refDescription;
    const files: FileOptions | undefined =
      refDescription === undefined ? undefined : { refDescription };

    const applicationId = this.modules.applicationId;
    const controllers = this.discovery
      .getControllers()
      .filter((wrapper) => typeof wrapper.metatype === "function")
      .map((wrapper) => {
        const modulePath = modulePathOf(wrapper.host?.metatype, applicationId);
        return {
          metatype: wrapper.metatype as NewableFunction,
          ...(modulePath === undefined ? {} : { modulePath }),
        };
      });

    const discovered = discoverEndpoints(controllers, {
      ...(this.options.schema === undefined
        ? {}
        : { schema: this.options.schema }),
      ...(versioningOptions === undefined ? {} : { versioningOptions }),
      globalPrefix,
      routePaths,
      severity: (code) => severityOf(code, this.options.diagnostics),
      queryGrouping: this.options.query.grouping,
      report,
    });

    const reserved = routePaths
      .create({ globalPrefix, methodPath: mcpPath }, RequestMethod.ALL)
      .map(normalizeRoute);
    const families = new Map<DiscoveredEndpoint, LoweredFamily>();
    const routed = discovered.filter((endpoint) => {
      if (reserved.some((path) => endpoint.descriptor.route.startsWith(path))) {
        return false;
      }
      const family = endpoint.hints.family;
      if (family === undefined) {
        return true;
      }
      const resolution = resolveFamily(
        family,
        `${endpoint.controller.name}.${endpoint.handlerName}`,
        endpoint.hints.variants ?? [],
        this.options.families,
        loads,
      );
      if (resolution.kind === "refused") {
        report(resolution.diagnostic);
        return false;
      }
      if (resolution.kind === "members") {
        resolution.diagnostics.forEach(report);
        families.set(endpoint, resolution);
      }
      return true;
    });

    const catalogRevision = declareRevision(
      "The catalog",
      { catalog: [{ value: this.options.revision, by: "options.revision" }] },
      report,
    )?.catalog;
    const built = buildCatalog<NestSource>(
      routed.map((endpoint) => {
        const container = endpoint.controller.name;
        const owner = `${container}.${endpoint.handlerName}`;
        const tags = endpoint.hints.tags ?? this.options.tags?.(container);
        const searchTerms =
          endpoint.hints.searchTerms ?? this.options.searchTerms?.(container);
        return {
          source: {
            controller: endpoint.controller,
            handlerName: endpoint.handlerName,
          },
          owner,
          descriptor: endpoint.descriptor,
          ...markersOf(endpoint),
          ...(tags === undefined ? {} : { tags }),
          ...(searchTerms === undefined ? {} : { searchTerms }),
          revision: {
            catalog: [{ value: catalogRevision, by: "options.revision" }],
            container: [
              {
                value: endpoint.revisions.container,
                by: `@McpTool({ revision }) on ${container}`,
              },
              {
                value: this.options.containerRevision?.(container),
                by: "options.containerRevision",
              },
            ],
            operation: [
              {
                value: endpoint.revisions.operation,
                by: `@McpTool({ revision }) on ${owner}`,
              },
            ],
          },
          declare: (cleaned) =>
            declaredDescriptor(
              endpoint,
              this.curationFor(endpoint),
              cleaned,
              families.get(endpoint),
            ),
        };
      }),
      {
        selection: this.options.selection,
        prefixMode: this.options.naming.prefixMode,
        ...(files === undefined ? {} : { files }),
        providers: this.options.arguments.providers,
        severity: (code) => severityOf(code, this.options.diagnostics),
        failOn: this.options.diagnostics.failOn ?? "fatal",
        prior,
        admit: (descriptor, name) => {
          const missingParser = this.lacksBodyParser(descriptor);
          return missingParser === undefined
            ? undefined
            : {
                code: "body_parser_missing",
                message: `Tool '${name}' sends a ${descriptor.requestBody?.contentType ?? ""} body, but this application registers no ${missingParser}; the handler would receive no body. Register the parser with app.useBodyParser(), or declare another media type.`,
              };
        },
        inspect: (entries, inspectReport) =>
          this.reportUnparsedBrackets(entries, inspectReport),
      },
    );

    return { ...built, discovered: discovered.length };
  }

  private checkMetadataPath(
    globalPrefix: string,
    mcpPath: string,
    routePaths: ReturnType<typeof createRoutePaths>,
    report: DiagnosticReporter,
  ): void {
    if (this.options.resourceServer === undefined || globalPrefix === "") {
      return;
    }
    const metadataPath = protectedResourceMetadataPath(mcpPath);
    const [served] = routePaths.create(
      { globalPrefix, methodPath: metadataPath },
      RequestMethod.GET,
    );
    if (served === metadataPath) {
      return;
    }
    report({
      code: "prm_path_prefixed",
      message: `The global prefix moves the protected-resource metadata to '${String(served)}', but RFC 9728 requires it at '${metadataPath}'; clients cannot discover the authorization server. Pass it to setGlobalPrefix's exclude list: setGlobalPrefix('${globalPrefix}', { exclude: ['${metadataPath}'] }).`,
    });
  }

  /**
   * Applies the declaration ladder, least specific first, with sealed fields last.
   *
   * Merging is per argument and per field, so a global rule that hides a tenant identifier and a
   * method-level rule that renames a page number both survive. A decorator wins a tie against a
   * central rule of the same specificity: it is nearer the code and that is the reading a
   * maintainer expects.
   */
  private curationFor(endpoint: DiscoveredEndpoint): ArgumentCuration[] {
    const central = this.options.arguments.rules
      .filter((rule) => matchesTarget(rule, endpoint))
      .sort((a, b) => a.specificity - b.specificity);
    assertUnambiguous(central, endpoint);
    const layers: Array<{
      readonly rules: Readonly<Record<string, ArgumentRule>>;
      readonly sealed: boolean;
    }> = [
      ...central.filter((rule) => !rule.sealed),
      { rules: endpoint.hints.arguments ?? {}, sealed: false },
      ...central.filter((rule) => rule.sealed),
    ];

    /**
     * Collected before the merge, not during it: sealed rules are applied last so that they win,
     * which means a check that learns the sealed names as it goes can never see an override.
     */
    const sealed = new Set(
      central
        .filter((rule) => rule.sealed)
        .flatMap((rule) => Object.keys(rule.rules)),
    );

    const merged = new Map<string, ArgumentRule>();
    for (const layer of layers) {
      for (const [name, rule] of Object.entries(layer.rules)) {
        if (sealed.has(name) && !layer.sealed) {
          throw new SezzleeTemplateError(
            "sealed_curation_overridden",
            `Argument '${name}' is sealed on ${endpoint.controller.name}.${endpoint.handlerName}; a sealed rule cannot be overridden.`,
          );
        }
        merged.set(name, rule);
      }
    }
    return toCuration(Object.fromEntries(merged));
  }
}

function markersOf(endpoint: DiscoveredEndpoint) {
  const container = combineMarkers(
    endpoint.containerMarkers.includes(true),
    endpoint.containerMarkers.includes(false),
  );
  const operation = combineMarkers(
    endpoint.operationMarkers.includes(true),
    endpoint.operationMarkers.includes(false),
  );
  return {
    ...(container === undefined ? {} : { container }),
    ...(operation === undefined ? {} : { operation }),
  };
}

/**
 * Rejects two central rules that set the same argument differently at the same specificity.
 *
 * Between levels the nearer rule simply wins, silently and by design. Within one level there is no
 * nearer rule, so a merge would have to pick by registration order and the host would be reading a
 * ladder that does not decide anything.
 */
function assertUnambiguous(
  rules: readonly CurationRule[],
  endpoint: DiscoveredEndpoint,
): void {
  const claimed = new Map<string, string>();
  for (const rule of rules) {
    for (const [name, declaration] of Object.entries(rule.rules)) {
      const key = `${rule.specificity}|${rule.sealed ? "sealed" : "open"}|${name}`;
      const written = JSON.stringify(declaration);
      const existing = claimed.get(key);
      if (existing !== undefined && existing !== written) {
        throw new SezzleeTemplateError(
          "ambiguous_curation",
          `Two curation rules of equal specificity declare argument '${name}' differently on ${endpoint.controller.name}.${endpoint.handlerName}; narrow one of their targets.`,
        );
      }
      claimed.set(key, written);
    }
  }
}

/**
 * Folds the decorator's declarations into the descriptor.
 *
 * Discovery reports facts; declarations are reduced here, the same way `toolName` and
 * `containerPrefix` are. The curation list arrives resolved because the ladder that produces it
 * needs the host's central rules, which are not a property of the endpoint; a family's members
 * arrive already lowered, because they were loaded from a source rather than declared.
 */
export function declaredDescriptor(
  endpoint: DiscoveredEndpoint,
  curation: readonly ArgumentCuration[],
  tags?: readonly string[],
  family?: LoweredFamily,
): EndpointDescriptor {
  const hints = endpoint.hints;
  const annotations = annotationsOf(hints);
  const declaredFamily =
    family?.family ??
    (hints.family === undefined
      ? undefined
      : { parameter: hints.family.parameter });
  const variants: ToolVariant[] = [
    ...(hints.variants ?? []).map(declaredVariant),
    ...(family?.variants ?? []),
  ];
  return {
    ...endpoint.descriptor,
    ...(hints.name === undefined ? {} : { toolName: hints.name }),
    ...(hints.prefix === undefined ? {} : { containerPrefix: hints.prefix }),
    ...(tags === undefined ? {} : { tags: [...tags] }),
    ...(curation.length === 0 ? {} : { arguments: [...curation] }),
    ...(variants.length === 0
      ? {}
      : { variants: variants as EndpointDescriptor["variants"] }),
    ...(declaredFamily === undefined ? {} : { family: declaredFamily }),
    ...(annotations === undefined ? {} : { annotations }),
  };
}

function declaredVariant(variant: McpVariantOptions): ToolVariant {
  const annotations = annotationsOf(variant);
  return {
    name: variant.name,
    description: variant.description,
    ...(variant.arguments === undefined
      ? {}
      : { arguments: toCuration(variant.arguments) }),
    ...(variant.body === undefined
      ? {}
      : {
          requestBody: {
            schema: variant.body,
            ...(variant.bodyRequired === undefined
              ? {}
              : { required: variant.bodyRequired }),
          },
        }),
    ...(annotations === undefined ? {} : { annotations }),
  };
}

function annotationsOf(declared: {
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
}): ToolAnnotations | undefined {
  const annotations: ToolAnnotations = {
    ...(declared.readOnly === undefined
      ? {}
      : { readOnlyHint: declared.readOnly }),
    ...(declared.destructive === undefined
      ? {}
      : { destructiveHint: declared.destructive }),
    ...(declared.idempotent === undefined
      ? {}
      : { idempotentHint: declared.idempotent }),
  };
  return Object.keys(annotations).length === 0 ? undefined : annotations;
}

export function toCuration(
  rules: Readonly<Record<string, ArgumentRule>>,
): ArgumentCuration[] {
  return Object.entries(rules).map(([name, rule]) => ({
    name,
    ...(rule.hide === undefined
      ? {
          ...(rule.as === undefined ? {} : { as: rule.as }),
          ...(rule.description === undefined
            ? {}
            : { description: rule.description }),
        }
      : { hidden: rule.hide }),
  }));
}

function matchesTarget(
  rule: CurationRule,
  endpoint: DiscoveredEndpoint,
): boolean {
  const target = rule.target;
  if (
    target.controller !== undefined &&
    target.controller !== endpoint.controller
  ) {
    return false;
  }
  if (target.handler !== undefined && target.handler !== endpoint.handlerName) {
    return false;
  }
  if (
    target.method !== undefined &&
    target.method.toUpperCase() !== endpoint.descriptor.method
  ) {
    return false;
  }
  if (
    target.route !== undefined &&
    !matchesRoute(target.route, endpoint.descriptor.route)
  ) {
    return false;
  }
  return true;
}
