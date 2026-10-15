import type {
  ConcurrencySettings,
  FixedWindowSettings,
  RateLimitClock,
  RateLimiter,
  RateLimitLease,
  RateLimitSettings,
  SlidingWindowSettings,
  TokenBucketSettings,
} from "./types.js";

const wallClock: RateLimitClock = () => Date.now();

const rateLease: RateLimitLease = { acquired: true, release: () => undefined };

const refusal = (retryAfterMs: number): RateLimitLease => ({
  acquired: false,
  retryAfterMs,
});

/**
 * A bucket that holds `tokenLimit` tokens and gains `tokensPerPeriod` every `periodMs`, to the
 * limit. It starts full and refuses at once when empty.
 *
 * @param now the clock, in epoch milliseconds
 */
export function createTokenBucketLimiter(
  settings: TokenBucketSettings,
  now: RateLimitClock = wallClock,
): RateLimiter {
  const { tokenLimit, tokensPerPeriod, periodMs } = settings;
  let tokens = tokenLimit;
  let refilledAt = now();

  const refill = (at: number): void => {
    const periods = Math.floor((at - refilledAt) / periodMs);
    if (periods < 1) {
      return;
    }
    if (tokens + periods * tokensPerPeriod >= tokenLimit) {
      tokens = tokenLimit;
      refilledAt = at;
      return;
    }
    tokens += periods * tokensPerPeriod;
    refilledAt += periods * periodMs;
  };

  return {
    acquire: () => {
      const at = now();
      refill(at);
      if (tokens >= 1) {
        tokens -= 1;
        return rateLease;
      }
      return refusal(refilledAt + periodMs - at);
    },
    isIdle: () => {
      refill(now());
      return tokens === tokenLimit;
    },
  };
}

/**
 * At most `permitLimit` permits in each window of `windowMs`, the windows laid end to end from the
 * limiter's creation.
 */
export function createFixedWindowLimiter(
  settings: FixedWindowSettings,
  now: RateLimitClock = wallClock,
): RateLimiter {
  const { permitLimit, windowMs } = settings;
  let windowStart = now();
  let used = 0;

  const roll = (at: number): void => {
    const elapsed = at - windowStart;
    if (elapsed >= windowMs) {
      windowStart += Math.floor(elapsed / windowMs) * windowMs;
      used = 0;
    }
  };

  return {
    acquire: () => {
      const at = now();
      roll(at);
      if (used < permitLimit) {
        used += 1;
        return rateLease;
      }
      return refusal(windowStart + windowMs - at);
    },
    isIdle: () => {
      roll(now());
      return used === 0;
    },
  };
}

/**
 * At most `permitLimit` permits in any window of `windowMs`, counted in `segmentsPerWindow`
 * segments: a permit leaves the count when its whole segment has aged out of the window.
 */
export function createSlidingWindowLimiter(
  settings: SlidingWindowSettings,
  now: RateLimitClock = wallClock,
): RateLimiter {
  const { permitLimit, windowMs, segmentsPerWindow } = settings;
  const segmentMs = windowMs / segmentsPerWindow;
  const counts = new Array<number>(segmentsPerWindow).fill(0);
  const origin = now();
  let latest = 0;
  let total = 0;

  const countAt = (segment: number): number =>
    counts[segment % segmentsPerWindow] ?? 0;

  const advance = (at: number): void => {
    const target = Math.floor((at - origin) / segmentMs);
    if (target <= latest) {
      return;
    }
    const steps = Math.min(target - latest, segmentsPerWindow);
    for (let step = 1; step <= steps; step += 1) {
      const slot = (latest + step) % segmentsPerWindow;
      total -= counts[slot] ?? 0;
      counts[slot] = 0;
    }
    latest = target;
  };

  const retryAfterMs = (at: number): number => {
    for (let age = segmentsPerWindow - 1; age >= 0; age -= 1) {
      const segment = latest - age;
      if (segment >= 0 && countAt(segment) > 0) {
        return origin + (segment + segmentsPerWindow) * segmentMs - at;
      }
    }
    return segmentMs;
  };

  return {
    acquire: () => {
      const at = now();
      advance(at);
      if (total < permitLimit) {
        counts[latest % segmentsPerWindow] = countAt(latest) + 1;
        total += 1;
        return rateLease;
      }
      return refusal(retryAfterMs(at));
    },
    isIdle: () => {
      advance(now());
      return total === 0;
    },
  };
}

/** At most `permitLimit` leases held at once; a refusal carries no retry-after. */
export function createConcurrencyLimiter(
  settings: ConcurrencySettings,
): RateLimiter {
  let inUse = 0;
  return {
    acquire: () => {
      if (inUse >= settings.permitLimit) {
        return { acquired: false };
      }
      inUse += 1;
      let released = false;
      return {
        acquired: true,
        release: () => {
          if (!released) {
            released = true;
            inUse -= 1;
          }
        },
      };
    },
    isIdle: () => inUse === 0,
  };
}

export function createLimiter(
  settings: RateLimitSettings,
  now: RateLimitClock = wallClock,
): RateLimiter {
  switch (settings.kind) {
    case "tokenBucket":
      return createTokenBucketLimiter(settings, now);
    case "fixedWindow":
      return createFixedWindowLimiter(settings, now);
    case "slidingWindow":
      return createSlidingWindowLimiter(settings, now);
    case "concurrency":
      return createConcurrencyLimiter(settings);
    default: {
      const _exhaustive: never = settings;
      throw new TypeError("sezzlee: unknown rate limit kind.");
    }
  }
}
