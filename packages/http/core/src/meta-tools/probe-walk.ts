import type { CatalogEntry } from "../catalog/pipeline.js";
import type { VisibilityDecision } from "../visibility.js";

/**
 * How `search_tools` resolves a decision the cheaper tiers left `unknown`.
 *
 * @param maxProbes the most probe requests one search sends; a verdict `cached` answers does not
 * count
 * @param concurrency how many probes run at once; at least 1
 * @param canProbe whether the tool can be probed at all
 * @param cached the verdict an earlier search left, if any; asked before a probe is sent, and a
 * verdict it answers does not count against `maxProbes`
 * @param run sends one probe; it must not reject, an answer it cannot give is `unknown`
 * @param capReached called once, when a tool was left unprobed because of `maxProbes`
 */
export interface ProbeOptions<Source extends object> {
  readonly maxProbes: number;
  readonly concurrency: number;
  canProbe(entry: CatalogEntry<Source>): boolean;
  cached?(entry: CatalogEntry<Source>): Promise<VisibilityDecision | undefined>;
  run(entry: CatalogEntry<Source>): Promise<VisibilityDecision>;
  capReached?(): void;
}

/**
 * Walks the ranked candidates in order and resolves each unknown one when the page reaches it,
 * keeping up to `concurrency` probes in flight for the entries just ahead. Entries ahead are asked
 * for only while the page could still need them, so a full page stops new probes. The few still in
 * flight when it fills are not awaited: they finish on their own and the next search finds their
 * verdicts cached.
 */
export class ProbeWalk<Source extends object> {
  private readonly verdicts = new Map<
    CatalogEntry<Source>,
    VisibilityDecision
  >();
  private readonly inFlight = new Map<
    CatalogEntry<Source>,
    Promise<VisibilityDecision>
  >();
  private sent = 0;
  private readonly unprobed = new Set<CatalogEntry<Source>>();
  private reported = false;

  constructor(
    private readonly probe: ProbeOptions<Source> | undefined,
    private readonly candidates: readonly CatalogEntry<Source>[],
    private readonly decisions: ReadonlyMap<
      CatalogEntry<Source>,
      VisibilityDecision
    >,
    private readonly visible: (decision: VisibilityDecision) => boolean,
    private readonly pageSize: number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /**
   * @param index the candidate being decided
   * @param collected how many results the page already holds
   */
  async decisionAt(
    index: number,
    collected: number,
  ): Promise<VisibilityDecision> {
    const entry = this.candidates[index] as CatalogEntry<Source>;
    const cheap = this.decisions.get(entry) ?? "unknown";
    const probe = this.probe;
    if (cheap !== "unknown" || probe === undefined || !probe.canProbe(entry)) {
      return cheap;
    }
    this.prefetch(probe, index, collected);
    const decision =
      (await this.inFlight.get(entry)) ?? this.verdicts.get(entry);
    if (this.unprobed.has(entry) && !this.reported) {
      this.reported = true;
      probe.capReached?.();
    }
    return decision ?? "unknown";
  }

  private prefetch(
    probe: ProbeOptions<Source>,
    index: number,
    collected: number,
  ): void {
    if (this.signal?.aborted === true) {
      return;
    }
    let potential = collected;
    for (
      let ahead = index;
      ahead < this.candidates.length && potential < this.pageSize;
      ahead += 1
    ) {
      const entry = this.candidates[ahead] as CatalogEntry<Source>;
      const cheap = this.decisions.get(entry) ?? "unknown";
      if (cheap !== "unknown" || !probe.canProbe(entry)) {
        potential += this.visible(cheap) ? 1 : 0;
        continue;
      }
      const settled = this.verdicts.get(entry);
      if (settled !== undefined) {
        potential += this.visible(settled) ? 1 : 0;
        continue;
      }
      if (this.inFlight.has(entry)) {
        potential += 1;
        continue;
      }
      if (this.inFlight.size >= probe.concurrency) {
        return;
      }
      this.send(probe, entry);
      potential += 1;
    }
  }

  private send(probe: ProbeOptions<Source>, entry: CatalogEntry<Source>): void {
    const running = this.resolve(probe, entry).catch(() => "unknown" as const);
    this.inFlight.set(entry, running);
    void running.then((decision) => {
      this.verdicts.set(entry, decision);
      this.inFlight.delete(entry);
    });
  }

  private async resolve(
    probe: ProbeOptions<Source>,
    entry: CatalogEntry<Source>,
  ): Promise<VisibilityDecision> {
    const cached = await probe.cached?.(entry);
    if (cached !== undefined) {
      return cached;
    }
    if (this.sent >= probe.maxProbes) {
      this.unprobed.add(entry);
      return "unknown";
    }
    this.sent += 1;
    return probe.run(entry);
  }
}
