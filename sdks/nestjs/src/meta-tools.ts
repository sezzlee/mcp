import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  catalogGenerationMetaKey,
  checkPinnedVersion,
  compose,
  createLoadedTool,
  emitGuarded as emitWithin,
  errorResult,
  invokeArgumentsDescription,
  invokeDescription,
  invokeResponse,
  invokeVersionDescription,
  knownFields,
  loadDescription,
  missingArgument,
  narrowingArguments,
  normalizeInvokeArguments,
  notInvocable,
  operationNameDescription,
  readHandleDescription,
  readLimitDescription,
  readOffsetDescription,
  readPathDescription,
  readResultDescription,
  readSelectDescription,
  readStoredResult,
  refuseRateLimited,
  refuseTimedOutInvoke,
  refuseUnreadResponse,
  refuseUnresolvedFile,
  resolveDeferred as resolveDeferredWith,
  searchDescription,
  searchDetailDescription,
  searchLimitDescription,
  searchQueryDescription,
  searchTagsDescription,
  SezzleeArgumentError,
  SezzleeDispatchAborted,
  textResult,
  unknownTool,
  vocabularyOf,
  wrongArgumentType,
  defaultSearchLimit,
  searchCatalog,
  describeRankerEvent,
  type CallerScope,
  type MetaResponse,
  type ResultShelf,
  type ResultStore,
  type SdkError,
  type SearchRankerOptions,
  type VisibilityDecision,
  type WireResult,
} from "@sezzlee/core";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import type { CatalogEntry, SezzleeCatalog } from "./catalog.js";
import type { CallerScopeResolver } from "./cache.js";
import type {
  DispatchDeadline,
  DispatchFiles,
  SezzleeDispatcher,
} from "./dispatcher.js";
import { SezzleeFileRefused } from "./files.js";
import type { InvokeResultMapper } from "./invoke-result-mapper.js";
import { callerOf } from "./options.js";
import type {
  InvokeTarget,
  OuterRequest,
  SezzleeOptions,
  VerifiedToken,
} from "./options.js";
import { currentOuterConnection } from "./outer-connection.js";
import { SezzleeResponseTooLarge } from "./synthetic-context.js";
import {
  createRateLimitGate,
  type RateLimitGate,
} from "./rate-limiting/gate.js";
import type { McpCallContext, McpMetaTool } from "./rate-limiting/types.js";
import { toolInfoOf } from "./visibility/authorizer.js";
import type { CallerVisibilityProvider } from "./visibility/provider.js";

export interface MetaToolDependencies {
  readonly catalog: SezzleeCatalog;
  readonly dispatcher: SezzleeDispatcher;
  readonly mapper: InvokeResultMapper;
  readonly visibility: CallerVisibilityProvider;
  readonly scopes: CallerScopeResolver;
  readonly options: SezzleeOptions;
  /** Where an over-budget `invoke_tool` success is kept; absent or `null` refuses it instead. */
  readonly results?: ResultStore | null;
}

interface ToolContext {
  readonly mcpReq?: { readonly signal?: AbortSignal };
  readonly http?: {
    readonly req?: { readonly headers: Headers };
    readonly authInfo?: VerifiedToken;
  };
}

export { catalogGenerationMetaKey };

const logger = new Logger("Sezzlee");

/**
 * Guard: `name` binds as `unknown` and the object publishes its own `required`, so a call that
 * misspells the argument reaches the handler instead of the framework's validator. The published
 * schema is byte-identical to a plain `z.string()` one — `.meta` supplies the `type` the runtime
 * no longer implies. Without this the MCP SDK answers with a bare text error that is not JSON, so
 * the agent cannot parse it, the leak filter never runs, and the turn dies with nothing to repair
 * from. Measured: a model called `load_tool` with `operation` instead of `name`. Pinned by
 * test/meta-tools.spec.ts and by T19.
 */
function namedArgument(description: string) {
  return z.unknown().optional().meta({ type: "string", description });
}

function timeoutFor(deps: MetaToolDependencies, target: InvokeTarget): number {
  const invoke = deps.options.invoke;
  return invoke.timeoutMsFor?.(target) ?? invoke.timeoutMs;
}

function budgetFor(
  deps: MetaToolDependencies,
  target: InvokeTarget | undefined,
): number {
  const invoke = deps.options.invoke;
  const override =
    target === undefined ? undefined : invoke.maxResponseBytesFor?.(target);
  return override ?? invoke.maxResponseBytes;
}

function rankerFor(deps: MetaToolDependencies): {
  ranker?: SearchRankerOptions;
} {
  const ranker = deps.catalog.ranker ?? null;
  if (ranker === null) {
    return {};
  }
  const { rankerTimeoutMs, onRankerFailure } = deps.options.search;
  return {
    ranker: {
      ranker,
      timeoutMs: rankerTimeoutMs,
      onFailure: onRankerFailure,
      report: (event) => {
        const message = describeRankerEvent(event, onRankerFailure);
        if (event.kind === "fallback" && event.error !== undefined) {
          logger.warn(message, event.error);
        } else {
          logger.warn(message);
        }
      },
    },
  };
}

/**
 * The MCP call's cancellation channel, read separately from {@link outerFrom}.
 *
 * A stdio session has no `ctx.http`, so folding the signal into `OuterRequest` would either lose it
 * there or synthesize an outer request that never existed — which would start calling the host's
 * identity projector on a transport that carries no headers.
 */
function deadlineFrom(ctx: unknown): DispatchDeadline | undefined {
  const signal = (ctx as ToolContext | undefined)?.mcpReq?.signal;
  return signal === undefined ? undefined : { signal };
}

/**
 * Guard: `ctx.http.req` is a Web `Request`, so its `Headers` has to be flattened into the Node
 * record every identity carrier and value provider in this SDK reads. Iterating `Headers` already
 * lower-cases each name and joins repeats with ", " — the same shape Node produces — so a carrier
 * configured for `x-tenant-id` keeps matching across the v1 to v2 move.
 */
function headersOf(headers: Headers): OuterRequest["headers"] {
  const record: Record<string, string> = {};
  for (const [name, value] of headers) {
    record[name] = value;
  }
  return record;
}

function outerFrom(ctx: unknown): OuterRequest | undefined {
  const request = (ctx as ToolContext | undefined)?.http?.req;
  if (request === undefined) {
    return undefined;
  }
  const connection = currentOuterConnection();
  const auth = (ctx as ToolContext | undefined)?.http?.authInfo;
  return {
    headers: headersOf(request.headers),
    ...(connection === undefined ? {} : { connection }),
    ...(auth === undefined ? {} : { auth }),
  };
}

function emitGuarded(
  deps: MetaToolDependencies,
  produce: () => Promise<MetaResponse<InvokeTarget>>,
  shelf?: ResultShelf,
): Promise<WireResult> {
  return emitWithin((target) => budgetFor(deps, target), produce, shelf);
}

function shelfFor(
  deps: MetaToolDependencies,
  ctx: unknown,
): ResultShelf | undefined {
  const store = deps.results;
  if (store === undefined || store === null) {
    return undefined;
  }
  return {
    store,
    partition: scopeFor(deps, outerFrom(ctx)).key,
    report: (error) => {
      logger.warn(
        "The result store failed to keep an over-budget answer; the call was answered with response_too_large instead.",
        error,
      );
    },
  };
}

const metaToolNames = {
  search: "search_tools",
  load: "load_tool",
  invoke: "invoke_tool",
  read: "read_result",
} as const;

interface LimitedCall {
  readonly metaTool: McpMetaTool;
  readonly toolName: string;
  readonly name?: unknown;
}

/**
 * Guard: the MCP handler builds a server per exchange, so limiter state cannot live in the
 * handlers' closures, and `MetaToolDependencies` is built by the host with no place to carry it.
 * Keyed by the options object, which lives as long as the process, the gate is shared by every
 * server built from them. Without this each request would meet a full bucket.
 */
const gates = new WeakMap<SezzleeOptions, RateLimitGate | null>();

function gateFor(deps: MetaToolDependencies): RateLimitGate | undefined {
  const known = gates.get(deps.options);
  if (known !== undefined) {
    return known ?? undefined;
  }
  const options = deps.options.rateLimiting;
  const created =
    options === undefined ? undefined : createRateLimitGate(options);
  gates.set(deps.options, created ?? null);
  return created;
}

function callContextOf(
  deps: MetaToolDependencies,
  ctx: unknown,
  call: LimitedCall,
): McpCallContext {
  const request = outerFrom(ctx);
  const entry =
    typeof call.name === "string" ? deps.catalog.find(call.name) : undefined;
  return {
    request,
    metaTool: call.metaTool,
    target: entry === undefined ? undefined : toolInfoOf(entry),
    toolName: call.toolName,
    callerScope: scopeFor(deps, request).key,
  };
}

async function throttled<T>(
  deps: MetaToolDependencies,
  ctx: unknown,
  call: LimitedCall,
  produce: () => Promise<T>,
  refused: (error: SdkError) => T,
): Promise<T> {
  const gate = gateFor(deps);
  if (gate === undefined) {
    return produce();
  }
  const admission = await gate.admit(
    callContextOf(deps, ctx, call),
    deadlineFrom(ctx)?.signal,
  );
  if (!admission.granted) {
    logger.debug(
      `${call.toolName} refused by the rate limit (${call.metaTool}, partition '${admission.partition}')`,
    );
    return refused(refuseRateLimited(admission.retryAfterSeconds));
  }
  try {
    return await produce();
  } finally {
    admission.release();
  }
}

function limited(
  deps: MetaToolDependencies,
  ctx: unknown,
  metaTool: keyof typeof metaToolNames,
  name: unknown,
  produce: () => Promise<MetaResponse<InvokeTarget>>,
): Promise<WireResult> {
  return emitGuarded(
    deps,
    () =>
      throttled(
        deps,
        ctx,
        { metaTool, toolName: metaToolNames[metaTool], name },
        produce,
        (error) => ({ payload: error, isError: true }),
      ),
    metaTool === "invoke" ? shelfFor(deps, ctx) : undefined,
  );
}

/**
 * Puts a host's own tool, registered on the same server, behind the rate limit as `other`.
 *
 * @param handler the tool's handler
 * @returns the handler to register; a refusal is a normal `isError` result, as for the meta-tools
 */
export function rateLimitHostTool<Args, Context>(
  deps: MetaToolDependencies,
  toolName: string,
  handler: (args: Args, ctx: Context) => Promise<CallToolResult>,
): (args: Args, ctx: Context) => Promise<CallToolResult> {
  return (args, ctx) =>
    throttled(
      deps,
      ctx,
      { metaTool: "other", toolName },
      () => handler(args, ctx),
      (error) => ({
        content: [{ type: "text", text: JSON.stringify(error) }],
        isError: true,
      }),
    );
}

export function registerSezzleeTools(
  server: McpServer,
  deps: MetaToolDependencies,
): void {
  const generationMeta = (): Record<string, unknown> => ({
    [catalogGenerationMetaKey]: deps.catalog.generation,
  });

  server.registerTool(
    "search_tools",
    {
      description: searchDescription,
      _meta: generationMeta(),
      inputSchema: z.object({
        query: z.string().default("").describe(searchQueryDescription),
        limit: z
          .number()
          .int()
          .default(defaultSearchLimit)
          .describe(searchLimitDescription),
        /**
         * Guard: `.catch` is what makes an unrecognised `detail` fall back to `card`
         * instead of failing validation; without it a mistyped value rejects the whole
         * `search_tools` call. It does not change the published schema, which still
         * carries `enum` and `default`.
         */
        detail: z
          .enum(["card", "schema"])
          .catch("card")
          .default("card")
          .describe(searchDetailDescription),
        /**
         * Guard: `meta` publishes `default: null` in the meta-tool schema clients already read. It
         * decorates the schema only; `parse` still yields `undefined` for an absent value. Pinned
         * by test/meta-tools.spec.ts.
         */
        tags: z
          .array(z.string())
          .describe(searchTagsDescription)
          .optional()
          .meta({ default: null }),
      }),
    },
    async ({ query, limit, detail, tags }, ctx) =>
      limited(deps, ctx, "search", undefined, async () => {
        const started = performance.now();
        deps.catalog.ensureValid();
        const outer = outerFrom(ctx);
        const decide = await decider(deps, outer, deadlineFrom(ctx)?.signal);
        const visibility = deps.options.visibility;
        const signal = deadlineFrom(ctx)?.signal;
        const scope = scopeFor(deps, outer);
        const response = await searchCatalog({
          catalog: deps.catalog.current,
          query,
          limit,
          detail,
          tags,
          decide,
          visible: (decision) => deps.visibility.visible(decision),
          ...rankerFor(deps),
          ...deadlineFrom(ctx),
          ...(visibility.tier === "probe" && visibility.maxProbesPerSearch > 0
            ? {
                probe: {
                  maxProbes: visibility.maxProbesPerSearch,
                  concurrency: visibility.probeConcurrency,
                  canProbe: (entry: CatalogEntry) =>
                    deps.visibility.canProbe(entry),
                  cached: (entry: CatalogEntry) =>
                    deps.visibility.cachedProbe(scope, entry),
                  run: (entry: CatalogEntry) =>
                    deps.visibility.probe(scope, entry, outer, signal),
                  capReached: () => {
                    logger.warn(
                      `search_tools stopped probing at visibility.maxProbesPerSearch (${String(visibility.maxProbesPerSearch)}); the tools left unprobed follow visibility.onUnknown. Raise the cap or cover those tools with a toolAuthorizer.`,
                    );
                  },
                },
              }
            : {}),
        });
        logger.debug(
          `search_tools answered in ${elapsedSince(started)} ms: ${describeCounts(response.payload)}`,
        );
        return response;
      }),
  );

  server.registerTool(
    "load_tool",
    {
      description: loadDescription,
      _meta: generationMeta(),
      inputSchema: z
        .object({ name: namedArgument(operationNameDescription) })
        .meta({ required: ["name"] }),
    },
    async ({ name }, ctx) =>
      limited(deps, ctx, "load", name, async () => {
        if (name === undefined) {
          return missingArgument("load_tool", "name");
        }
        if (typeof name !== "string") {
          return wrongArgumentType("load_tool", "name", name);
        }
        const started = performance.now();
        deps.catalog.ensureValid();
        const entry = deps.catalog.find(name);
        if (entry === undefined) {
          return unknownTool(name);
        }
        const decision = await decisionFor(deps, ctx, entry);
        const visible = deps.visibility.visible(decision);
        logger.debug(
          `load_tool answered in ${elapsedSince(started)} ms: ${visible ? "loaded" : "not visible"}`,
        );
        if (!visible) {
          return unknownTool(name);
        }
        return textResult(createLoadedTool(entry.tool, decision), false);
      }),
  );

  server.registerTool(
    "invoke_tool",
    {
      description: invokeDescription,
      _meta: generationMeta(),
      /**
       * Guard: `arguments` publishes a description and no `type`, so a value that is not an object
       * reaches the handler and leaves as an sezzlee envelope. A schema that constrained it was
       * rejected during the framework's own argument binding, and the caller got an answer carrying
       * neither the envelope nor the leak filter. Pinned by test/meta-tools.spec.ts and by T18.
       */
      inputSchema: z
        .object({
          name: namedArgument(operationNameDescription),
          arguments: z.unknown().optional().meta({
            description: invokeArgumentsDescription,
          }),
          /**
           * Guard: it binds as `unknown` so a value that is not a string reaches
           * checkPinnedVersion and leaves as an envelope, while `meta` keeps the published type a
           * string with `default: null`. Pinned by test/meta-tools.spec.ts.
           */
          version: z.unknown().optional().meta({
            type: "string",
            description: invokeVersionDescription,
            default: null,
          }),
        })
        .meta({ required: ["name", "arguments"] }),
    },
    async ({ name, arguments: args, version }, ctx) =>
      limited(deps, ctx, "invoke", name, async () => {
        if (name === undefined) {
          return missingArgument("invoke_tool", "name");
        }
        if (typeof name !== "string") {
          return wrongArgumentType("invoke_tool", "name", name);
        }
        deps.catalog.ensureValid();
        const entry = deps.catalog.find(name);
        if (entry === undefined) {
          return unknownTool(name);
        }
        const outer = outerFrom(ctx);
        const stale = checkPinnedVersion(entry.tool, version);
        if (stale !== undefined) {
          return stale;
        }
        if (entry.template === undefined) {
          return notInvocable(name);
        }
        const normalized = normalizeInvokeArguments(args);
        if (normalized.unwrapped) {
          logger.warn(
            `invoke_tool received the arguments for '${name}' as JSON text instead of a JSON object; the text was parsed. A client that double-encodes this argument is defective.`,
          );
        }
        /**
         * Sources are resolved once per invocation and the same map feeds every composition, so a
         * source that is not constant cannot make validation and dispatch disagree.
         */
        const target: InvokeTarget = {
          tool: entry.tool.name,
          method: entry.descriptor.method,
          route: entry.descriptor.route,
        };
        const files: DispatchFiles = {
          target,
          maxInlineFileBytes: deps.options.invoke.maxInlineFileBytes,
          maxFileBytes: deps.options.invoke.maxFileBytes,
        };
        let deferred: Readonly<Record<string, unknown>> | undefined;
        try {
          deferred = await resolveDeferredWith(
            entry.template,
            deps.options.arguments.providers,
            callerOf(outer),
          );
          compose(entry.template, normalized.value, deferred, {
            maxInlineFileBytes: files.maxInlineFileBytes,
          });
        } catch (error) {
          if (error instanceof SezzleeArgumentError) {
            return errorResult(error.code, error.message);
          }
          throw error;
        }
        const timeoutMs = timeoutFor(deps, target);
        let result;
        try {
          result = await deps.dispatcher.dispatch(
            entry.template,
            normalized.value,
            outer,
            deferred,
            { ...deadlineFrom(ctx), timeoutMs },
            files,
          );
        } catch (error) {
          if (
            error instanceof SezzleeDispatchAborted &&
            error.reason === "timeout"
          ) {
            return { payload: refuseTimedOutInvoke(timeoutMs), isError: true };
          }
          if (error instanceof SezzleeArgumentError) {
            return errorResult(error.code, error.message);
          }
          if (error instanceof SezzleeResponseTooLarge) {
            return {
              payload: refuseUnreadResponse({
                limit: error.limit,
                narrowing: narrowingArguments(entry.tool.inputSchema),
                applied:
                  error.status < 400 &&
                  entry.tool.annotations.readOnlyHint !== true,
              }),
              isError: true,
            };
          }
          if (error instanceof SezzleeFileRefused) {
            return {
              payload: refuseUnresolvedFile(
                error.field,
                error.reason,
                error.limit,
              ),
              isError: true,
            };
          }
          throw error;
        }
        const outcome = deps.mapper.map(
          result,
          knownFields(entry.tool),
          vocabularyOf(entry.template),
        );
        return invokeResponse(entry, outcome, target);
      }),
  );

  const store = deps.results;
  if (store === undefined || store === null) {
    return;
  }
  server.registerTool(
    "read_result",
    {
      description: readResultDescription,
      _meta: generationMeta(),
      annotations: { readOnlyHint: true },
      /**
       * Guard: every argument binds as `unknown` for the reason `namedArgument` states; the core
       * checks each one and answers a wrong type with an envelope. `meta` publishes the types.
       */
      inputSchema: z
        .object({
          handle: namedArgument(readHandleDescription),
          path: z.unknown().optional().meta({
            type: "string",
            description: readPathDescription,
            default: "",
          }),
          select: z
            .unknown()
            .optional()
            .meta({
              type: "array",
              items: { type: "string" },
              description: readSelectDescription,
              default: null,
            }),
          offset: z.unknown().optional().meta({
            type: "integer",
            minimum: 0,
            description: readOffsetDescription,
            default: 0,
          }),
          limit: z.unknown().optional().meta({
            type: "integer",
            minimum: 1,
            description: readLimitDescription,
            default: null,
          }),
        })
        .meta({ required: ["handle"] }),
    },
    async ({ handle, path, select, offset, limit }, ctx) =>
      limited(deps, ctx, "read", undefined, () =>
        readStoredResult(
          { handle, path, select, offset, limit },
          {
            store,
            partition: scopeFor(deps, outerFrom(ctx)).key,
          },
          async (tool) => {
            deps.catalog.ensureValid();
            const entry = deps.catalog.find(tool);
            return (
              entry !== undefined &&
              deps.visibility.visible(await decisionFor(deps, ctx, entry))
            );
          },
        ),
      ),
  );
}

/**
 * The decision `load_tool` makes for one tool and one caller: the cheaper tiers, then a probe when
 * the probe tier is on and they left the tool `unknown`.
 */
async function decisionFor(
  deps: MetaToolDependencies,
  ctx: unknown,
  entry: CatalogEntry,
): Promise<VisibilityDecision> {
  const outer = outerFrom(ctx);
  const signal = deadlineFrom(ctx)?.signal;
  const decide = await decider(deps, outer, signal);
  const decision = decide(entry);
  if (
    decision === "unknown" &&
    deps.options.visibility.tier === "probe" &&
    deps.visibility.canProbe(entry)
  ) {
    return deps.visibility.probe(scopeFor(deps, outer), entry, outer, signal);
  }
  return decision;
}

/**
 * An authorizer's `allow` or `deny` is final; `unknown` falls through to the declarative tier, and
 * the probe tier after it. Decisions are held for the length of one call, so the host's `decide`
 * runs once per tool although search reads each tool twice.
 */
async function decider(
  deps: MetaToolDependencies,
  outer: OuterRequest | undefined,
  signal: AbortSignal | undefined,
): Promise<(entry: CatalogEntry) => VisibilityDecision> {
  const snapshot = deps.catalog.current;
  const scope = scopeFor(deps, outer);
  const [facts, access] = await Promise.all([
    deps.visibility.facts(scope, outer, snapshot.policyNames),
    deps.visibility.access(scope, outer, signal),
  ]);
  if (access === undefined) {
    return (entry) => deps.visibility.decideFor(entry, facts, undefined);
  }
  const decided = new Map<CatalogEntry, VisibilityDecision>();
  return (entry) => {
    const held = decided.get(entry);
    if (held !== undefined) {
      return held;
    }
    const decision = deps.visibility.decideFor(entry, facts, access);
    decided.set(entry, decision);
    return decision;
  };
}

function elapsedSince(started: number): number {
  return Math.round(performance.now() - started);
}

function describeCounts(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "no results";
  }
  const results: unknown = Reflect.get(payload, "results");
  const total: unknown = Reflect.get(payload, "total");
  return `${Array.isArray(results) ? results.length : 0} result(s) of ${typeof total === "number" ? total : "an unknown number of"} visible`;
}

function scopeFor(
  deps: MetaToolDependencies,
  outer: OuterRequest | undefined,
): CallerScope {
  return deps.scopes.resolve(outer);
}
