import type { McpServer } from "@modelcontextprotocol/server";
import {
  catalogGenerationMetaKey,
  checkPinnedVersion,
  compose,
  createLoadedTool,
  emitGuarded as emitWithin,
  errorResult,
  invokeArgumentsDescription,
  invokeDescription,
  invokeVersionDescription,
  isInvokeError,
  knownFields,
  loadDescription,
  missingArgument,
  narrowingArguments,
  normalizeInvokeArguments,
  notInvocable,
  operationNameDescription,
  refuseTimedOutInvoke,
  refuseUnresolvedFile,
  resolveDeferred as resolveDeferredWith,
  searchCatalog,
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
  describeRankerEvent,
  type CallerScope,
  type MetaResponse,
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
import type { CallerVisibilityProvider } from "./visibility/provider.js";

export interface MetaToolDependencies {
  readonly catalog: SezzleeCatalog;
  readonly dispatcher: SezzleeDispatcher;
  readonly mapper: InvokeResultMapper;
  readonly visibility: CallerVisibilityProvider;
  readonly scopes: CallerScopeResolver;
  readonly options: SezzleeOptions;
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
): Promise<WireResult> {
  return emitWithin((target) => budgetFor(deps, target), produce);
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
         * instead of failing validation. Without it zod rejects the call while the .NET
         * SDK, whose `[AllowedValues]` only decorates the published schema, answers with
         * cards — two SDKs disagreeing on one argument. It does not change the published
         * schema, which still carries `enum` and `default`.
         */
        detail: z
          .enum(["card", "schema"])
          .catch("card")
          .default("card")
          .describe(searchDetailDescription),
        /**
         * Guard: `meta` publishes the `default: null` that the ASP.NET SDK emits for this argument
         * and cannot omit, because a C# array parameter's default has to be a compile-time
         * constant and `null` is the only one. Without it the two SDKs publish different schemas
         * for the same argument, which search-semantics.md makes contract. It decorates the
         * schema only; `parse` still yields `undefined` for an absent value. Pinned by T16 and by
         * test/meta-tools.spec.ts.
         */
        tags: z
          .array(z.string())
          .describe(searchTagsDescription)
          .optional()
          .meta({ default: null }),
      }),
    },
    async ({ query, limit, detail, tags }, ctx) =>
      emitGuarded(deps, async () => {
        deps.catalog.ensureValid();
        const outer = outerFrom(ctx);
        const decide = await decider(deps, outer);
        const visibility = deps.options.visibility;
        return searchCatalog({
          catalog: deps.catalog.current,
          query,
          limit,
          detail,
          tags,
          decide,
          visible: (decision) => deps.visibility.visible(decision),
          ...rankerFor(deps),
          ...deadlineFrom(ctx),
          ...(visibility.tier === "probe"
            ? {
                probe: {
                  budget: visibility.probeTopK,
                  canProbe: (entry: CatalogEntry) =>
                    deps.visibility.canProbe(entry),
                  run: (entry: CatalogEntry) =>
                    deps.visibility.probe(scopeFor(deps, outer), entry, outer),
                },
              }
            : {}),
        });
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
      emitGuarded(deps, async () => {
        if (name === undefined) {
          return missingArgument("load_tool", "name");
        }
        if (typeof name !== "string") {
          return wrongArgumentType("load_tool", "name", name);
        }
        deps.catalog.ensureValid();
        const entry = deps.catalog.find(name);
        if (entry === undefined) {
          return unknownTool(name);
        }
        const outer = outerFrom(ctx);
        const decide = await decider(deps, outer);
        let decision = decide(entry);
        if (
          decision === "unknown" &&
          deps.options.visibility.tier === "probe" &&
          deps.options.visibility.probeTopK > 0 &&
          deps.visibility.canProbe(entry)
        ) {
          decision = await deps.visibility.probe(
            scopeFor(deps, outer),
            entry,
            outer,
          );
        }
        if (!deps.visibility.visible(decision)) {
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
           * Guard: `meta` publishes the `default: null` the ASP.NET SDK emits for this optional
           * string and cannot omit, the same trap `tags` has. It binds as `unknown` so a value that
           * is not a string reaches checkPinnedVersion and leaves as an envelope. Pinned by T18 and
           * by test/meta-tools.spec.ts.
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
      emitGuarded(deps, async () => {
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
        const stale = checkPinnedVersion(entry.tool, version);
        if (stale !== undefined) {
          return stale;
        }
        if (entry.template === undefined) {
          return notInvocable(name);
        }
        const outer = outerFrom(ctx);
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
        return textResult(outcome, isInvokeError(outcome), {
          summaryOf: isInvokeError(outcome) ? outcome : outcome.body,
          narrowing: narrowingArguments(entry.tool.inputSchema),
          target,
        });
      }),
  );
}

async function decider(
  deps: MetaToolDependencies,
  outer: OuterRequest | undefined,
): Promise<(entry: CatalogEntry) => VisibilityDecision> {
  const snapshot = deps.catalog.current;
  const facts = await deps.visibility.facts(
    scopeFor(deps, outer),
    outer,
    snapshot.policyNames,
  );
  return (entry) => deps.visibility.decide(entry.descriptor.auth, facts);
}

function scopeFor(
  deps: MetaToolDependencies,
  outer: OuterRequest | undefined,
): CallerScope {
  return deps.scopes.resolve(outer);
}
