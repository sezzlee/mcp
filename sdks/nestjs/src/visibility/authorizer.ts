import type { VisibilityDecision } from "@sezzlee/core";
import type { CatalogEntry } from "../catalog.js";
import type { OuterRequest } from "../options.js";

/** The family source and the key a dispatched member is reached by. */
export interface McpFamilyMemberInfo {
  readonly source: string;
  readonly key: string | number;
}

/**
 * What an authorizer is asked about: one published tool.
 *
 * @param name the published tool name
 * @param container the controller's name
 * @param handler the controller method the tool is dispatched to; a family member shares its
 * family handler
 * @param member set only for a tool lowered from a family source
 */
export interface McpToolInfo {
  readonly name: string;
  readonly method: string;
  readonly route: string;
  readonly container: string;
  readonly handler: (...args: never[]) => unknown;
  readonly member?: McpFamilyMemberInfo;
}

/** A caller's answers, queried per tool; it has to stay cheap and synchronous. */
export interface ToolAccess {
  /** `unknown` falls through to the declarative and probe tiers. */
  decide(tool: McpToolInfo): VisibilityDecision;
}

/**
 * The host's own statement of which tools a caller may use, bound through
 * `extensionTokens.toolAuthorizer`.
 */
export interface ToolAuthorizer {
  /** Caller-independent: whether this authorizer decides the tool; the coverage check reads it. */
  covers(tool: McpToolInfo): boolean;
  /**
   * Resolves one caller's access. The result is cached per caller scope for `cache.lifetimeMs`, and
   * concurrent callers of one scope share a single resolution, so `signal` is the first caller's.
   *
   * @param request the outer MCP request, absent on a transport that carries none
   */
  resolve(
    request: OuterRequest | undefined,
    signal?: AbortSignal,
  ): Promise<ToolAccess>;
}

const infos = new WeakMap<object, McpToolInfo>();

/**
 * @returns the entry's tool info, built once per catalog build because every build creates its
 * entries anew
 */
export function toolInfoOf(entry: CatalogEntry): McpToolInfo {
  const known = infos.get(entry);
  if (known !== undefined) {
    return known;
  }
  const key = entry.family?.keys.get(entry.tool.name);
  const info: McpToolInfo = {
    name: entry.tool.name,
    method: entry.descriptor.method,
    route: entry.descriptor.route,
    container: entry.controller.name,
    handler: entry.handler,
    ...(entry.family === undefined || key === undefined
      ? {}
      : { member: { source: entry.family.source, key } }),
  };
  infos.set(entry, info);
  return info;
}
