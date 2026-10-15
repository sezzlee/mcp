import type {
  RateLimitClock,
  RateLimiter,
  RateLimitPartition,
} from "./types.js";

export const defaultSweepIntervalMs = 10_000;

export interface PartitionRegistryOptions {
  readonly now?: RateLimitClock;
  readonly sweepIntervalMs?: number;
}

/**
 * Keeps one limiter per partition key. A lookup sweeps at most once per `sweepIntervalMs` of the
 * clock and evicts exactly the limiters that report themselves idle, so memory follows the callers
 * active now and no timer is needed.
 */
export interface PartitionRegistry {
  limiterFor(partition: RateLimitPartition): RateLimiter;
  readonly size: number;
}

export function createPartitionRegistry(
  options: PartitionRegistryOptions = {},
): PartitionRegistry {
  const now = options.now ?? Date.now;
  const sweepIntervalMs = options.sweepIntervalMs ?? defaultSweepIntervalMs;
  const limiters = new Map<string, RateLimiter>();
  let sweptAt = now();

  /**
   * Guard: only an idle limiter is evicted. Evicting one that still holds state would reset its
   * window or bucket on the next lookup and hand the caller its permits back.
   */
  const sweep = (): void => {
    for (const [key, limiter] of limiters) {
      if (limiter.isIdle()) {
        limiters.delete(key);
        limiter.dispose?.();
      }
    }
  };

  return {
    limiterFor: (partition) => {
      const at = now();
      if (at - sweptAt >= sweepIntervalMs) {
        sweptAt = at;
        sweep();
      }
      const known = limiters.get(partition.key);
      if (known !== undefined) {
        return known;
      }
      const created = partition.create();
      limiters.set(partition.key, created);
      return created;
    },
    get size() {
      return limiters.size;
    },
  };
}
