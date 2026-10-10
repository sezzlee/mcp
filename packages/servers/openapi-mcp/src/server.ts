import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import {
  assertCatalogValid,
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
  type SearchRankerOptions,
  type VisibilityDecision,
} from "@sezzlee/core";
import { z } from "zod";
import type { GatewaySource } from "./catalog/build.js";
import type { GatewayCatalog } from "./catalog/build.js";
import { invokeEntry, type InvokeLimits } from "./invoke/invoke.js";
import type { BoundedFetch } from "./net/fetch.js";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

interface ToolContext {
  readonly mcpReq?: { readonly signal?: AbortSignal };
  readonly http?: {
    readonly authInfo?: { readonly extra?: Record<string, unknown> };
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
 * @param options.ranker a host ranker for `search_tools`, for an embedder; the CLI binds none
 */
export interface OpenApiMcpServerOptions {
  readonly ranker?: SearchRankerOptions;
}

export function createOpenApiMcpServer(
  gateway: GatewayCatalog,
  fetcher: BoundedFetch,
  limits: InvokeLimits,
  options: OpenApiMcpServerOptions = {},
): McpServer {
  const { catalog } = gateway;
  const budget = (): number => limits.maxResponseBytes;
  const server = new McpServer({ name: "sezzlee-openapi", version });

  server.registerTool(
    "search_tools",
    {
      description: searchDescription,
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

  server.registerTool(
    "load_tool",
    {
      description: loadDescription,
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
        assertCatalogValid(catalog.fatal);
        const entry = catalog.byName.get(name);
        const decision = entry === undefined ? "deny" : decide(entry);
        if (entry === undefined || !visible(decision)) {
          return unknownTool(name);
        }
        return textResult(createLoadedTool(entry.tool, decision), false);
      }),
  );

  server.registerTool(
    "invoke_tool",
    {
      description: invokeDescription,
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
      emitGuarded(budget, async () => {
        if (name === undefined) {
          return missingArgument("invoke_tool", "name");
        }
        if (typeof name !== "string") {
          return wrongArgumentType("invoke_tool", "name", name);
        }
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
      }),
  );

  return server;
}
