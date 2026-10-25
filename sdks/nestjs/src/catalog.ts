import {
  Inject,
  Injectable,
  Logger,
  Optional,
  RequestMethod,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
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
  operationKeyOf,
  SezzleeCatalogError,
  SezzleeTemplateError,
  textMediaType,
  urlEncodedMediaType,
  ToolIndex,
  rankCatalogOf,
  searchParameters,
  type SearchDocument,
  type ArgumentCuration,
  type CatalogBuild,
  type CatalogEntry as CoreCatalogEntry,
  type DiagnosticReporter,
  type EndpointDescriptor,
  type FileOptions,
  type OpenApiExtensions,
  type OperationDecision,
  type SelectionDecision,
  type ToolAnnotations,
  type ToolRanker,
  type ToolVariant,
} from "@sezzlee/core";
import {
  severityOf,
  type CatalogDiagnostic,
  type CatalogSeverity,
} from "./discovery/diagnostics.js";
import {
  bodyFor,
  createRoutePaths,
  discoverEndpoints,
  modulePathOf,
  normalizeRoute,
  type DiscoveredEndpoint,
  type McpEndpointInfo,
} from "./discovery/endpoint-discovery.js";
import type { ArgumentRule, McpVariantOptions } from "./decorators.js";
import {
  resolveFamily,
  sameMembers,
  type FamilyBodyMapper,
  type FamilyResolution,
  type McpFamilyMember,
} from "./families.js";
import {
  resolveSelection,
  sameEntries,
  selectionSourceName,
  selectionTargetOf,
  type McpSelectionEntry,
  type ProvidedSelection,
} from "./selection-source.js";
import {
  reasonOf,
  SourceChannel,
  type LoadChannel,
  type PendingLoad,
} from "./source-loading.js";
import {
  SEZZLEE_OPTIONS,
  type CurationRule,
  type SezzleeOptions,
} from "./options.js";
import { extensionTokens } from "./extension-points.js";
import { toolInfoOf, type ToolAuthorizer } from "./visibility/authorizer.js";
import { protectedResourceMetadataPath } from "./transport/protected-resource-metadata.js";
import type { ProviderToolEntry } from "./provider-tools.js";

export { cleanTags } from "@sezzlee/core";

export interface NestSource {
  readonly controller: NewableFunction;
  readonly handlerName: string;
  readonly handler: (...args: never[]) => unknown;
  readonly family?: {
    readonly source: string;
    readonly keys: ReadonlyMap<string, string | number>;
  };
}

export type CatalogEntry = CoreCatalogEntry<NestSource>;

export type CallableEntry =
  | {
      readonly kind: "http";
      readonly entry: CatalogEntry;
      readonly tool: CatalogEntry["tool"];
      readonly tags: readonly string[];
    }
  | ProviderToolEntry;

export interface CallableCatalogSnapshot {
  readonly entries: readonly CallableEntry[];
  readonly byName: ReadonlyMap<string, CallableEntry>;
  readonly index: ToolIndex;
  readonly rankCatalog: CatalogBuild["rankCatalog"];
}

export interface CatalogSnapshot extends CatalogBuild<NestSource> {
  readonly discovered: number;
}

type LoweredFamily = Extract<FamilyResolution, { kind: "members" }>;

const logger = new Logger("Sezzlee");

interface BuiltInstance {
  readonly instance: unknown;
  readonly isTransient: boolean;
  isDependencyTreeStatic(): boolean;
}

/**
 * Guard: Nest gives a request-scoped or transient class a placeholder made from its prototype in
 * the static context, with no field set and nothing injected; only a static, non-transient
 * wrapper's instance is the object the requests run through.
 */
function singleInstance(
  wrapper: BuiltInstance | undefined,
): object | undefined {
  if (
    wrapper === undefined ||
    wrapper.isTransient ||
    !wrapper.isDependencyTreeStatic()
  ) {
    return undefined;
  }
  const { instance } = wrapper;
  return typeof instance === "object" && instance !== null
    ? instance
    : undefined;
}

const uncoveredCode = "visibility_uncovered";
const uncoveredListed = 20;

@Injectable()
export class SezzleeCatalog implements OnApplicationBootstrap, OnModuleDestroy {
  private snapshot: CatalogSnapshot | undefined;
  private readonly callables = new WeakMap<
    CatalogSnapshot,
    CallableCatalogSnapshot
  >();
  private currentGeneration = 0;
  private readonly listeners = new Set<() => void>();
  private readonly families: SourceChannel<readonly McpFamilyMember[]>;
  private readonly selection: SourceChannel<readonly McpSelectionEntry[]>;
  private readonly channels: readonly LoadChannel[];
  private pending: Promise<void> = Promise.resolve();
  private readonly refreshTimers = new Map<LoadChannel, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly modules: ModulesContainer,
    private readonly applicationConfig: ApplicationConfig,
    @Inject(SEZZLEE_OPTIONS) private readonly options: SezzleeOptions,
    @Optional() private readonly adapterHost?: HttpAdapterHost,
    @Optional()
    @Inject(extensionTokens.toolRanker)
    private readonly toolRanker: ToolRanker | null = null,
    @Optional()
    @Inject(extensionTokens.toolAuthorizer)
    private readonly toolAuthorizer: ToolAuthorizer | null = null,
  ) {
    this.families = new SourceChannel({
      label: "family",
      setting: "families",
      subject: "family members",
      noun: "member(s)",
      plural: "members",
      drops: "the operations it feeds are dropped",
      settings: options.families,
      sources: () => options.families.sources,
      size: (members) => members.length,
      same: sameMembers,
      failure: (name, error) =>
        new SezzleeCatalogError(
          "family_source_failed",
          `sezzlee family source '${name}' failed and families.onFailure is "fatal": ${reasonOf(error)}`,
        ),
      logger,
    });
    this.selection = new SourceChannel({
      label: "selection",
      setting: "selection.source",
      subject: "selection entries",
      noun: "entry(ies)",
      plural: "entries",
      drops: "endpoints without a decorator stay unselected until it does",
      settings: options.selection.source,
      sources: () => {
        const provider = options.selection.provider;
        return provider === undefined
          ? new Map()
          : new Map([[selectionSourceName, provider]]);
      },
      size: (entries) => entries.length,
      same: sameEntries,
      failure: (name, error) =>
        new SezzleeCatalogError(
          "selection_source_failed",
          `sezzlee selection source '${name}' failed and selection.source.onFailure is "fatal": ${reasonOf(error)}`,
        ),
      logger,
    });
    this.channels = [this.families, this.selection];
  }

  get ranker(): ToolRanker | null {
    return this.toolRanker;
  }

  get authorizer(): ToolAuthorizer | null {
    return this.toolAuthorizer;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get current(): CatalogSnapshot {
    this.snapshot ??= this.build();
    return this.snapshot;
  }

  get callable(): CallableCatalogSnapshot {
    return this.callablesFor(this.current);
  }

  findCallable(name: string): CallableEntry | undefined {
    return this.callable.byName.get(name);
  }

  private callablesFor(snapshot: CatalogSnapshot): CallableCatalogSnapshot {
    const known = this.callables.get(snapshot);
    if (known !== undefined) {
      return known;
    }
    const entries: CallableEntry[] = snapshot.entries.map((entry) => ({
      kind: "http",
      entry,
      tool: entry.tool,
      tags: entry.descriptor.tags ?? [],
    }));
    const byName = new Map(entries.map((entry) => [entry.tool.name, entry]));
    for (const registration of this.options.tools) {
      const entry = registration.bind(this.discovery);
      if (byName.has(entry.tool.name)) {
        throw new SezzleeCatalogError(
          "duplicate_tool_name",
          `Tool '${entry.tool.name}' is registered more than once across HTTP and provider tools.`,
        );
      }
      entries.push(entry);
      byName.set(entry.tool.name, entry);
    }
    const documents: SearchDocument[] = [
      ...snapshot.rankCatalog.documents,
      ...entries
        .filter((entry) => entry.kind === "provider")
        .map((entry) => ({
          name: entry.tool.name,
          description: entry.tool.description,
          tags: [...entry.tags],
          parameters: searchParameters(entry.tool.inputSchema),
          searchTerms: [...entry.searchTerms],
        })),
    ];
    const built = {
      entries,
      byName,
      index:
        this.options.tools.length === 0
          ? snapshot.index
          : new ToolIndex(documents),
      rankCatalog:
        this.options.tools.length === 0
          ? snapshot.rankCatalog
          : rankCatalogOf(documents),
    };
    this.callables.set(snapshot, built);
    return built;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Rebuilds the catalog, loading every registered source first.
   *
   * Without a source the rebuild happens before this returns, as it always has. With one, reloads
   * run one at a time, and a rebuild that would turn a valid catalog fatal is refused and the
   * current catalog kept ([tool-families.md] §Membership): member data added under a name another
   * tool already has would otherwise take every tool offline.
   *
   * @throws SezzleeCatalogError through the returned promise when the rebuild is refused
   */
  reload(): Promise<void> {
    const active = this.channels.filter((channel) => channel.registered);
    if (active.length === 0) {
      this.commit(this.build());
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      this.adopt(await Promise.all(active.map((channel) => channel.load())));
    });
  }

  /**
   * Loads family members again and rebuilds the catalog only when a source's published members
   * changed, so an unchanged refresh signals nothing to connected clients.
   *
   * @throws SezzleeCatalogError through the returned promise when the rebuild is refused; the
   * current catalog is kept
   */
  refreshFamilies(): Promise<void> {
    return this.refresh(this.families);
  }

  /**
   * Loads the provided selection again and rebuilds the catalog only when its rows changed.
   *
   * @throws SezzleeCatalogError through the returned promise when the rebuild is refused; the
   * current catalog is kept
   */
  refreshSelection(): Promise<void> {
    return this.refresh(this.selection);
  }

  /**
   * Loads every source once the application's own providers are ready, since a source usually
   * reads from one of them. A catalog built earlier carries `family_not_loaded` or
   * `selection_not_loaded` and is rebuilt here, which signals `listChanged`.
   *
   * A source whose load mode is `"background"` is started and not awaited; blocking sources load
   * first, because loads run one at a time.
   *
   * @throws SezzleeCatalogError `unsupported_http_adapter` when the application does not run on
   * Express; `family_source_failed` or `selection_source_failed` when the source's `onFailure` is
   * `"fatal"` and it never returned; the first fatal diagnostic's code when the catalog built from
   * what loaded is fatal
   */
  async onApplicationBootstrap(): Promise<void> {
    const adapterType = this.adapterHost?.httpAdapter?.getType();
    if (adapterType !== undefined && adapterType !== "express") {
      throw new SezzleeCatalogError(
        "unsupported_http_adapter",
        `sezzlee replays every call through the Express application, and this application runs on '${adapterType}'. Use @nestjs/platform-express.`,
      );
    }
    const active = this.channels.filter((channel) => channel.registered);
    const blocking = active.filter(
      (channel) => channel.settings.loadMode !== "background",
    );
    const background = active.filter(
      (channel) => channel.settings.loadMode === "background",
    );
    const waited = blocking.map((channel) =>
      this.enqueue(() => this.loadFirst(channel)),
    );
    for (const channel of background) {
      this.enqueue(() => this.loadFirst(channel))
        .catch((error: unknown) => {
          logger.error(
            `sezzlee ${channel.label} load failed: ${reasonOf(error)}`,
          );
        })
        .finally(() => this.scheduleRefresh(channel));
    }
    await Promise.all(waited);
    blocking.forEach((channel) => this.scheduleRefresh(channel));
    this.ensureValid();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.refreshTimers.forEach((timer) => clearTimeout(timer));
  }

  private async loadFirst(channel: LoadChannel): Promise<void> {
    const pending = await channel.load();
    pending.assertStartable();
    pending.accept();
    if (this.snapshot !== undefined) {
      this.commit(this.build());
      logger.log(
        `sezzlee catalog rebuilt with ${channel.subject}: ${this.current.byName.size} tools`,
      );
    }
  }

  private refresh(channel: LoadChannel): Promise<void> {
    if (!channel.registered) {
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      const pending = await channel.load();
      if (!pending.changed) {
        pending.accept();
        return;
      }
      this.adopt([pending]);
      logger.log(
        `sezzlee catalog rebuilt with ${channel.subject}: ${this.current.byName.size} tools`,
      );
    });
  }

  private adopt(loads: readonly PendingLoad[]): void {
    const before = this.current;
    const undo = loads.map((pending) => pending.stage());
    let candidate: CatalogSnapshot;
    try {
      candidate = this.build();
      this.callablesFor(candidate);
      if (candidate.fatal.length > 0 && before.fatal.length === 0) {
        assertCatalogValid(candidate.fatal);
      }
    } catch (error) {
      undo.reverse().forEach((rollback) => rollback());
      throw error;
    }
    this.commit(candidate);
  }

  /**
   * Guard: each tick waits for the previous refresh to finish before arming the next, so a source
   * that takes the whole `loadTimeoutMs` cannot pile refreshes up behind itself, and the timer is
   * unref'd so a refresh schedule alone never keeps the process alive. Families and the provided
   * selection each keep their own interval, and their refreshes share one queue.
   */
  private scheduleRefresh(channel: LoadChannel): void {
    const interval = channel.settings.refreshIntervalMs;
    if (interval <= 0 || this.stopped) {
      return;
    }
    const timer = setTimeout(() => {
      this.refresh(channel)
        .catch((error: unknown) => {
          logger.warn(
            `sezzlee ${channel.label} refresh failed: ${reasonOf(error)}`,
          );
        })
        .finally(() => this.scheduleRefresh(channel));
    }, interval);
    timer.unref();
    this.refreshTimers.set(channel, timer);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.pending.then(task);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private commit(snapshot: CatalogSnapshot): void {
    this.callablesFor(snapshot);
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
    this.callablesFor(this.current);
  }

  /**
   * The current catalog as `x-sezzlee` extensions, for an OpenAPI gateway to rebuild it from; write
   * them into a document with `annotateOpenApiDocument`.
   */
  openApiExtensions(): OpenApiExtensions {
    if (this.options.tools.length > 0) {
      logger.warn(
        "Provider tools have no HTTP operations and are omitted from OpenAPI extensions.",
      );
    }
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
   * reason. `_router` is read first: Express 4 keeps the stack there and defines `router` as a
   * getter that throws, which would fail every catalog build; Express 5 has no `_router`.
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
    const stack = (instance._router ?? instance.router)?.stack ?? [];
    return stack.some((layer) => layer.name === needed) ? undefined : needed;
  }

  private build(): CatalogSnapshot {
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
    const wrappers = this.discovery
      .getControllers()
      .filter((wrapper) => typeof wrapper.metatype === "function");
    const controllers = wrappers.map((wrapper) => {
      const modulePath = modulePathOf(wrapper.host?.metatype, applicationId);
      return {
        metatype: wrapper.metatype as NewableFunction,
        ...(modulePath === undefined ? {} : { modulePath }),
      };
    });
    const hosts = new Map(
      wrappers.map((wrapper) => [wrapper.metatype, wrapper.host]),
    );

    const found = discoverEndpoints(controllers, {
      ...(this.options.schema === undefined
        ? {}
        : { schema: this.options.schema }),
      ...(versioningOptions === undefined ? {} : { versioningOptions }),
      globalGuards: [
        ...this.applicationConfig.getGlobalGuards(),
        ...this.applicationConfig
          .getGlobalRequestGuards()
          .map((wrapper) => wrapper.metatype),
      ],
      globalInterceptors: [
        ...this.applicationConfig.getGlobalInterceptors(),
        ...this.applicationConfig
          .getGlobalRequestInterceptors()
          .map((wrapper) => singleInstance(wrapper) ?? wrapper.metatype),
      ],
      interceptorInstance: (interceptor, controller) =>
        singleInstance(hosts.get(controller)?.injectables.get(interceptor)),
      globalPrefix,
      routePaths,
      severity: (code) => this.severityFor(code),
      queryGrouping: this.options.query.grouping,
      ...(this.options.description === undefined
        ? {}
        : { description: this.options.description }),
      report,
    });
    const provided = new Map<DiscoveredEndpoint, SelectionDecision>();
    const discovered = this.applyProvidedSelection(found, provided, report);

    const mapBody: FamilyBodyMapper = (bodyType, reportNote) =>
      bodyFor(bodyType, {
        ...(this.options.schema === undefined
          ? {}
          : { schema: this.options.schema }),
        report: reportNote,
      });
    const reserved = routePaths
      .create({ globalPrefix, methodPath: mcpPath }, RequestMethod.ALL)
      .map(normalizeRoute);
    const families = new Map<DiscoveredEndpoint, LoweredFamily>();
    const routed = discovered.filter((endpoint) => {
      const route = endpoint.descriptor.route;
      if (
        reserved.some((path) => route === path || route.startsWith(`${path}/`))
      ) {
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
        this.families.loads,
        mapBody,
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
        const info = endpointInfoOf(endpoint);
        const tags =
          endpoint.hints.tags ??
          this.options.endpointTags?.(info) ??
          this.options.tags?.(container);
        const searchTerms =
          endpoint.hints.searchTerms ??
          this.options.endpointSearchTerms?.(info) ??
          this.options.searchTerms?.(container);
        const lowered = families.get(endpoint);
        const familySource = endpoint.hints.family?.source;
        return {
          source: {
            controller: endpoint.controller,
            handlerName: endpoint.handlerName,
            handler: endpoint.handler,
            ...(lowered === undefined || familySource === undefined
              ? {}
              : { family: { source: familySource, keys: lowered.keys } }),
          },
          owner,
          descriptor: endpoint.descriptor,
          ...markersOf(endpoint),
          ...(provided.has(endpoint)
            ? { provided: provided.get(endpoint) }
            : {}),
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
        severity: (code) => this.severityFor(code),
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
        inspect: (entries, inspectReport) => {
          this.reportUnparsedBrackets(entries, inspectReport);
          this.reportUncovered(entries, inspectReport);
        },
      },
    );

    return {
      ...built,
      operations: withUnpublished(built.operations, discovered),
      discovered: discovered.length,
    };
  }

  /**
   * Guard: until a provided source has returned, an endpoint without a decorator marker is
   * excluded rather than left to the rules or the global default, because the source may be the one
   * thing excluding it and falling through could publish it. Decorated endpoints are decided as
   * usual.
   */
  private applyProvidedSelection(
    discovered: readonly DiscoveredEndpoint[],
    provided: Map<DiscoveredEndpoint, SelectionDecision>,
    report: DiagnosticReporter,
  ): DiscoveredEndpoint[] {
    if (!this.selection.registered) {
      return [...discovered];
    }
    const resolution = resolveSelection(
      this.selection.loads,
      new Set(
        discovered.map((endpoint) => selectionTargetOf(endpoint.descriptor)),
      ),
    );
    resolution.diagnostics.forEach(report);
    if (!resolution.loaded) {
      this.reportSelectionNotLoaded(report);
    }
    return discovered.map((endpoint) => {
      const row = resolution.targets.get(
        selectionTargetOf(endpoint.descriptor),
      );
      const decorated =
        endpoint.containerMarkers.length > 0 ||
        endpoint.operationMarkers.length > 0;
      if (row === undefined) {
        if (!resolution.loaded && !decorated) {
          provided.set(endpoint, "exclude");
        }
        return endpoint;
      }
      const applied = withProvided(endpoint, row);
      provided.set(applied, row.decision);
      return applied;
    });
  }

  private reportSelectionNotLoaded(report: DiagnosticReporter): void {
    const background = this.options.selection.source.loadMode === "background";
    const message = background
      ? "The selection source has not returned yet; endpoints without a decorator stay unselected until it does."
      : "The selection source has never returned; endpoints without a decorator stay unselected.";
    report({ code: "selection_not_loaded", message });
    if (background) {
      logger.log(message);
    } else {
      logger.warn(message);
    }
  }

  private severityFor(code: string): CatalogSeverity {
    return code === uncoveredCode &&
      this.options.visibility.onUncovered === "fatal"
      ? "fatal"
      : severityOf(code, this.options.diagnostics);
  }

  /**
   * Guard: without an authorizer the check stays off unless `visibility.onUncovered` is `"fatal"`,
   * because every existing host has tools no tier decides and would gain a warning it never asked
   * for. A probe-tier tool counts as reachable when it has a request template, the condition
   * `canProbe` starts from, and `maxProbesPerSearch` leaves search room to probe; the injected
   * prober is not available to the catalog.
   */
  private reportUncovered(
    entries: readonly CatalogEntry[],
    report: DiagnosticReporter,
  ): void {
    const authorizer = this.toolAuthorizer;
    const { tier, maxProbesPerSearch, onUncovered } = this.options.visibility;
    if (authorizer === null && onUncovered !== "fatal") {
      return;
    }
    const probed = tier === "probe" && maxProbesPerSearch > 0;
    const names = entries
      .filter((entry) => {
        if (authorizer?.covers(toolInfoOf(entry)) === true) {
          return false;
        }
        const auth = entry.descriptor.auth;
        if (!auth.imperative && auth.anonymous !== "unknown") {
          return false;
        }
        return !(probed && entry.template !== undefined);
      })
      .map((entry) => entry.tool.name);
    if (names.length === 0) {
      return;
    }
    const listed = names.slice(0, uncoveredListed).join(", ");
    const rest = names.length - uncoveredListed;
    const message = `${String(names.length)} selected tool(s) have a visibility no tier can decide before a call: ${listed}${rest > 0 ? `, and ${String(rest)} more` : ""}. Cover them in the authorizer, declare their guards, or use the probe tier.`;
    report({ code: uncoveredCode, message });
    logger.warn(message);
    logger.debug(`sezzlee uncovered tools: ${names.join(", ")}`);
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

/**
 * Guard: an endpoint dropped before the catalog saw it (the MCP route, a refused family) is still
 * an operation of the backend's OpenAPI document. Without a decision it would carry no `x-sezzlee`
 * marker, and a gateway including by default would publish it, a refused family as its uncurated
 * dispatcher.
 */
function withUnpublished(
  operations: ReadonlyMap<string, OperationDecision>,
  discovered: readonly DiscoveredEndpoint[],
): ReadonlyMap<string, OperationDecision> {
  const all = new Map(operations);
  for (const endpoint of discovered) {
    const key = operationKeyOf(endpoint.descriptor);
    if (!all.has(key)) {
      all.set(key, {});
    }
  }
  return all;
}

/**
 * Applies a provided row's overrides at their documented positions: below the decorator's own
 * declaration and above the hook or derived value that would otherwise decide.
 */
function withProvided(
  endpoint: DiscoveredEndpoint,
  row: ProvidedSelection,
): DiscoveredEndpoint {
  const hints = endpoint.hints;
  const declaresDescription =
    hints.description !== undefined && hints.description.length > 0;
  const name = hints.name ?? row.name;
  const tags = hints.tags ?? row.tags;
  const searchTerms = hints.searchTerms ?? row.searchTerms;
  const description = declaresDescription ? undefined : row.description;
  return {
    ...endpoint,
    hints: {
      ...hints,
      ...(name === undefined ? {} : { name }),
      ...(tags === undefined ? {} : { tags }),
      ...(searchTerms === undefined ? {} : { searchTerms }),
    },
    descriptor:
      description === undefined
        ? endpoint.descriptor
        : { ...endpoint.descriptor, description },
  };
}

function endpointInfoOf(endpoint: DiscoveredEndpoint): McpEndpointInfo {
  return {
    method: endpoint.descriptor.method,
    route: endpoint.descriptor.route,
    container: endpoint.controller.name,
    handler: endpoint.handler,
    declared: endpoint.descriptor.description,
  };
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
