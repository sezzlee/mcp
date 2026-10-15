import type { RateLimiter, RateLimitPartition } from "./types.js";

export const defaultSweepInterval = 256;

/**
 * Keeps one limiter per partition key. Idle limiters are evicted on access, one sweep every
 * `sweepInterval` lookups, so memory follows the callers active now and no timer is needed.
 */
export interface PartitionRegistry {
  limiterFor(partition: RateLimitPartition): RateLimiter;
  readonly size: number;
}

export function createPartitionRegistry(
  sweepInterval: number = defaultSweepInterval,
): PartitionRegistry {
  const limiters = new Map<string, RateLimiter>();
  let lookups = 0;

  const sweep = (): void => {
    for (const [key, limiter] of limiters) {
      if (limiter.isIdle?.() === true) {
        limiters.delete(key);
        limiter.dispose?.();
      }
    }
  };

  return {
    limiterFor: (partition) => {
      lookups += 1;
      if (lookups % sweepInterval === 0) {
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
