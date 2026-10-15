import { Logger } from "@nestjs/common";
import {
  evaluateVisibility,
  SingleFlight,
  type CacheKey,
  type CallerFacts,
  type CallerScope,
  type SezzleeCache,
  type VisibilityDecision,
} from "@sezzlee/core";
import type { CatalogEntry } from "../catalog.js";
import type { OuterRequest, SezzleeOptions } from "../options.js";
import type { ProbeEvaluator } from "./probe.js";
import type { VisibilityEvaluator } from "./evaluator.js";
import {
  toolInfoOf,
  type ToolAccess,
  type ToolAuthorizer,
} from "./authorizer.js";

interface HeldAccess {
  readonly access: ToolAccess;
  readonly expiresAt: number;
}

export class CallerVisibilityProvider {
  private readonly logger = new Logger(CallerVisibilityProvider.name);
  private readonly factsFlight = new SingleFlight<string, CallerFacts>();
  private readonly probeFlight = new SingleFlight<string, VisibilityDecision>();
  private readonly accessFlight = new SingleFlight<string, ToolAccess>();
  private readonly accesses = new Map<string, HeldAccess>();
  private epoch = 0;
  private accessEpoch = 0;

  constructor(
    private readonly evaluator: VisibilityEvaluator,
    private readonly prober: ProbeEvaluator,
    private readonly cache: SezzleeCache,
    private readonly options: SezzleeOptions,
    private readonly authorizer: ToolAuthorizer | null = null,
  ) {}

  get hasAuthorizer(): boolean {
    return this.authorizer !== null;
  }

  bump(): void {
    this.epoch += 1;
  }

  /**
   * Forgets the resolved authorizer access of one caller scope, or of every scope.
   *
   * @param scope the scope to forget; omitted, all of them
   */
  invalidateAccess(scope?: CallerScope): void {
    this.accessEpoch += 1;
    if (scope === undefined) {
      this.accesses.clear();
    } else {
      this.accesses.delete(String(scope.key));
    }
  }

  /**
   * Guard: an access is an object the host built from its own data, so it is held here in process
   * memory for `cache.lifetimeMs` and never written to the shared `SezzleeCache`, which stores
   * strings. A resolution that was invalidated while it ran is returned but not kept; without that
   * a permission change racing a slow resolve would pin the old answer for a whole lifetime.
   *
   * @returns the caller's access, or `undefined` when no authorizer is bound
   */
  async access(
    scope: CallerScope,
    outer: OuterRequest | undefined,
    signal?: AbortSignal,
  ): Promise<ToolAccess | undefined> {
    const authorizer = this.authorizer;
    if (authorizer === null) {
      return undefined;
    }
    const started = performance.now();
    const { lifetimeMs, maxCallers } = this.options.cache;
    if (lifetimeMs <= 0) {
      const access = await authorizer.resolve(outer, signal);
      this.logResolution(started, "uncached");
      return access;
    }
    const key = String(scope.key);
    const held = this.accesses.get(key);
    if (held !== undefined && held.expiresAt > Date.now()) {
      this.logResolution(started, "hit");
      return held.access;
    }
    const observed = this.accessEpoch;
    const access = await this.accessFlight.run(key, () =>
      authorizer.resolve(outer, signal),
    );
    if (observed === this.accessEpoch) {
      this.accesses.delete(key);
      this.evictAccesses(maxCallers - 1);
      this.accesses.set(key, { access, expiresAt: Date.now() + lifetimeMs });
    }
    this.logResolution(started, "miss");
    return access;
  }

  private evictAccesses(room: number): void {
    const now = Date.now();
    for (const [key, held] of this.accesses) {
      if (held.expiresAt <= now) {
        this.accesses.delete(key);
      }
    }
    for (const key of this.accesses.keys()) {
      if (this.accesses.size <= room) {
        return;
      }
      this.accesses.delete(key);
    }
  }

  private logResolution(started: number, outcome: string): void {
    this.logger.debug(
      `authorizer access resolved in ${Math.round(performance.now() - started)} ms (${outcome})`,
    );
  }

  canProbe(entry: CatalogEntry): boolean {
    return this.prober.canProbe(entry);
  }

  async facts(
    scope: CallerScope,
    outer: OuterRequest | undefined,
    policyNames: ReadonlySet<string>,
  ): Promise<CallerFacts> {
    if (this.options.cache.lifetimeMs <= 0) {
      return this.evaluator.resolve(outer, policyNames);
    }
    const key: CacheKey = { scope, kind: "facts" };
    const observed = this.epoch;
    const cached = await this.read(key);
    if (cached !== undefined) {
      return decodeFacts(cached);
    }
    const resolved = await this.factsFlight.run(String(scope.key), () =>
      this.evaluator.resolve(outer, policyNames),
    );
    if (observed === this.epoch) {
      await this.write(key, encodeFacts(resolved));
    }
    return resolved;
  }

  /**
   * @returns the verdict an earlier probe left in the shared cache for this scope and tool, or
   * `undefined` when there is none
   */
  async cachedProbe(
    scope: CallerScope,
    entry: CatalogEntry,
  ): Promise<VisibilityDecision | undefined> {
    if (this.options.cache.lifetimeMs <= 0) {
      return undefined;
    }
    const cached = await this.read({
      scope,
      kind: "probe",
      subkey: entry.tool.name,
    });
    return cached === "A" ? "allow" : cached === "D" ? "deny" : undefined;
  }

  async probe(
    scope: CallerScope,
    entry: CatalogEntry,
    outer: OuterRequest | undefined,
    signal?: AbortSignal,
  ): Promise<VisibilityDecision> {
    const key: CacheKey = { scope, kind: "probe", subkey: entry.tool.name };
    if (this.options.cache.lifetimeMs <= 0) {
      return this.prober.probe(entry, outer, signal);
    }
    const observed = this.epoch;
    const cached = await this.cachedProbe(scope, entry);
    if (cached !== undefined) {
      return cached;
    }
    const decision = await this.probeFlight.run(
      `${scope.key}:${entry.tool.name}`,
      () => this.prober.probe(entry, outer, signal),
    );
    if (decision !== "unknown" && observed === this.epoch) {
      await this.write(key, decision === "allow" ? "A" : "D");
    }
    return decision;
  }

  decide(
    auth: CatalogEntry["descriptor"]["auth"],
    facts: CallerFacts,
  ): VisibilityDecision {
    return evaluateVisibility(auth, facts);
  }

  /**
   * Guard: the one place that orders the cheap tiers, shared by `search_tools`, `load_tool` and the
   * test audit, so an audit cannot drift from what the tools show. An authorizer's `allow` or
   * `deny` is final; `unknown` falls through to the declarative tier.
   */
  decideFor(
    entry: CatalogEntry,
    facts: CallerFacts,
    access: ToolAccess | undefined,
  ): VisibilityDecision {
    const own = access?.decide(toolInfoOf(entry));
    return own === "allow" || own === "deny"
      ? own
      : this.decide(entry.descriptor.auth, facts);
  }

  visible(decision: VisibilityDecision): boolean {
    if (decision === "allow") {
      return true;
    }
    if (decision === "deny") {
      return false;
    }
    const onUnknown =
      this.options.visibility.onUnknown ??
      (this.authorizer === null ? "show" : "hide");
    return onUnknown === "show";
  }

  private async read(key: CacheKey): Promise<string | undefined> {
    try {
      return await this.cache.get(key);
    } catch {
      return undefined;
    }
  }

  private async write(key: CacheKey, value: string): Promise<void> {
    try {
      await this.cache.set(key, value);
    } catch {
      return;
    }
  }
}

function encodeFacts(facts: CallerFacts): string {
  const identity =
    facts.identity === "present"
      ? "P"
      : facts.identity === "absent"
        ? "A"
        : "U";
  const results = Object.entries(facts.policyResults ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, decision]) => `${name}=${decision.charAt(0).toUpperCase()}`)
    .join(";");
  return `${identity}|${results}`;
}

function decodeFacts(encoded: string): CallerFacts {
  const [identityCode, results = ""] = encoded.split("|");
  const identity =
    identityCode === "P"
      ? "present"
      : identityCode === "A"
        ? "absent"
        : "unknown";
  const policyResults: Record<string, VisibilityDecision> = {};
  for (const pair of results.split(";")) {
    if (pair.length === 0) {
      continue;
    }
    const [name, code] = pair.split("=");
    if (name === undefined || code === undefined) {
      continue;
    }
    policyResults[name] =
      code === "A" ? "allow" : code === "D" ? "deny" : "unknown";
  }
  return { identity, policyResults };
}
