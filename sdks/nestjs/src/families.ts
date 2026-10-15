import {
  declaredSchemaProblem,
  type CatalogDiagnostic,
  type JsonSchemaObject,
  type SeverityTable,
  type ToolFamily,
  type ToolVariant,
} from "@sezzlee/core";
import type { McpToolEffect, McpVariantOptions } from "./decorators.js";

/**
 * A member's request body: a JSON Schema the host wrote, or a DTO class the SDK maps the way it
 * maps an `@Body()` parameter, through `options.schema`. Exactly one is set.
 */
export type McpFamilyMemberBody =
  | { readonly body: JsonSchemaObject; readonly bodyType?: never }
  | { readonly bodyType: NewableFunction; readonly body?: never };

/**
 * One capability behind a dispatching operation, as a host's member source returns it.
 *
 * @param key the value written into the dispatch parameter; it never reaches the agent
 * @param body the member's own request body, published as its input schema
 * @param bodyType a DTO class published as the input schema in place of `body`
 */
export type McpFamilyMember = {
  readonly key: string | number;
  readonly name: string;
  readonly description: string;
  readonly bodyRequired?: boolean;
} & McpFamilyMemberBody &
  McpToolEffect;

export type McpFamilySource = (context: {
  readonly signal: AbortSignal;
}) => Promise<readonly McpFamilyMember[]> | readonly McpFamilyMember[];

export type FamilyLoad =
  | { readonly state: "loaded"; readonly members: readonly McpFamilyMember[] }
  | {
      readonly state: "stale";
      readonly members: readonly McpFamilyMember[];
      readonly error: unknown;
    }
  | { readonly state: "failed"; readonly error: unknown };

export type FamilyLoads = ReadonlyMap<string, FamilyLoad>;

/**
 * `blocking` makes startup wait for the first load; `background` starts it and lets family
 * operations join the catalog when their source returns.
 */
export type FamilyLoadMode = "blocking" | "background";

/**
 * `drop` keeps starting when a source never returned and drops the families it feeds; `fatal`
 * stops startup instead, and requires `loadMode: "blocking"`.
 */
export type FamilyLoadFailure = "drop" | "fatal";

export class ToolFamilyOptions {
  private readonly registered = new Map<string, McpFamilySource>();
  loadTimeoutMs = 10_000;
  loadMode: FamilyLoadMode = "blocking";
  /**
   * How often sources are loaded again after the first load, in whole milliseconds. Zero loads
   * them once. A refresh whose members equal the published ones changes nothing.
   */
  refreshIntervalMs = 0;
  onFailure: FamilyLoadFailure = "drop";

  get sources(): ReadonlyMap<string, McpFamilySource> {
    return this.registered;
  }

  provide(name: string, source: McpFamilySource): this {
    this.registered.set(name, source);
    return this;
  }
}

/**
 * Guard: a source that honours its signal rejects with the abort reason while the race below
 * rejects too, and which settles first is not specified. The stored error names the setting
 * either way, because "signal timed out" tells the host nothing about what to change.
 */
async function loadOne(
  name: string,
  source: McpFamilySource,
  timeoutMs: number,
): Promise<readonly McpFamilyMember[]> {
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
        `timeout: source '${name}' did not return within families.loadTimeoutMs (${timeoutMs} ms); raise options.families.loadTimeoutMs or set options.families.loadMode to "background"`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Loads every registered source once.
 *
 * A failing source keeps the members it last returned: dropping a family because its source was
 * briefly unreachable would take working tools offline on every transient error.
 *
 * @param previous the loads the current catalog was built from, or `undefined` before the first
 */
export async function loadFamilies(
  options: ToolFamilyOptions,
  previous: FamilyLoads | undefined,
): Promise<FamilyLoads> {
  const entries = await Promise.all(
    [...options.sources].map(
      async ([name, source]): Promise<[string, FamilyLoad]> => {
        try {
          const members = await loadOne(name, source, options.loadTimeoutMs);
          return [name, { state: "loaded", members }];
        } catch (error) {
          const last = previous?.get(name);
          return [
            name,
            last === undefined || last.state === "failed"
              ? { state: "failed", error }
              : { state: "stale", members: last.members, error },
          ];
        }
      },
    ),
  );
  return new Map(entries);
}

const publishedOf = (
  load: FamilyLoad,
): readonly McpFamilyMember[] | undefined =>
  load.state === "failed" ? undefined : load.members;

function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(b)
  ) {
    const entries = Object.entries(a);
    return (
      entries.length === Object.keys(b).length &&
      entries.every(
        ([key, value]) =>
          Object.hasOwn(b, key) && jsonEqual(value, Reflect.get(b, key)),
      )
    );
  }
  return false;
}

function sameMember(a: McpFamilyMember, b: McpFamilyMember): boolean {
  return (
    a.key === b.key &&
    a.name === b.name &&
    a.description === b.description &&
    a.bodyRequired === b.bodyRequired &&
    a.readOnly === b.readOnly &&
    a.destructive === b.destructive &&
    a.idempotent === b.idempotent &&
    a.bodyType === b.bodyType &&
    jsonEqual(a.body, b.body)
  );
}

/**
 * Whether any source publishes different members than it did, where published means the members
 * of a `loaded` or `stale` source. A body given as a class compares by identity, a JSON Schema by
 * structure.
 */
export function membersChanged(
  previous: FamilyLoads,
  current: FamilyLoads,
): boolean {
  return [...current].some(([name, load]) => {
    const before = previous.get(name);
    const prior = before === undefined ? undefined : publishedOf(before);
    const now = publishedOf(load);
    if (prior === undefined || now === undefined) {
      return prior !== now;
    }
    return (
      prior.length !== now.length ||
      prior.some((member, index) => {
        const next = now[index];
        return next === undefined || !sameMember(member, next);
      })
    );
  });
}

export type FamilyResolution =
  | { readonly kind: "none" }
  | {
      readonly kind: "members";
      readonly family: ToolFamily;
      readonly variants: readonly ToolVariant[];
      readonly diagnostics: readonly CatalogDiagnostic[];
    }
  | { readonly kind: "refused"; readonly diagnostic: CatalogDiagnostic };

export const sdkFamilySeverities = {
  unknown_family_source: "endpointDropped",
  family_source_failed: "endpointDropped",
  family_not_loaded: "endpointDropped",
  family_source_stale: "warning",
  family_member_rejected: "warning",
} as const satisfies SeverityTable;

type SdkFamilyCode = keyof typeof sdkFamilySeverities;

const diagnostic = (
  code: SdkFamilyCode,
  message: string,
): CatalogDiagnostic => ({ code, message });

const toolNamePattern = /^[a-z][a-z0-9_]{0,255}$/;

export const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Maps a member's `bodyType` the way an `@Body()` parameter's class is mapped, honouring
 * `options.schema`, and hands every diagnostic that mapping produces to `report`.
 */
export type FamilyBodyMapper = (
  bodyType: NewableFunction,
  report: (diagnostic: CatalogDiagnostic) => void,
) => JsonSchemaObject;

/**
 * Lowers one operation's family declaration into the variants its members become.
 *
 * A defect in one member is that member's alone: the rest of the family stays published and the
 * member is reported, because the members are host data and one bad row should not take every
 * sibling offline. Only a defect in the declaration itself refuses the operation.
 *
 * @param owner the operation's identity in diagnostics
 * @param declared the handler's own `@McpVariant`s; a member may not reuse their names
 * @param loads the member loads, or `undefined` when the sources have not loaded yet
 * @param mapBody maps a member's `bodyType` to its input schema
 */
export function resolveFamily(
  family: ToolFamily & { readonly source?: string },
  owner: string,
  declared: readonly McpVariantOptions[],
  options: ToolFamilyOptions,
  loads: FamilyLoads | undefined,
  mapBody: FamilyBodyMapper,
): FamilyResolution {
  const lowered = { parameter: family.parameter };
  if (family.source === undefined) {
    return {
      kind: "members",
      family: lowered,
      variants: [],
      diagnostics: [],
    };
  }
  if (!options.sources.has(family.source)) {
    return refused(
      "unknown_family_source",
      `${owner} takes its members from source '${family.source}', which is not registered; register it with options.families.provide.`,
    );
  }
  const load = loads?.get(family.source);
  if (load === undefined) {
    return refused(
      "family_not_loaded",
      `${owner} was built before source '${family.source}' finished loading; the catalog is rebuilt when it does.`,
    );
  }
  if (load.state === "failed") {
    return refused(
      "family_source_failed",
      `${owner} has no members: source '${family.source}' failed and has never returned any (${reasonOf(load.error)}).`,
    );
  }
  const diagnostics: CatalogDiagnostic[] = [];
  if (load.state === "stale") {
    diagnostics.push(
      diagnostic(
        "family_source_stale",
        `${owner} keeps the members source '${family.source}' last returned; the latest load failed (${reasonOf(load.error)}).`,
      ),
    );
  }
  const names = new Set(declared.map((variant) => variant.name));
  const keys = new Set<string>();
  const variants: ToolVariant[] = [];
  for (const member of load.members) {
    const body =
      memberProblem(member, names, keys) ??
      bodyOf(member, owner, mapBody, diagnostics);
    if (typeof body === "string") {
      diagnostics.push(
        diagnostic(
          "family_member_rejected",
          `${owner} drops member '${String(member.name)}': ${body}.`,
        ),
      );
      continue;
    }
    names.add(member.name);
    keys.add(JSON.stringify(member.key));
    variants.push(lower(member, body, family.parameter));
  }
  return { kind: "members", family: lowered, variants, diagnostics };
}

function memberProblem(
  member: McpFamilyMember,
  names: ReadonlySet<string>,
  keys: ReadonlySet<string>,
): string | undefined {
  if (typeof member.name !== "string" || !toolNamePattern.test(member.name)) {
    return "its name does not match the tool-name pattern";
  }
  if (
    typeof member.description !== "string" ||
    member.description.trim() === ""
  ) {
    return "it has no description";
  }
  if (names.has(member.name)) {
    return "another member or variant has the same name";
  }
  if (
    !(typeof member.key === "string" || Number.isFinite(member.key)) ||
    keys.has(JSON.stringify(member.key))
  ) {
    return "its key is not a string or finite number, or repeats another member's";
  }
  return undefined;
}

/**
 * @returns the member's input schema, or the reason it has none
 */
function bodyOf(
  member: McpFamilyMember,
  owner: string,
  mapBody: FamilyBodyMapper,
  diagnostics: CatalogDiagnostic[],
): JsonSchemaObject | string {
  if (member.body !== undefined && member.bodyType !== undefined) {
    return "it sets both body and bodyType";
  }
  if (member.bodyType !== undefined && typeof member.bodyType !== "function") {
    return "its bodyType is not a class";
  }
  const schema: JsonSchemaObject | undefined =
    member.bodyType === undefined
      ? member.body
      : mapBody(member.bodyType, (note) =>
          diagnostics.push({
            code: note.code,
            message: `${owner} member '${member.name}': ${note.message}`,
          }),
        );
  const raw: unknown = schema;
  if (
    schema === undefined ||
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return "its body is not a JSON Schema object";
  }
  const invalid = declaredSchemaProblem(schema);
  return invalid === undefined ? schema : `its body ${invalid}`;
}

function lower(
  member: McpFamilyMember,
  body: JsonSchemaObject,
  parameter: string,
): ToolVariant {
  const annotations = {
    ...(member.readOnly === undefined ? {} : { readOnlyHint: member.readOnly }),
    ...(member.destructive === undefined
      ? {}
      : { destructiveHint: member.destructive }),
    ...(member.idempotent === undefined
      ? {}
      : { idempotentHint: member.idempotent }),
  };
  return {
    name: member.name,
    description: member.description,
    arguments: [
      { name: parameter, hidden: { kind: "constant", value: member.key } },
    ],
    requestBody: {
      schema: body,
      ...(member.bodyRequired === undefined
        ? {}
        : { required: member.bodyRequired }),
    },
    ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
  };
}

function refused(code: SdkFamilyCode, message: string): FamilyResolution {
  return { kind: "refused", diagnostic: diagnostic(code, message) };
}
