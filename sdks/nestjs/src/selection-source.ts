import {
  canonicalJson,
  type CatalogDiagnostic,
  type SelectionDecision,
  type SeverityTable,
} from "@sezzlee/core";
import { normalizeRoute } from "./discovery/endpoint-discovery.js";
import { toolNamePattern } from "./families.js";
import {
  defaultLoadTimeoutMs,
  type Source,
  type SourceLoad,
  type SourceLoadFailure,
  type SourceLoadMode,
  type SourceLoads,
  type SourceLoadSettings,
} from "./source-loading.js";

/**
 * One endpoint's selection as a host's source returns it, for a host whose list of exposed
 * endpoints lives in data.
 *
 * The target is the upper-cased `method` and the composed `route`, compared exactly: a row names
 * one endpoint, where a glob is what `selection.rules` are for. `name`, `description`, `tags` and
 * `searchTerms` sit below the decorator's declaration and above the endpoint hook's answer.
 */
export interface McpSelectionEntry {
  readonly method: string;
  readonly route: string;
  readonly decision: SelectionDecision;
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly searchTerms?: readonly string[];
}

export type McpSelectionSource = Source<readonly McpSelectionEntry[]>;

export type SelectionLoad = SourceLoad<readonly McpSelectionEntry[]>;

export type SelectionLoads = SourceLoads<readonly McpSelectionEntry[]>;

export const selectionSourceName = "selection";

export class SelectionSourceSettings implements SourceLoadSettings {
  loadTimeoutMs = defaultLoadTimeoutMs;
  loadMode: SourceLoadMode = "blocking";
  refreshIntervalMs = 0;
  onFailure: SourceLoadFailure = "drop";
}

export const sdkSelectionSeverities = {
  selection_target_unknown: "warning",
  selection_entry_conflict: "warning",
  selection_entry_rejected: "warning",
  selection_not_loaded: "warning",
} as const satisfies SeverityTable;

export interface ProvidedSelection {
  readonly decision: SelectionDecision;
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly searchTerms?: readonly string[];
}

/**
 * @param loaded whether the source has returned at least once, which is when `targets` decides
 * @param targets the surviving rows by `METHOD /route`
 */
export interface SelectionResolution {
  readonly loaded: boolean;
  readonly targets: ReadonlyMap<string, ProvidedSelection>;
  readonly diagnostics: readonly CatalogDiagnostic[];
}

export const selectionTargetOf = (endpoint: {
  readonly method: string;
  readonly route: string;
}): string => `${endpoint.method} ${endpoint.route}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBlank = (value: unknown): boolean =>
  typeof value !== "string" || value.trim() === "";

const isDecision = (value: unknown): value is SelectionDecision =>
  value === "include" || value === "exclude";

const isToolName = (value: unknown): value is string =>
  typeof value === "string" && toolNamePattern.test(value);

const isDescription = (value: unknown): value is string => !isBlank(value);

const isVocabulary = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const sameEntries = (
  a: readonly McpSelectionEntry[],
  b: readonly McpSelectionEntry[],
): boolean => {
  const canonical = (entries: readonly McpSelectionEntry[]): string[] =>
    entries.map((entry) => canonicalJson(entry)).sort();
  const left = canonical(a);
  const right = canonical(b);
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
};

/**
 * Turns the rows a source returned into the decisions the catalog build consults.
 *
 * A defect in one row is that row's alone, like a family member: the rest stay in force. A row
 * naming no target is rejected; a row whose override is invalid keeps its decision and loses that
 * override, so a bad description can never turn an `exclude` into a fall-through; two rows for one
 * target that differ are both dropped and the endpoint is excluded, because falling through could
 * publish what a row meant to withhold, and they are data, not source code that
 * `ambiguous_selection` could send back to its author.
 *
 * @param loads the source's loads, or `undefined` before its first
 * @param known every `METHOD /route` the application discovered, to report a row naming none
 */
export function resolveSelection(
  loads: SelectionLoads | undefined,
  known: ReadonlySet<string>,
): SelectionResolution {
  const load = loads?.get(selectionSourceName);
  if (load === undefined || load.state === "failed") {
    return { loaded: false, targets: new Map(), diagnostics: [] };
  }
  const diagnostics: CatalogDiagnostic[] = [];
  const reject = (message: string): void => {
    diagnostics.push({ code: "selection_entry_rejected", message });
  };
  const kept = new Map<string, ProvidedSelection>();
  const conflicted = new Set<string>();
  load.value.forEach((raw: unknown, position) => {
    const row = parseRow(raw, position, reject);
    if (row === undefined || conflicted.has(row.target)) {
      return;
    }
    const existing = kept.get(row.target);
    if (existing === undefined) {
      kept.set(row.target, row.selection);
      return;
    }
    if (canonicalJson(existing) !== canonicalJson(row.selection)) {
      kept.set(row.target, { decision: "exclude" });
      conflicted.add(row.target);
      diagnostics.push({
        code: "selection_entry_conflict",
        message: `Selection entries for '${row.target}' disagree; both were ignored and the endpoint is excluded.`,
      });
    }
  });
  for (const target of kept.keys()) {
    if (!conflicted.has(target) && !known.has(target)) {
      kept.delete(target);
      diagnostics.push({
        code: "selection_target_unknown",
        message: `Selection entry '${target}' names no endpoint of this application; it was ignored.`,
      });
    }
  }
  return { loaded: true, targets: kept, diagnostics };
}

function parseRow(
  raw: unknown,
  position: number,
  reject: (message: string) => void,
):
  | { readonly target: string; readonly selection: ProvidedSelection }
  | undefined {
  if (!isRecord(raw)) {
    reject(`Selection entry #${position} is not an object; it was ignored.`);
    return undefined;
  }
  const { method, route, decision } = raw;
  if (isBlank(method) || isBlank(route)) {
    reject(
      `Selection entry #${position} has a blank method or route; it names no endpoint and was ignored.`,
    );
    return undefined;
  }
  const target = `${String(method).trim().toUpperCase()} ${normalizeRoute(String(route))}`;
  if (!isDecision(decision)) {
    reject(
      `Selection entry '${target}' has a decision that is neither "include" nor "exclude"; it was ignored.`,
    );
    return undefined;
  }
  const override = <T>(
    field: string,
    valid: (value: unknown) => value is T,
    expectation: string,
  ): T | undefined => {
    const value = raw[field] ?? undefined;
    if (value === undefined) {
      return undefined;
    }
    if (valid(value)) {
      return value;
    }
    reject(
      `Selection entry '${target}' ignores its ${field}: it ${expectation}.`,
    );
    return undefined;
  };
  const name = override(
    "name",
    isToolName,
    "does not match the tool-name pattern",
  );
  const description = override("description", isDescription, "is blank");
  const tags = override("tags", isVocabulary, "is not a list of strings");
  const searchTerms = override(
    "searchTerms",
    isVocabulary,
    "is not a list of strings",
  );
  return {
    target,
    selection: {
      decision,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(tags === undefined ? {} : { tags }),
      ...(searchTerms === undefined ? {} : { searchTerms }),
    },
  };
}
