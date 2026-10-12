import { createHash } from "node:crypto";
import { hasFatal, summarize, type GatewayCatalog } from "./build.js";

export interface CatalogSnapshot {
  readonly gateway: GatewayCatalog;
  readonly generation: number;
}

/** The catalog a server reads on every call, and the changes it can follow. */
export interface CatalogState {
  current(): CatalogSnapshot;
  onChange(listener: (snapshot: CatalogSnapshot) => void): () => void;
}

/** The cache validators of the last document the source answered with. */
export interface DocumentValidators {
  readonly etag?: string;
  readonly lastModified?: string;
}

export type DocumentRead =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "document";
      readonly text: string;
      readonly validators: DocumentValidators;
    };

export type KeptReason =
  "unreadable" | "unresolvable" | "fatal" | "widens_egress";

export type ReloadOutcome =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "reloaded";
      readonly snapshot: CatalogSnapshot;
      readonly diagnostics: readonly string[];
    }
  | {
      readonly kind: "kept";
      readonly reason: KeptReason;
      readonly details: readonly string[];
    };

export interface CatalogReloader extends CatalogState {
  reload(): Promise<ReloadOutcome>;
}

export interface ReloaderOptions {
  readonly initial: GatewayCatalog;
  readonly text: string;
  readonly validators: DocumentValidators;
  readonly read: (validators: DocumentValidators) => Promise<DocumentRead>;
  readonly build: (text: string) => Promise<GatewayCatalog>;
  readonly describe: (error: unknown) => string;
}

const firstGeneration = 1;

const digestOf = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const plaintextOrigins = (gateway: GatewayCatalog): ReadonlySet<string> =>
  new Set(
    gateway.catalog.entries
      .map((entry) => new URL(entry.baseUrl))
      .filter((url) => url.protocol === "http:")
      .map((url) => url.origin),
  );

/** A catalog that never changes, for a host that builds one and serves it as it is. */
export function fixedCatalog(gateway: GatewayCatalog): CatalogState {
  const snapshot = Object.freeze({ gateway, generation: firstGeneration });
  return {
    current: () => snapshot,
    onChange: () => () => undefined,
  };
}

/**
 * Re-reads the gateway's document and swaps the catalog when it changed.
 *
 * Guard: a reload never widens egress. The hosts the first catalog may call are the ceiling for
 * every later one, and the plain-http origins it calls are the ceiling for plain http; a document
 * whose `servers` move to a host outside the first, or from https to http on a host it already
 * calls, is refused. Accepting either would send the operator's credentials wherever the
 * document's author points them, the second in clear text.
 *
 * Guard: one reload runs at a time. A trigger that arrives while one runs schedules exactly one
 * more, so a burst of triggers costs two builds, and the last document read is always the newest.
 */
export function createCatalogReloader(
  options: ReloaderOptions,
): CatalogReloader {
  const ceiling = options.initial.allowedHosts;
  const plaintextCeiling = plaintextOrigins(options.initial);
  const listeners = new Set<(snapshot: CatalogSnapshot) => void>();
  let snapshot: CatalogSnapshot = Object.freeze({
    gateway: options.initial,
    generation: firstGeneration,
  });
  let validators = options.validators;
  let active = digestOf(options.text);
  let refused: string | undefined;
  let running: Promise<ReloadOutcome> | undefined;
  let queued: Promise<ReloadOutcome> | undefined;

  const kept = (reason: KeptReason, details: readonly string[]) =>
    ({ kind: "kept", reason, details }) as const;

  async function attempt(): Promise<ReloadOutcome> {
    let read: DocumentRead;
    try {
      read = await options.read(validators);
    } catch (error) {
      return kept("unreadable", [options.describe(error)]);
    }
    if (read.kind === "unchanged") {
      return { kind: "unchanged" };
    }
    const digest = digestOf(read.text);
    if (digest === active || digest === refused) {
      validators = read.validators;
      return { kind: "unchanged" };
    }
    let candidate: GatewayCatalog;
    try {
      candidate = await options.build(read.text);
    } catch (error) {
      return kept("unresolvable", [options.describe(error)]);
    }
    validators = read.validators;
    const diagnostics = summarize(
      candidate.ingestion,
      candidate.catalog.diagnostics,
    );
    if (hasFatal(candidate)) {
      refused = digest;
      return kept("fatal", diagnostics);
    }
    const widened = [
      ...[...candidate.allowedHosts]
        .filter((host) => !ceiling.has(host))
        .map(
          (host) =>
            `the document now calls '${host}', which the running catalog does not; restart the gateway to accept it.`,
        ),
      ...[...plaintextOrigins(candidate)]
        .filter((origin) => !plaintextCeiling.has(origin))
        .map(
          (origin) =>
            `the document now calls '${origin}' over plain http, which the running catalog does not; restart the gateway to accept it.`,
        ),
    ];
    if (widened.length > 0) {
      refused = digest;
      return kept("widens_egress", widened);
    }
    snapshot = Object.freeze({
      gateway: candidate,
      generation: snapshot.generation + 1,
    });
    active = digest;
    refused = undefined;
    for (const listener of listeners) {
      listener(snapshot);
    }
    return { kind: "reloaded", snapshot, diagnostics };
  }

  function reload(): Promise<ReloadOutcome> {
    if (running === undefined) {
      running = attempt().finally(() => {
        running = undefined;
      });
      return running;
    }
    queued ??= running.then(() => {
      queued = undefined;
      return reload();
    });
    return queued;
  }

  return {
    current: () => snapshot,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload,
  };
}
