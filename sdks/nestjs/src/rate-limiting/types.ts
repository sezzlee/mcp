import type { OuterRequest } from "../options.js";
import type { McpToolInfo } from "../visibility/authorizer.js";

export type McpMetaTool = "search" | "load" | "invoke" | "other";

/**
 * What a rate-limit key or partition function is asked about: one `tools/call`.
 *
 * @param request the outer MCP request, absent on a transport that carries none; read the host's
 * own identity from it
 * @param target the catalog tool a `load_tool` or `invoke_tool` call names, looked up without
 * visibility; absent for other calls, and when `name` is missing, not a string or unknown
 * @param toolName the MCP tool the client called
 * @param callerScope the caller scope key the SDK's `callerScopeResolver` derives
 */
export interface McpCallContext {
  readonly request: OuterRequest | undefined;
  readonly metaTool: McpMetaTool;
  readonly target: McpToolInfo | undefined;
  readonly toolName: string;
  readonly callerScope: string;
}

export type RateLimitLease =
  | { readonly acquired: true; release(): void }
  | { readonly acquired: false; readonly retryAfterMs?: number };

/**
 * One limiter. A refusal is a lease with `acquired: false`; the SDK never waits on it beyond what
 * `acquire` itself does, and cancels a wait through `signal`.
 *
 * @param isIdle whether the limiter holds no state worth keeping; the registry evicts an idle one.
 * A limiter without it is never evicted
 * @param dispose called once when the registry evicts the limiter
 */
export interface RateLimiter {
  acquire(signal?: AbortSignal): Promise<RateLimitLease> | RateLimitLease;
  isIdle?(): boolean;
  dispose?(): void;
}

/**
 * A key and the factory of the limiter that key uses. Partitions with equal keys share one limiter
 * until it idles out.
 */
export interface RateLimitPartition {
  readonly key: string;
  create(): RateLimiter;
}

export type RateLimitClock = () => number;

export interface TokenBucketSettings {
  readonly tokenLimit: number;
  readonly tokensPerPeriod: number;
  readonly periodMs: number;
}

export interface FixedWindowSettings {
  readonly permitLimit: number;
  readonly windowMs: number;
}

export interface SlidingWindowSettings {
  readonly permitLimit: number;
  readonly windowMs: number;
  readonly segmentsPerWindow: number;
}

export interface ConcurrencySettings {
  readonly permitLimit: number;
}

export type RateLimitSettings =
  | ({ readonly kind: "tokenBucket" } & TokenBucketSettings)
  | ({ readonly kind: "fixedWindow" } & FixedWindowSettings)
  | ({ readonly kind: "slidingWindow" } & SlidingWindowSettings)
  | ({ readonly kind: "concurrency" } & ConcurrencySettings);

/**
 * Limits the SDK partitions by caller, one per meta-tool.
 *
 * @param default the limit every meta-tool without its own section shares, `other` included
 * @param search replaces `default` for `search_tools`
 * @param load replaces `default` for `load_tool`
 * @param invoke replaces `default` for `invoke_tool`
 * @param invokeConcurrency the most `invoke_tool` calls one key may have running at once
 * @param key replaces the caller scope key as the partition key; the declared limits stay
 * @param now the clock the rate-based limiters read, in epoch milliseconds
 */
export interface DeclaredRateLimits {
  readonly default?: RateLimitSettings;
  readonly search?: RateLimitSettings;
  readonly load?: RateLimitSettings;
  readonly invoke?: RateLimitSettings;
  readonly invokeConcurrency?: number;
  readonly key?: (call: McpCallContext) => string;
  readonly now?: RateLimitClock;
  readonly partition?: never;
}

/**
 * A host-owned partition function. It replaces the declared limits entirely; zero partitions means
 * the call is not limited.
 */
export interface PartitionedRateLimits {
  readonly partition: (
    call: McpCallContext,
  ) => RateLimitPartition | readonly RateLimitPartition[];
  readonly default?: never;
  readonly search?: never;
  readonly load?: never;
  readonly invoke?: never;
  readonly invokeConcurrency?: never;
  readonly key?: never;
  readonly now?: never;
}

export type SezzleeRateLimitingOptions =
  DeclaredRateLimits | PartitionedRateLimits;
