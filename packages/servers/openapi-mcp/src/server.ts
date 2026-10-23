import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/server";
import {
  assertCatalogValid,
  catalogGenerationMetaKey,
  checkPinnedVersion,
  createLoadedTool,
  defaultSearchLimit,
  emitGuarded,
  evaluateVisibility,
  invokeArgumentsDescription,
  invokeDescription,
  invokeVersionDescription,
  loadDescription,
  missingArgument,
  operationNameDescription,
  readHandleDescription,
  readLimitDescription,
  readOffsetDescription,
  readPathDescription,
  readResultDescription,
  readSelectDescription,
  readStoredResult,
  searchCatalog,
  searchDescription,
  searchDetailDescription,
  searchLimitDescription,
  searchQueryDescription,
  searchTagsDescription,
  textResult,
  unknownTool,
  wrongArgumentType,
  type CatalogEntry,
  type ResultShelf,
  type ResultStore,
  type SearchRankerOptions,
  type VisibilityDecision,
} from "@sezzlee/core";
import { z } from "zod";
import type { GatewaySource } from "./catalog/build.js";
import type { GatewayCatalog } from "./catalog/build.js";
import { fixedCatalog, type CatalogState } from "./catalog/reload.js";
import { invokeEntry, type InvokeLimits } from "./invoke/invoke.js";
import type { BoundedFetch } from "./net/fetch.js";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

interface ToolContext {
  readonly mcpReq?: { readonly signal?: AbortSignal };
  readonly http?: {
    readonly authInfo?: {
      readonly token?: string;
      readonly extra?: Record<string, unknown>;
    };
  };
}

/** Where the http transport's auth gate leaves the token the caller's own was exchanged for. */
export const exchangedTokenKey = "sezzleeExchangedToken";

/**
 * Guard: `name` binds as `unknown` so a call that misspells the argument reaches the handler and
 * leaves as an sezzlee envelope; a `z.string()` would be rejected by the framework's validator with
 * a bare text error the agent cannot parse. The published schema is byte-identical to the SDKs'.
 */
function namedArgument(description: string) {
  return z.unknown().optional().meta({ type: "string", description });
}

/**
 * A document says which credential a call needs, never which caller may make it, so a caller is
 * always of unknown identity here and only an explicitly anonymous operation is certain.
 */
function decide(entry: CatalogEntry<GatewaySource>): VisibilityDecision {
  return evaluateVisibility(entry.descriptor.auth, { identity: "unknown" });
}

const visible = (decision: VisibilityDecision): boolean => decision !== "deny";

/**
 * Guard: a stored result is the caller's own, so it is kept under a digest of the token the caller
 * authenticated with. Without a bearer gate the server admits only loopback callers, which share
 * one partition. The token itself is never stored.
 */
function partitionOf(context: ToolContext | undefined): string {
  const token = context?.http?.authInfo?.token;
  return token === undefined
    ? ""
    : createHash("sha256").update(token).digest("hex");
}

/**
 * @param options.ranker a host ranker for `search_tools`, for an embedder; the CLI binds none
 * @param options.announce re-stamp the catalog generation and send `tools/list_changed` from this
 * instance whenever the state changes; for one instance that outlives a reload, as on stdio. The
 * subscription lasts as long as the state does
 * @param options.results where an over-budget `invoke_tool` success is kept for `read_result`; it
 * has to outlive the server, which the http transport builds per request
 * @param options.reportStoreFailure receives a store failure, answered as `response_too_large`
 */
export interface OpenApiMcpServerOptions {
  readonly ranker?: SearchRankerOptions;
  readonly announce?: boolean;
  readonly results?: ResultStore;
  readonly reportStoreFailure?: (error: unknown) => void;
}

/**
 * @param gateway a built catalog, or a state whose current catalog every call reads
 */
export function createOpenApiMcpServer(
  gateway: GatewayCatalog | CatalogState,
  fetcher: BoundedFetch,
  limits: InvokeLimits,
  options: OpenApiMcpServerOptions = {},
): McpServer {
  const state = "current" in gateway ? gateway : fixedCatalog(gateway);
  const catalogNow = () => state.current().gateway.catalog;
  const generationMeta = (): Record<string, unknown> => ({
    [catalogGenerationMetaKey]: state.current().generation,
  });
  const budget = (): number => limits.maxResponseBytes;
  const server = new McpServer({ name: "sezzlee-openapi", version });

  const search = server.registerTool(
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
        detail: z
          .enum(["card", "schema"])
          .catch("card")
          .default("card")
          .describe(searchDetailDescription),
        tags: z
          .array(z.string())
          .describe(searchTagsDescription)
          .optional()
          .meta({ default: null }),
      }),
    },
    async ({ query, limit, detail, tags }, ctx) =>
      emitGuarded(budget, async () => {
        const catalog = catalogNow();
        assertCatalogValid(catalog.fatal);
        const signal = (ctx as ToolContext | undefined)?.mcpReq?.signal;
        return searchCatalog({
          catalog,
          query,
          limit,
          detail,
          tags,
          decide,
          visible,
          ...(options.ranker === undefined ? {} : { ranker: options.ranker }),
          ...(signal === undefined ? {} : { signal }),
        });
      }),
  );

  const load = server.registerTool(
    "load_tool",
    {
      description: loadDescription,
      _meta: generationMeta(),
      inputSchema: z
        .object({ name: namedArgument(operationNameDescription) })
        .meta({ required: ["name"] }),
    },
    async ({ name }) =>
      emitGuarded(budget, async () => {
        if (name === undefined) {
          return missingArgument("load_tool", "name");
        }
        if (typeof name !== "string") {
          return wrongArgumentType("load_tool", "name", name);
        }
        const catalog = catalogNow();
        assertCatalogValid(catalog.fatal);
        const entry = catalog.byName.get(name);
        const decision = entry === undefined ? "deny" : decide(entry);
        if (entry === undefined || !visible(decision)) {
          return unknownTool(name);
        }
        return textResult(createLoadedTool(entry.tool, decision), false);
      }),
  );

  const invoke = server.registerTool(
    "invoke_tool",
    {
      description: invokeDescription,
      _meta: generationMeta(),
      inputSchema: z
        .object({
          name: namedArgument(operationNameDescription),
          arguments: z
            .unknown()
            .optional()
            .meta({ description: invokeArgumentsDescription }),
          version: z.unknown().optional().meta({
            type: "string",
            description: invokeVersionDescription,
            default: null,
          }),
        })
        .meta({ required: ["name", "arguments"] }),
    },
    async ({ name, arguments: args, version: pinned }, ctx) =>
      emitGuarded(
        budget,
        async () => {
          if (name === undefined) {
            return missingArgument("invoke_tool", "name");
          }
          if (typeof name !== "string") {
            return wrongArgumentType("invoke_tool", "name", name);
          }
          const catalog = catalogNow();
          assertCatalogValid(catalog.fatal);
          const entry = catalog.byName.get(name);
          if (entry === undefined) {
            return unknownTool(name);
          }
          const stale = checkPinnedVersion(entry.tool, pinned);
          if (stale !== undefined) {
            return stale;
          }
          const context = ctx as ToolContext | undefined;
          const exchanged = context?.http?.authInfo?.extra?.[exchangedTokenKey];
          return invokeEntry(
            entry,
            args,
            fetcher,
            limits,
            context?.mcpReq?.signal,
            typeof exchanged === "string" ? exchanged : undefined,
          );
        },
        shelfOf(ctx as ToolContext | undefined),
      ),
  );

  const tools = [search, load, invoke];
  const store = options.results;
  if (store !== undefined) {
    tools.push(
      server.registerTool(
        "read_result",
        {
          description: readResultDescription,
          _meta: generationMeta(),
          annotations: { readOnlyHint: true },
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
          emitGuarded(budget, () =>
            readStoredResult(
              { handle, path, select, offset, limit },
              { store, partition: partitionOf(ctx as ToolContext | undefined) },
              async (tool) => {
                const catalog = catalogNow();
                assertCatalogValid(catalog.fatal);
                const entry = catalog.byName.get(tool);
                return entry !== undefined && visible(decide(entry));
              },
            ),
          ),
      ),
    );
  }

  function shelfOf(context: ToolContext | undefined): ResultShelf | undefined {
    return store === undefined
      ? undefined
      : {
          store,
          partition: partitionOf(context),
          ...(options.reportStoreFailure === undefined
            ? {}
            : { report: options.reportStoreFailure }),
        };
  }

  if (options.announce === true) {
    announceChanges(server, state, tools, generationMeta);
  }
  return server;
}

/**
 * Guard: the stamps are assigned and one notification is sent, rather than calling each tool's
 * `update`, because `update` sends its own `tools/list_changed` and a reload would announce itself
 * once per meta-tool.
 */
function announceChanges(
  server: McpServer,
  state: CatalogState,
  tools: readonly RegisteredTool[],
  generationMeta: () => Record<string, unknown>,
): void {
  state.onChange(() => {
    const meta = generationMeta();
    for (const tool of tools) {
      tool._meta = meta;
    }
    server.sendToolListChanged();
  });
}
