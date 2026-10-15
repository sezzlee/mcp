import { SezzleeCatalogError } from "@sezzlee/core";

/**
 * `blocking` makes startup wait for the first load; `background` starts it and lets what the
 * source feeds join the catalog when it returns.
 */
export type SourceLoadMode = "blocking" | "background";

/**
 * `drop` keeps starting when a source never returned and drops what it feeds; `fatal` stops
 * startup instead, and requires `loadMode: "blocking"`.
 */
export type SourceLoadFailure = "drop" | "fatal";

export interface SourceLoadSettings {
  loadTimeoutMs: number;
  loadMode: SourceLoadMode;
  refreshIntervalMs: number;
  onFailure: SourceLoadFailure;
}

export const defaultLoadTimeoutMs = 10_000;

export interface SourceContext {
  readonly signal: AbortSignal;
}

export type Source<Value> = (context: SourceContext) => Promise<Value> | Value;

export type SourceLoad<Value> =
  | { readonly state: "loaded"; readonly value: Value }
  | {
      readonly state: "stale";
      readonly value: Value;
      readonly error: unknown;
    }
  | { readonly state: "failed"; readonly error: unknown };

export type SourceLoads<Value> = ReadonlyMap<string, SourceLoad<Value>>;

export const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Guard: a source that honours its signal rejects with the abort reason while the race below
 * rejects too, and which settles first is not specified. The stored error names the setting
 * either way, because "signal timed out" tells the host nothing about what to change.
 */
async function loadOne<Value>(
  name: string,
  source: Source<Value>,
  setting: string,
  timeoutMs: number,
): Promise<Value> {
  const signal = AbortSignal.timeout(timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason as Error), {
      once: true,
    });
  });
  try {
    return await Promise.race([Promise.resolve(source({ signal })), aborted]);
  } catch (error) {
    if (signal.aborted) {
      throw new Error(
        `timeout: source '${name}' did not return within ${setting}.loadTimeoutMs (${timeoutMs} ms); raise options.${setting}.loadTimeoutMs or set options.${setting}.loadMode to "background"`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Loads every source once.
 *
 * A failing source keeps what it last returned: dropping what it feeds because it was briefly
 * unreachable would take working tools offline on every transient error.
 *
 * @param setting the options path the timeout message names, such as `families`
 * @param previous the loads the current catalog was built from, or `undefined` before the first
 */
export async function loadSources<Value>(
  sources: ReadonlyMap<string, Source<Value>>,
  setting: string,
  timeoutMs: number,
  previous: SourceLoads<Value> | undefined,
): Promise<SourceLoads<Value>> {
  const entries = await Promise.all(
    [...sources].map(
      async ([name, source]): Promise<[string, SourceLoad<Value>]> => {
        try {
          const value = await loadOne(name, source, setting, timeoutMs);
          return [name, { state: "loaded", value }];
        } catch (error) {
          const last = previous?.get(name);
          return [
            name,
            last === undefined || last.state === "failed"
              ? { state: "failed", error }
              : { state: "stale", value: last.value, error },
          ];
        }
      },
    ),
  );
  return new Map(entries);
}

export const publishedOf = <Value>(
  load: SourceLoad<Value>,
): Value | undefined => (load.state === "failed" ? undefined : load.value);

/**
 * Whether any source publishes a different value than it did, where published means the value of
 * a `loaded` or `stale` source.
 */
export function loadsChanged<Value>(
  previous: SourceLoads<Value>,
  current: SourceLoads<Value>,
  same: (a: Value, b: Value) => boolean,
): boolean {
  return [...current].some(([name, load]) => {
    const before = previous.get(name);
    const prior = before === undefined ? undefined : publishedOf(before);
    const now = publishedOf(load);
    return prior === undefined || now === undefined
      ? prior !== now
      : !same(prior, now);
  });
}

/**
 * One kind of host-registered data source the catalog is built from, with the load, comparison and
 * logging the catalog drives the same way for every kind.
 *
 * @param label how the source is named in log lines, such as `family`
 * @param setting the options path of its load settings, such as `families`
 * @param subject what a rebuild after a load is said to carry, such as `family members`
 * @param noun the unit its value is counted in, and `plural` the word for a source that never returned
 * @param drops what a source that never returned costs, for its log line
 * @param failure the error a `fatal` first-load failure stops startup with
 */
export interface SourceChannelSpec<Value> {
  readonly label: string;
  readonly setting: string;
  readonly subject: string;
  readonly noun: string;
  readonly plural: string;
  readonly drops: string;
  readonly settings: SourceLoadSettings;
  readonly sources: () => ReadonlyMap<string, Source<Value>>;
  readonly size: (value: Value) => number;
  readonly same: (a: Value, b: Value) => boolean;
  readonly failure: (name: string, error: unknown) => SezzleeCatalogError;
  readonly logger: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

/**
 * A load that has run and not yet been accepted.
 *
 * @param changed whether it publishes something other than what the catalog was built from, which
 * is always so for the first load
 */
export interface PendingLoad {
  readonly changed: boolean;
  assertStartable(): void;
  accept(): void;
  stage(): () => void;
}

export interface LoadChannel {
  readonly label: string;
  readonly subject: string;
  readonly settings: SourceLoadSettings;
  readonly registered: boolean;
  load(): Promise<PendingLoad>;
}

export class SourceChannel<Value> implements LoadChannel {
  loads: SourceLoads<Value> | undefined;

  constructor(private readonly spec: SourceChannelSpec<Value>) {}

  get label(): string {
    return this.spec.label;
  }

  get subject(): string {
    return this.spec.subject;
  }

  get settings(): SourceLoadSettings {
    return this.spec.settings;
  }

  get registered(): boolean {
    return this.spec.sources().size > 0;
  }

  async load(): Promise<PendingLoad> {
    const previous = this.loads;
    const started = performance.now();
    const next = await loadSources(
      this.spec.sources(),
      this.spec.setting,
      this.spec.settings.loadTimeoutMs,
      previous,
    );
    this.report(next, Math.round(performance.now() - started));
    return {
      changed:
        previous === undefined || loadsChanged(previous, next, this.spec.same),
      assertStartable: () => {
        if (this.spec.settings.onFailure !== "fatal") {
          return;
        }
        for (const [name, load] of next) {
          if (load.state === "failed") {
            throw this.spec.failure(name, load.error);
          }
        }
      },
      accept: () => {
        this.loads = next;
      },
      stage: () => {
        const before = this.loads;
        this.loads = next;
        return () => {
          this.loads = before;
        };
      },
    };
  }

  private report(loads: SourceLoads<Value>, elapsed: number): void {
    const { label, noun, plural, drops, logger, size } = this.spec;
    for (const [name, load] of loads) {
      switch (load.state) {
        case "loaded":
          logger.log(
            `sezzlee ${label} source '${name}' returned ${size(load.value)} ${noun} in ${elapsed} ms`,
          );
          break;
        case "stale":
          logger.warn(
            `sezzlee ${label} source '${name}' failed; the ${size(load.value)} ${noun} it last returned stay published: ${reasonOf(load.error)}`,
          );
          break;
        case "failed":
          logger.error(
            `sezzlee ${label} source '${name}' failed and has never returned ${plural}; ${drops}: ${reasonOf(load.error)}`,
          );
          break;
      }
    }
  }
}
