import type { SezzleeOptions } from "./options.js";

export class SezzleeConfigurationError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`sezzlee: invalid configuration.\n  ${failures.join("\n  ")}`);
    this.name = "SezzleeConfigurationError";
  }
}

/**
 * Mirrors the ASP.NET `SezzleeOptionsValidator` so the two surfaces can be audited side by side.
 *
 * @param options the configured options
 * @returns one message per invalid setting, empty when the configuration is usable
 */
export function collectConfigurationFailures(
  options: SezzleeOptions,
): readonly string[] {
  const failures: string[] = [];
  if (options.cache.lifetimeMs < 0) {
    failures.push("cache.lifetimeMs must be zero or positive.");
  }
  if (options.cache.maxCallers < 1) {
    failures.push("cache.maxCallers must be at least 1.");
  }
  if (options.visibility.probeTopK < 0) {
    failures.push("visibility.probeTopK must be zero or positive.");
  }
  if (options.visibility.probeConcurrency < 1) {
    failures.push("visibility.probeConcurrency must be at least 1.");
  }
  if (options.invoke.maxResponseBytes < 1) {
    failures.push("invoke.maxResponseBytes must be at least 1.");
  }
  if (options.invoke.timeoutMs < 0) {
    failures.push("invoke.timeoutMs must be zero or positive.");
  }
  if (options.invoke.maxInlineFileBytes < 0) {
    failures.push("invoke.maxInlineFileBytes must be zero or positive.");
  }
  if (options.invoke.maxFileBytes < 1) {
    failures.push("invoke.maxFileBytes must be at least 1.");
  }
  if (
    !Number.isInteger(options.search.rankerTimeoutMs) ||
    options.search.rankerTimeoutMs < 0
  ) {
    failures.push("search.rankerTimeoutMs must be zero or a positive integer.");
  }
  if (!["fallback", "error"].includes(options.search.onRankerFailure)) {
    failures.push('search.onRankerFailure must be "fallback" or "error".');
  }
  if (
    !Number.isInteger(options.families.loadTimeoutMs) ||
    options.families.loadTimeoutMs < 1
  ) {
    failures.push("families.loadTimeoutMs must be a positive integer.");
  }
  const { loadMode, onFailure, refreshIntervalMs } = options.families;
  if (!Number.isInteger(refreshIntervalMs) || refreshIntervalMs < 0) {
    failures.push(
      "families.refreshIntervalMs must be zero or a positive integer.",
    );
  }
  if (!["blocking", "background"].includes(loadMode)) {
    failures.push('families.loadMode must be "blocking" or "background".');
  }
  if (!["drop", "fatal"].includes(onFailure)) {
    failures.push('families.onFailure must be "drop" or "fatal".');
  }
  if (onFailure === "fatal" && loadMode === "background") {
    failures.push(
      'families.onFailure "fatal" requires families.loadMode "blocking": a background load ends after startup, when there is nothing left to stop.',
    );
  }
  const refDescription = options.files.resolver?.refDescription;
  if (refDescription !== undefined && refDescription.trim() === "") {
    failures.push(
      "files.resolver.refDescription must say what a ref is; an agent reads it to find one.",
    );
  }
  /**
   * A blank field is not the catch-all: the catch-all omits the field, while `route: ""` matches
   * only the empty string and no composed route is empty, so the rule would decide nothing.
   */
  (options.selection.rules ?? []).forEach((rule, position) => {
    for (const field of ["route", "method"] as const) {
      const value = rule[field];
      if (value !== undefined && value.trim() === "") {
        failures.push(
          `selection.rules[${position}].${field} must not be blank; omit it to match every ${field}.`,
        );
      }
    }
  });
  return failures;
}

/**
 * @param options the configured options
 * @throws SezzleeConfigurationError when any setting is unusable
 */
export function validateSezzleeOptions(options: SezzleeOptions): void {
  const failures = collectConfigurationFailures(options);
  if (failures.length > 0) {
    throw new SezzleeConfigurationError(failures);
  }
}
