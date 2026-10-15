import { createConcurrencyLimiter, createLimiter } from "./limiters.js";
import type {
  DeclaredRateLimits,
  McpCallContext,
  RateLimitPartition,
  SezzleeRateLimitingOptions,
} from "./types.js";

export function declaresLimits(limits: DeclaredRateLimits): boolean {
  return (
    limits.default !== undefined ||
    limits.search !== undefined ||
    limits.load !== undefined ||
    limits.invoke !== undefined ||
    limits.invokeConcurrency !== undefined
  );
}

/**
 * Lowers declared limits to the partition function a host could have written: a meta-tool with its
 * own section gets its own bucket, the rest share one under `default:`, and `invoke` may chain a
 * concurrency limiter behind its rate limit.
 */
export function declaredPartitions(
  limits: DeclaredRateLimits,
): (call: McpCallContext) => readonly RateLimitPartition[] {
  const now = limits.now;
  return (call) => {
    const base = limits.key?.(call) ?? call.callerScope;
    const partitions: RateLimitPartition[] = [];
    const own = call.metaTool === "other" ? undefined : limits[call.metaTool];
    const settings = own ?? limits.default;
    if (settings !== undefined) {
      partitions.push({
        key: `${own === undefined ? "default" : call.metaTool}:${base}`,
        create: () => createLimiter(settings, now),
      });
    }
    if (call.metaTool === "invoke" && limits.invokeConcurrency !== undefined) {
      const permitLimit = limits.invokeConcurrency;
      partitions.push({
        key: `invoke-concurrency:${base}`,
        create: () => createConcurrencyLimiter({ permitLimit }),
      });
    }
    return partitions;
  };
}

export function partitionFunctionOf(
  options: SezzleeRateLimitingOptions,
):
  | ((
      call: McpCallContext,
    ) => RateLimitPartition | readonly RateLimitPartition[])
  | undefined {
  if (options.partition !== undefined) {
    return options.partition;
  }
  return declaresLimits(options) ? declaredPartitions(options) : undefined;
}
