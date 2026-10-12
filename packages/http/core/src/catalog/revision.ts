import type { Revision } from "../generated/endpoint-descriptor.js";
import type { DiagnosticReporter } from "./pipeline.js";

export type RevisionLevel = keyof Revision;

export const revisionLevels = [
  "catalog",
  "container",
  "operation",
] as const satisfies readonly RevisionLevel[];

/**
 * One place a host declared a revision.
 *
 * @param value the declared value, unchecked
 * @param by the declaration as the host wrote it, named in diagnostics
 */
export interface RevisionDeclaration {
  readonly value: unknown;
  readonly by: string;
}

/** Each level's declarations, the one that wins first; an absent value declares nothing. */
export type RevisionDeclarations = Readonly<
  Partial<Record<RevisionLevel, readonly RevisionDeclaration[]>>
>;

export function isRevisionNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/**
 * Reduces a host's revision declarations to the revision a descriptor carries.
 *
 * Guard: levels never replace one another; each enters the tool version on its own, so raising a
 * container's revision still reaches an operation that declares its own. Within one level the
 * first declaration wins, and a later one is reported rather than dropped in silence: raising it
 * would change nothing, which is the failure this field exists to prevent.
 *
 * @param owner the operation's identity in diagnostics
 * @returns `undefined` when no level declares a usable revision
 */
export function declareRevision(
  owner: string,
  declarations: RevisionDeclarations,
  report: DiagnosticReporter,
): Revision | undefined {
  const revision: Revision = {};
  for (const level of revisionLevels) {
    let kept: { readonly value: number; readonly by: string } | undefined;
    for (const { value, by } of declarations[level] ?? []) {
      if (value === undefined) {
        continue;
      }
      if (!isRevisionNumber(value)) {
        report({
          code: "invalid_revision",
          message: `${owner}: ${by} declares the ${level} revision ${JSON.stringify(value) ?? String(value)}; a revision is a whole number from 1, so it was ignored.`,
        });
        continue;
      }
      if (kept !== undefined) {
        report({
          code: "revision_overridden",
          message: `${owner}: ${kept.by} sets the ${level} revision to ${String(kept.value)}, so ${by} (${String(value)}) has no effect; raising it will not change the tool version.`,
        });
        continue;
      }
      kept = { value, by };
      revision[level] = value;
    }
  }
  return Object.keys(revision).length === 0 ? undefined : revision;
}
