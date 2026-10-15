import { describe, expect, it } from "vitest";
import {
  createConcurrencyLimiter,
  createFixedWindowLimiter,
  createSlidingWindowLimiter,
  createTokenBucketLimiter,
} from "../src/rate-limiting/limiters.js";
import { createPartitionRegistry } from "../src/rate-limiting/partition-registry.js";
import type {
  RateLimiter,
  RateLimitLease,
} from "../src/rate-limiting/types.js";

const clockAt = (start = 0) => {
  let now = start;
  return {
    now: () => now,
    set: (at: number) => {
      now = at;
    },
  };
};

const outcome = async (
  limiter: RateLimiter,
): Promise<"granted" | number | "refused"> => {
  const lease: RateLimitLease = await limiter.acquire();
  if (lease.acquired) {
    return "granted";
  }
  return lease.retryAfterMs ?? "refused";
};

describe("token bucket", () => {
  const settings = { tokenLimit: 2, tokensPerPeriod: 1, periodMs: 1_000 };

  it("starts full, refuses when empty and says when the next token arrives", async () => {
    const clock = clockAt();
    const bucket = createTokenBucketLimiter(settings, clock.now);

    expect(await outcome(bucket)).toBe("granted");
    expect(await outcome(bucket)).toBe("granted");
    expect(await outcome(bucket)).toBe(1_000);
    clock.set(400);
    expect(await outcome(bucket)).toBe(600);
  });

  it("adds tokensPerPeriod for every whole period and never beyond the limit", async () => {
    const clock = clockAt();
    const bucket = createTokenBucketLimiter(
      { tokenLimit: 5, tokensPerPeriod: 2, periodMs: 1_000 },
      clock.now,
    );
    for (let spent = 0; spent < 5; spent += 1) {
      await bucket.acquire();
    }

    clock.set(2_500);
    expect([
      await outcome(bucket),
      await outcome(bucket),
      await outcome(bucket),
      await outcome(bucket),
      await outcome(bucket),
    ]).toEqual(["granted", "granted", "granted", "granted", 500]);

    clock.set(1_000_000);
    const results = [];
    for (let call = 0; call < 6; call += 1) {
      results.push(await outcome(bucket));
    }
    expect(results).toEqual([
      "granted",
      "granted",
      "granted",
      "granted",
      "granted",
      1_000,
    ]);
  });

  it("is idle only when refilled to the limit", async () => {
    const clock = clockAt();
    const bucket = createTokenBucketLimiter(settings, clock.now);
    expect(bucket.isIdle?.()).toBe(true);

    await bucket.acquire();
    expect(bucket.isIdle?.()).toBe(false);

    clock.set(1_000);
    expect(bucket.isIdle?.()).toBe(true);
  });
});

describe("fixed window", () => {
  const settings = { permitLimit: 2, windowMs: 1_000 };

  it("refuses past the limit until the window ends", async () => {
    const clock = clockAt();
    const window = createFixedWindowLimiter(settings, clock.now);

    expect(await outcome(window)).toBe("granted");
    clock.set(300);
    expect(await outcome(window)).toBe("granted");
    expect(await outcome(window)).toBe(700);
    clock.set(999);
    expect(await outcome(window)).toBe(1);
    clock.set(1_000);
    expect(await outcome(window)).toBe("granted");
  });

  it("keeps windows aligned to its creation after a long silence", async () => {
    const clock = clockAt();
    const window = createFixedWindowLimiter(settings, clock.now);
    await window.acquire();
    await window.acquire();

    clock.set(5_250);
    expect(await outcome(window)).toBe("granted");
    expect(await outcome(window)).toBe("granted");
    expect(await outcome(window)).toBe(750);
  });

  it("is idle once its window has ended with nothing spent in the new one", async () => {
    const clock = clockAt();
    const window = createFixedWindowLimiter(settings, clock.now);
    await window.acquire();
    expect(window.isIdle?.()).toBe(false);

    clock.set(1_000);
    expect(window.isIdle?.()).toBe(true);
  });
});

describe("sliding window", () => {
  const settings = { permitLimit: 3, windowMs: 1_000, segmentsPerWindow: 4 };

  it("frees a permit when its whole segment has left the window", async () => {
    const clock = clockAt();
    const window = createSlidingWindowLimiter(settings, clock.now);
    await window.acquire();
    await window.acquire();
    clock.set(300);
    await window.acquire();

    expect(await outcome(window)).toBe(700);
    clock.set(999);
    expect(await outcome(window)).toBe(1);
    clock.set(1_000);
    expect(await outcome(window)).toBe("granted");
    expect(await outcome(window)).toBe("granted");
    expect(await outcome(window)).toBe(250);
  });

  it("forgets everything after a silence longer than the window", async () => {
    const clock = clockAt();
    const window = createSlidingWindowLimiter(settings, clock.now);
    await window.acquire();
    await window.acquire();
    await window.acquire();
    expect(window.isIdle?.()).toBe(false);

    clock.set(60_000);
    expect(window.isIdle?.()).toBe(true);
    expect(await outcome(window)).toBe("granted");
  });
});

describe("concurrency", () => {
  it("refuses at the limit with no retry-after and frees a slot on release", async () => {
    const limiter = createConcurrencyLimiter({ permitLimit: 2 });
    const first = await limiter.acquire();
    await limiter.acquire();

    expect(await outcome(limiter)).toBe("refused");
    if (first.acquired) {
      first.release();
    }
    expect(await outcome(limiter)).toBe("granted");
  });

  it("counts a lease once however often it is released", async () => {
    const limiter = createConcurrencyLimiter({ permitLimit: 1 });
    const lease = await limiter.acquire();
    if (lease.acquired) {
      lease.release();
      lease.release();
    }

    expect(await outcome(limiter)).toBe("granted");
    expect(await outcome(limiter)).toBe("refused");
  });
});

describe("partition registry", () => {
  const limiterWith = (
    idle: () => boolean,
    dispose?: () => void,
  ): RateLimiter => ({
    acquire: () => ({ acquired: false }),
    isIdle: idle,
    ...(dispose === undefined ? {} : { dispose }),
  });

  const partitionOf = (key: string, limiter: () => RateLimiter) => {
    const created = { count: 0 };
    return {
      created,
      partition: {
        key,
        create: () => {
          created.count += 1;
          return limiter();
        },
      },
    };
  };

  it("shares one limiter among partitions with equal keys", () => {
    const registry = createPartitionRegistry();
    const { created, partition } = partitionOf("a", () =>
      createConcurrencyLimiter({ permitLimit: 1 }),
    );

    expect(registry.limiterFor(partition)).toBe(registry.limiterFor(partition));
    expect(created.count).toBe(1);
  });

  it("evicts a host limiter once it reports idle and disposes it", () => {
    const clock = clockAt();
    const registry = createPartitionRegistry({
      now: clock.now,
      sweepIntervalMs: 1_000,
    });
    const disposed: string[] = [];
    const host = partitionOf("host", () =>
      limiterWith(
        () => true,
        () => disposed.push("host"),
      ),
    );
    registry.limiterFor(host.partition);

    clock.set(1_000);
    registry.limiterFor(
      partitionOf("other", () => limiterWith(() => false)).partition,
    );

    expect(disposed).toEqual(["host"]);
    expect(registry.size).toBe(1);
    registry.limiterFor(host.partition);
    expect(host.created.count).toBe(2);
  });

  it("keeps a limiter that is not idle through a sweep", async () => {
    const clock = clockAt();
    const registry = createPartitionRegistry({
      now: clock.now,
      sweepIntervalMs: 1_000,
    });
    const busy = partitionOf("busy", () =>
      createConcurrencyLimiter({ permitLimit: 1 }),
    );
    await registry.limiterFor(busy.partition).acquire();

    clock.set(5_000);
    const kept = registry.limiterFor(busy.partition);

    expect(registry.size).toBe(1);
    expect(busy.created.count).toBe(1);
    expect(await outcome(kept)).toBe("refused");
  });

  it("sweeps at most once per interval of its clock", () => {
    const clock = clockAt();
    const registry = createPartitionRegistry({
      now: clock.now,
      sweepIntervalMs: 1_000,
    });
    let asked = 0;
    const counting = partitionOf("counting", () =>
      limiterWith(() => {
        asked += 1;
        return false;
      }),
    );
    registry.limiterFor(counting.partition);

    for (const at of [0, 400, 999]) {
      clock.set(at);
      registry.limiterFor(counting.partition);
    }
    expect(asked).toBe(0);

    clock.set(1_000);
    registry.limiterFor(counting.partition);
    registry.limiterFor(counting.partition);
    clock.set(1_999);
    registry.limiterFor(counting.partition);
    expect(asked).toBe(1);

    clock.set(2_000);
    registry.limiterFor(counting.partition);
    expect(asked).toBe(2);
  });
});
