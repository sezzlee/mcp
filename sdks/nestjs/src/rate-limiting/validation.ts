import { declaresLimits } from "./declared-limits.js";
import type { RateLimitSettings, SezzleeRateLimitingOptions } from "./types.js";

const positiveInteger = (value: number): boolean =>
  Number.isInteger(value) && value >= 1;

const positiveDuration = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

function settingFailures(path: string, settings: RateLimitSettings): string[] {
  const failures: string[] = [];
  const integer = (name: string, value: number): void => {
    if (!positiveInteger(value)) {
      failures.push(`${path}.${name} must be a positive integer.`);
    }
  };
  const duration = (name: string, value: number): void => {
    if (!positiveDuration(value)) {
      failures.push(
        `${path}.${name} must be a positive number of milliseconds.`,
      );
    }
  };
  switch (settings.kind) {
    case "tokenBucket":
      integer("tokenLimit", settings.tokenLimit);
      integer("tokensPerPeriod", settings.tokensPerPeriod);
      duration("periodMs", settings.periodMs);
      break;
    case "fixedWindow":
      integer("permitLimit", settings.permitLimit);
      duration("windowMs", settings.windowMs);
      break;
    case "slidingWindow":
      integer("permitLimit", settings.permitLimit);
      duration("windowMs", settings.windowMs);
      integer("segmentsPerWindow", settings.segmentsPerWindow);
      break;
    case "concurrency":
      integer("permitLimit", settings.permitLimit);
      break;
    default: {
      const _exhaustive: never = settings;
      failures.push(
        `${path}.kind must be "tokenBucket", "fixedWindow", "slidingWindow" or "concurrency".`,
      );
    }
  }
  return failures;
}

/**
 * @returns one message per invalid rate-limiting setting, empty when none is configured or all are
 * usable
 */
export function rateLimitingFailures(
  options: SezzleeRateLimitingOptions | undefined,
): string[] {
  if (options === undefined) {
    return [];
  }
  if (options.partition !== undefined) {
    return options.default !== undefined ||
      options.search !== undefined ||
      options.load !== undefined ||
      options.invoke !== undefined ||
      options.invokeConcurrency !== undefined ||
      options.key !== undefined
      ? [
          "rateLimiting.partition replaces the declared limits (default, search, load, invoke, read, invokeConcurrency, key); set one or the other.",
        ]
      : [];
  }
  if (!declaresLimits(options)) {
    return options.key === undefined
      ? []
      : [
          "rateLimiting.key needs a declared limit (default, search, load, invoke, read or invokeConcurrency) to partition.",
        ];
  }
  const failures: string[] = [];
  for (const section of [
    "default",
    "search",
    "load",
    "invoke",
    "read",
  ] as const) {
    const settings = options[section];
    if (settings !== undefined) {
      failures.push(...settingFailures(`rateLimiting.${section}`, settings));
    }
  }
  if (
    options.invokeConcurrency !== undefined &&
    !positiveInteger(options.invokeConcurrency)
  ) {
    failures.push("rateLimiting.invokeConcurrency must be a positive integer.");
  }
  return failures;
}
