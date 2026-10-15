import {
  declaredSchemaProblem,
  type CatalogDiagnostic,
  type JsonSchemaObject,
  type SeverityTable,
  type ToolFamily,
  type ToolVariant,
} from "@sezzlee/core";
import type { McpToolEffect, McpVariantOptions } from "./decorators.js";
import {
  defaultLoadTimeoutMs,
  reasonOf,
  type Source,
  type SourceLoad,
  type SourceLoadFailure,
  type SourceLoadMode,
  type SourceLoads,
  type SourceLoadSettings,
} from "./source-loading.js";

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

export type McpFamilySource = Source<readonly McpFamilyMember[]>;

export type FamilyLoad = SourceLoad<readonly McpFamilyMember[]>;

export type FamilyLoads = SourceLoads<readonly McpFamilyMember[]>;

export type FamilyLoadMode = SourceLoadMode;

export type FamilyLoadFailure = SourceLoadFailure;

export class ToolFamilyOptions implements SourceLoadSettings {
  private readonly registered = new Map<string, McpFamilySource>();
  loadTimeoutMs = defaultLoadTimeoutMs;
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
 * Whether two loads of one source publish the same members. A body given as a class compares by
 * identity, a JSON Schema by structure.
 */
export const sameMembers = (
  a: readonly McpFamilyMember[],
  b: readonly McpFamilyMember[],
): boolean =>
  a.length === b.length &&
  a.every((member, index) => {
    const other = b[index];
    return other !== undefined && sameMember(member, other);
  });

export type FamilyResolution =
  | { readonly kind: "none" }
  | {
      readonly kind: "members";
      readonly family: ToolFamily;
      readonly variants: readonly ToolVariant[];
      readonly keys: ReadonlyMap<string, string | number>;
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

export const toolNamePattern = /^[a-z][a-z0-9_]{0,255}$/;

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
      keys: new Map(),
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
  const memberKeys = new Map<string, string | number>();
  for (const member of load.value) {
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
    memberKeys.set(member.name, member.key);
    variants.push(lower(member, body, family.parameter));
  }
  return {
    kind: "members",
    family: lowered,
    variants,
    keys: memberKeys,
    diagnostics,
  };
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
