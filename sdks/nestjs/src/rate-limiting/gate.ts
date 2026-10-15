import { createPartitionRegistry } from "./partition-registry.js";
import { partitionFunctionOf } from "./declared-limits.js";
import type {
  McpCallContext,
  RateLimitLease,
  RateLimitPartition,
  SezzleeRateLimitingOptions,
} from "./types.js";

export type Admission =
  | { readonly granted: true; release(): void }
  | {
      readonly granted: false;
      readonly partition: string;
      readonly retryAfterSeconds?: number;
    };

export interface RateLimitGate {
  admit(call: McpCallContext, signal?: AbortSignal): Promise<Admission>;
}

type HeldLease = Extract<RateLimitLease, { acquired: true }>;

function partitionsOf(
  returned: RateLimitPartition | readonly RateLimitPartition[],
): readonly RateLimitPartition[] {
  return "key" in returned ? [returned] : returned;
}

function wholeSeconds(retryAfterMs: number | undefined): number | undefined {
  return retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
    ? Math.ceil(retryAfterMs / 1000)
    : undefined;
}

function releaseAll(held: readonly HeldLease[]): void {
  for (const lease of [...held].reverse()) {
    lease.release();
  }
}

/**
 * @returns the gate the options describe, or `undefined` when they limit nothing
 */
export function createRateLimitGate(
  options: SezzleeRateLimitingOptions,
): RateLimitGate | undefined {
  const partitionsFor = partitionFunctionOf(options);
  if (partitionsFor === undefined) {
    return undefined;
  }
  const registry = createPartitionRegistry(
    options.now === undefined ? {} : { now: options.now },
  );
  return {
    admit: async (call, signal) => {
      const held: HeldLease[] = [];
      try {
        for (const partition of partitionsOf(partitionsFor(call))) {
          const lease = await registry.limiterFor(partition).acquire(signal);
          if (!lease.acquired) {
            releaseAll(held);
            const retryAfterSeconds = wholeSeconds(lease.retryAfterMs);
            return {
              granted: false,
              partition: partition.key,
              ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
            };
          }
          held.push(lease);
        }
      } catch (error) {
        releaseAll(held);
        throw error;
      }
      let released = false;
      return {
        granted: true,
        release: () => {
          if (!released) {
            released = true;
            releaseAll(held);
          }
        },
      };
    },
  };
}
