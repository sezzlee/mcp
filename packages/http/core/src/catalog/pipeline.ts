import { searchParameters } from "../card.js";
import { curatedDescriptions, type CurationRelief } from "../curation.js";
import { SezzleeCatalogError, SezzleeTemplateError } from "../errors.js";
import type { FileOptions } from "../file-argument.js";
import type {
  EndpointDescriptor,
  Revision,
} from "../generated/endpoint-descriptor.js";
import type { ToolDefinition } from "../generated/tool-definition.js";
import {
  deduplicateOperations,
  nameProductions,
  productionsOf,
  type PrefixMode,
  type ToolProduction,
} from "../naming.js";
import {
  routePlaceholderNames,
  type RequestTemplate,
} from "../request-template.js";
import { rankCatalogOf, type RankCatalog } from "../ranker.js";
import {
  foldToken,
  tokenize,
  ToolIndex,
  type SearchDocument,
} from "../search.js";
import {
  isSelected,
  resolveRules,
  type SelectionDefault,
  type SelectionMarker,
  type SelectionRule,
} from "../selection.js";
import {
  bodyRootArgument,
  bodyRootReasonOf,
  collidingBodyField,
  createToolDefinition,
  unflattenableRootKey,
} from "../tool-definition.js";
import { createRequestTemplateFromEndpoint } from "../tool.js";
import {
  atLeast,
  type CatalogDiagnostic,
  type CatalogSeverity,
} from "./diagnostics.js";
import { declareRevision, type RevisionDeclarations } from "./revision.js";

export type DiagnosticReporter = (diagnostic: CatalogDiagnostic) => void;

export type CatalogEntry<Source extends object = object> = {
  readonly tool: ToolDefinition;
  readonly descriptor: EndpointDescriptor;
  readonly owner: string;
  readonly template?: RequestTemplate;
  readonly alternateRoutes?: readonly string[];
} & Readonly<Source>;

/**
 * One discovered operation as a source hands it to the catalog.
 *
 * @param source fields carried onto the catalog entry unchanged, for the source's own later use
 * @param owner the operation's human-readable identity in diagnostics
 * @param declare applies the source's declarations to the discovered descriptor; it may throw a
 * `SezzleeTemplateError` for a declaration conflict, which aborts the build
 */
export interface CatalogCandidate<Source extends object = object> {
  readonly source: Source;
  readonly owner: string;
  readonly descriptor: EndpointDescriptor;
  readonly container?: SelectionMarker;
  readonly operation?: SelectionMarker;
  readonly tags?: readonly string[];
  readonly searchTerms?: readonly string[];
  readonly revision?: RevisionDeclarations;
  readonly declare: (tags: readonly string[] | undefined) => EndpointDescriptor;
}

/**
 * @param prior diagnostics the source reported before the pipeline ran; they count toward `fatal`
 * @param admit a source-specific refusal checked before a tool is produced
 * @param inspect a source-specific check over the finished entries, before `fatal` is computed
 */
export interface CatalogPipelineOptions<Source extends object = object> {
  readonly selection: {
    readonly default: SelectionDefault;
    readonly rules?: readonly SelectionRule[];
  };
  readonly prefixMode?: PrefixMode;
  readonly files?: FileOptions;
  readonly providers: { has(source: string): boolean };
  readonly severity: (code: string) => CatalogSeverity;
  readonly failOn: CatalogSeverity;
  readonly prior?: readonly CatalogDiagnostic[];
  readonly admit?: (
    descriptor: EndpointDescriptor,
    name: string,
  ) => CatalogDiagnostic | undefined;
  readonly inspect?: (
    entries: readonly CatalogEntry<Source>[],
    report: DiagnosticReporter,
  ) => void;
}

/**
 * What the catalog decided about one candidate operation.
 *
 * @param descriptor the declared descriptor it was published from; absent when it was not
 * selected, was refused, or folded into another route
 * @param toolName the name its tool was published under, for an operation without variants
 */
export interface OperationDecision {
  readonly descriptor?: EndpointDescriptor;
  readonly toolName?: string;
}

export interface CatalogBuild<Source extends object = object> {
  readonly entries: readonly CatalogEntry<Source>[];
  /** Every candidate operation, keyed by `METHOD /route`. */
  readonly operations: ReadonlyMap<string, OperationDecision>;
  readonly byName: ReadonlyMap<string, CatalogEntry<Source>>;
  readonly index: ToolIndex;
  readonly rankCatalog: RankCatalog;
  readonly diagnostics: readonly CatalogDiagnostic[];
  readonly fatal: readonly CatalogDiagnostic[];
  readonly policyNames: ReadonlySet<string>;
  readonly selected: number;
}

const groupedParametersOf = (
  descriptor: EndpointDescriptor,
): ReadonlySet<string> =>
  new Set(
    (descriptor.parameters ?? [])
      .filter((parameter) => parameter.style === "deepObject")
      .map((parameter) => parameter.name),
  );

/** The `METHOD /route` key `CatalogBuild.operations` uses. */
export const operationKeyOf = (descriptor: EndpointDescriptor): string =>
  `${descriptor.method} ${descriptor.route}`;

export function buildCatalog<Source extends object>(
  candidates: readonly CatalogCandidate<Source>[],
  options: CatalogPipelineOptions<Source>,
): CatalogBuild<Source> {
  const diagnostics: CatalogDiagnostic[] = [...(options.prior ?? [])];
  const report: DiagnosticReporter = (diagnostic) => {
    diagnostics.push(diagnostic);
  };

  const chosen: CatalogCandidate<Source>[] = [];
  for (const candidate of candidates) {
    const describedAs = `${candidate.descriptor.method} ${candidate.descriptor.route}`;
    try {
      if (
        isSelected(
          options.selection.default,
          candidate.container,
          candidate.operation,
          describedAs,
          resolveRules(
            options.selection.rules,
            candidate.descriptor.route,
            candidate.descriptor.method,
            describedAs,
          ),
        )
      ) {
        chosen.push(candidate);
      }
    } catch (error) {
      report({
        code: (error as SezzleeCatalogError).code,
        message: (error as Error).message,
      });
    }
  }

  const tagsOf = new Map<CatalogCandidate<Source>, readonly string[]>();
  const termsOf = new Map<CatalogCandidate<Source>, readonly string[]>();
  const revisionOf = new Map<CatalogCandidate<Source>, Revision | undefined>();
  for (const candidate of chosen) {
    if (candidate.tags !== undefined) {
      tagsOf.set(candidate, cleanTags(candidate.tags, candidate.owner, report));
    }
    const terms = candidate.searchTerms ?? candidate.descriptor.searchTerms;
    if (terms !== undefined) {
      termsOf.set(candidate, cleanSearchTerms(terms, candidate.owner, report));
    }
    if (candidate.revision !== undefined) {
      revisionOf.set(
        candidate,
        declareRevision(candidate.owner, candidate.revision, report),
      );
    }
  }
  const declare = (candidate: CatalogCandidate<Source>): EndpointDescriptor => {
    const declared = withSearchTerms(
      candidate.declare(tagsOf.get(candidate)),
      termsOf.get(candidate),
    );
    return revisionOf.has(candidate)
      ? withRevision(declared, revisionOf.get(candidate))
      : declared;
  };

  const alternates = new Map<CatalogCandidate<Source>, string[]>();
  const operations = deduplicateOperations(
    chosen,
    declare,
    ({ kept, folded }) => {
      const routes = folded.map((candidate) => candidate.descriptor.route);
      alternates.set(kept, routes);
      report({
        code: "route_folded",
        message: `${kept.owner} is also mounted at ${routes.join(", ")}; one tool is produced and ${kept.descriptor.route} is the route it invokes.`,
      });
    },
  );

  /**
   * One production per tool, from an already-folded list, expanded one operation at a time.
   *
   * A refused variant or family declaration drops its own operation and nothing else: expanding
   * the whole list under one guard let a single conflict empty the catalog without a fatal
   * diagnostic. Naming then walks the same productions, so the positional zip below stays aligned.
   */
  const declaredList = operations.map(declare);
  const sourceOf = new Map<EndpointDescriptor, CatalogCandidate<Source>>();
  operations.forEach((candidate, index) => {
    const declared = declaredList[index];
    if (declared !== undefined) {
      sourceOf.set(declared, candidate);
    }
  });

  const decisions = new Map<string, OperationDecision>(
    candidates.map((candidate) => [operationKeyOf(candidate.descriptor), {}]),
  );
  const productions: ToolProduction[] = [];
  for (const declared of declaredList) {
    try {
      productions.push(...productionsOf(declared));
      decisions.set(operationKeyOf(declared), { descriptor: declared });
    } catch (error) {
      report({
        code: (error as SezzleeTemplateError).code,
        message: (error as Error).message,
      });
    }
  }

  let names: string[];
  try {
    names = nameProductions(productions, {
      ...(options.prefixMode === undefined
        ? {}
        : { prefixMode: options.prefixMode }),
      onDiagnostic: (code, message) => report({ code, message }),
    });
  } catch (error) {
    report({
      code: (error as SezzleeCatalogError).code,
      message: (error as Error).message,
    });
    names = [];
  }

  const entries: CatalogEntry<Source>[] = [];
  const byName = new Map<string, CatalogEntry<Source>>();
  for (const [position, production] of productions.entries()) {
    const name = names[position];
    const candidate = sourceOf.get(production.operation);
    if (name === undefined || candidate === undefined) {
      continue;
    }
    const descriptor = production.endpoint;
    const variant = production.variant;
    if (name.length > 64) {
      report({
        code: "long_tool_name",
        message: `Tool name '${name}' is ${String(name.length)} characters; long names cost agent context and weaken search.`,
      });
    }
    const refusal = options.admit?.(descriptor, name);
    if (refusal !== undefined) {
      report(refusal);
      continue;
    }
    reportBodyRoot(descriptor, report);
    const relief = reliefFor(descriptor, alternates.get(candidate), report);
    let tool: ToolDefinition;
    let template: RequestTemplate | undefined;
    try {
      tool = createToolDefinition(
        descriptor,
        name,
        variant,
        relief,
        options.files,
      );
      template = createRequestTemplateFromEndpoint(
        descriptor,
        variant,
        relief,
        options.files,
      );
    } catch (error) {
      const code =
        error instanceof SezzleeTemplateError
          ? error.code
          : "template_rejected";
      report({ code, message: (error as Error).message });
      continue;
    }
    const missing = missingFillSource(template, options.providers);
    if (missing !== undefined) {
      report({
        code: "unknown_fill_source",
        message: `Tool '${name}' fills an argument from source '${missing}', which no value provider is registered for; register it with options.arguments.provide.`,
      });
      continue;
    }
    reportCurationLeaks(
      tool,
      template,
      curatedDescriptions(descriptor, variant),
      report,
    );
    if (
      template.bodyAllowsAdditionalProperties &&
      (template.bodyFills?.size ?? 0) > 0
    ) {
      report({
        code: "curated_open_body",
        message: `Tool '${name}' hides an argument on a body that accepts additional properties; the schema cannot express the exclusion, so only the composer enforces it.`,
      });
    }
    const alternateRoutes = alternates.get(candidate);
    const entry = {
      ...candidate.source,
      tool,
      descriptor,
      owner: candidate.owner,
      ...(template === undefined ? {} : { template }),
      ...(alternateRoutes === undefined ? {} : { alternateRoutes }),
    } as CatalogEntry<Source>;
    entries.push(entry);
    byName.set(name, entry);
    if (variant === undefined) {
      decisions.set(operationKeyOf(production.operation), {
        descriptor: production.operation,
        toolName: name,
      });
    }
  }

  options.inspect?.(entries, report);

  const policyNames = new Set<string>();
  for (const entry of entries) {
    for (const policy of entry.descriptor.auth.policies) {
      policyNames.add(policy);
    }
  }

  const fatal = diagnostics.filter((diagnostic) =>
    atLeast(options.severity(diagnostic.code), options.failOn),
  );

  reportIndistinguishableVariants(entries, report);

  const documents: SearchDocument[] = entries.map((entry) => ({
    name: entry.tool.name,
    ...(entry.tool.description === undefined
      ? {}
      : { description: entry.tool.description }),
    ...(entry.descriptor.tags === undefined
      ? {}
      : { tags: entry.descriptor.tags }),
    ...(entry.descriptor.searchTerms === undefined
      ? {}
      : { searchTerms: entry.descriptor.searchTerms }),
    route: entry.descriptor.route,
    ...(entry.alternateRoutes === undefined
      ? {}
      : { alternateRoutes: entry.alternateRoutes }),
    parameters: searchParameters(
      entry.tool.inputSchema,
      groupedParametersOf(entry.descriptor),
    ),
  }));

  return {
    entries,
    operations: decisions,
    byName,
    index: new ToolIndex(documents),
    rankCatalog: rankCatalogOf(documents),
    diagnostics,
    fatal,
    policyNames,
    selected: chosen.length,
  };
}

export function assertCatalogValid(fatal: readonly CatalogDiagnostic[]): void {
  const [first] = fatal;
  if (first === undefined) {
    return;
  }
  throw new SezzleeCatalogError(
    first.code,
    fatal.map((diagnostic) => diagnostic.message).join(" | "),
  );
}

/**
 * Spares a declaration that only a folded-away route could satisfy.
 *
 * Folding keeps the shortest route, so which route wins a length comparison would otherwise decide
 * whether the endpoint builds at all. Only path parameters can differ between an operation's
 * routes, so the folded routes' placeholders are the whole vocabulary this has to consider.
 *
 * The same relief is handed to both consumers, so a name reaches the reporter twice; the set keeps
 * one warning per name.
 */
function reliefFor(
  descriptor: EndpointDescriptor,
  foldedRoutes: readonly string[] | undefined,
  report: DiagnosticReporter,
): CurationRelief | undefined {
  if (foldedRoutes === undefined || foldedRoutes.length === 0) {
    return undefined;
  }
  const foldedNames = new Set<string>();
  for (const route of foldedRoutes) {
    for (const name of routePlaceholderNames(route)) {
      foldedNames.add(name);
    }
  }
  for (const name of routePlaceholderNames(descriptor.route)) {
    foldedNames.delete(name);
  }
  if (foldedNames.size === 0) {
    return undefined;
  }
  const reported = new Set<string>();
  return {
    foldedNames,
    onUnused: (name) => {
      if (reported.has(name)) {
        return;
      }
      reported.add(name);
      report({
        code: "curation_unused_on_kept_route",
        message: `Curation names '${name}', which exists only on a route folded away from ${descriptor.method} ${descriptor.route}; the declaration has no effect on the route that is invoked.`,
      });
    },
  };
}

/**
 * A declared source with no provider is a build error, never a per-call one.
 *
 * Deferring it to invoke time turns a host mistake into a failure that recurs on every call and
 * that nobody in the request path can act on.
 */
function missingFillSource(
  template: RequestTemplate,
  providers: { has(source: string): boolean },
): string | undefined {
  const fills = [
    ...template.parameters.map((parameter) => parameter.fill),
    ...(template.bodyFills?.values() ?? []),
    template.rootFill,
  ];
  for (const fill of fills) {
    if (
      fill?.kind === "deferred" &&
      typeof fill.source === "string" &&
      !providers.has(fill.source)
    ) {
      return fill.source;
    }
  }
  return undefined;
}

/**
 * Warns when the published prose still names an argument the agent cannot reach.
 *
 * Two codes, because the two haystacks deserve separate severities: the tool's own name and
 * description, and the descriptions the host wrote in its curation declarations. Descriptions
 * inherited from the backend's types are deliberately not searched — the host did not write them
 * while curating, and a generic wire name such as `type` collides with ordinary schema prose often
 * enough to drown the signal.
 *
 * Heuristic by construction: a single-token wire name such as `page` fires on "page size". Both
 * codes are warnings for that reason and are not escalated by default.
 */
function reportCurationLeaks(
  tool: ToolDefinition,
  template: RequestTemplate,
  descriptions: readonly string[],
  report: DiagnosticReporter,
): void {
  const curated = [
    ...template.parameters
      .filter(
        (parameter) =>
          parameter.fill !== undefined || parameter.argument !== undefined,
      )
      .map((parameter) => parameter.name),
    ...(template.bodyAliases?.values() ?? []),
    ...(template.bodyFills?.keys() ?? []),
  ];
  if (curated.length === 0) {
    return;
  }
  const haystack = tokenize(`${tool.name} ${tool.description}`);
  const curatedProse = descriptions.map((description) => tokenize(description));
  for (const wireName of curated) {
    const needle = tokenize(wireName);
    if (needle.length === 0) {
      continue;
    }
    if (containsSequence(haystack, needle)) {
      report({
        code: "curation_leaks_name",
        message: `Tool '${tool.name}' still names the curated argument '${wireName}' in its name or description; the agent cannot act on it.`,
      });
    }
    if (curatedProse.some((prose) => containsSequence(prose, needle))) {
      report({
        code: "curation_leaks_name_in_argument",
        message: `Tool '${tool.name}' still names the curated argument '${wireName}' in a curated argument description; the agent can search for it but cannot act on it.`,
      });
    }
  }
}

function containsSequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) {
      return true;
    }
  }
  return false;
}

/**
 * Warns when two variants of one operation are the same tool twice.
 *
 * Equal schemas and equal descriptions mean two cards competing for the same terms on the same
 * route, which is the search pollution route folding already exists to prevent.
 */
function reportIndistinguishableVariants(
  entries: readonly CatalogEntry[],
  report: DiagnosticReporter,
): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const key = `${entry.owner}|${entry.tool.description}|${JSON.stringify(entry.tool.inputSchema)}`;
    const owner = seen.get(key);
    if (owner !== undefined) {
      report({
        code: "variant_indistinguishable",
        message: `Tools '${owner}' and '${entry.tool.name}' expose the same schema and the same description; make their first clauses differ or the search card cannot tell them apart.`,
      });
      continue;
    }
    seen.set(key, entry.tool.name);
  }
}

interface VocabularyRules {
  readonly empty: { readonly code: string; readonly why: string };
  readonly duplicate: { readonly code: string; readonly noun: string };
}

const tagRules = {
  empty: { code: "empty_tag", why: "no caller can ask for it" },
  duplicate: { code: "duplicate_tag", noun: "tag" },
} as const satisfies VocabularyRules;

const searchTermRules = {
  empty: { code: "empty_search_term", why: "it contributes no search text" },
  duplicate: { code: "duplicate_search_term", noun: "search term" },
} as const satisfies VocabularyRules;

/**
 * Guard: two entries that fold alike are two index contributions, which doubles that term's
 * search weight for what looks like a spelling choice, and one that folds to nothing can never be
 * matched. The host's own spelling of the first is kept.
 */
function cleanVocabulary(
  declared: readonly string[],
  owner: string,
  report: DiagnosticReporter,
  rules: VocabularyRules,
): readonly string[] {
  const kept = new Map<string, string>();
  for (const entry of declared) {
    const folded = foldToken(entry);
    if (folded === "") {
      report({
        code: rules.empty.code,
        message: `${owner} declares a ${rules.duplicate.noun} that is empty once folded; ${rules.empty.why}, so it was dropped.`,
      });
      continue;
    }
    const first = kept.get(folded);
    if (first !== undefined) {
      report({
        code: rules.duplicate.code,
        message: `${owner} declares '${entry}' and '${first}', which fold to the same ${rules.duplicate.noun}; the later one was dropped because two equal ${rules.duplicate.noun}s double that term's search weight.`,
      });
      continue;
    }
    kept.set(folded, entry);
  }
  return [...kept.values()];
}

export function cleanTags(
  declared: readonly string[],
  owner: string,
  report: DiagnosticReporter,
): readonly string[] {
  return cleanVocabulary(declared, owner, report, tagRules);
}

export function cleanSearchTerms(
  declared: readonly string[],
  owner: string,
  report: DiagnosticReporter,
): readonly string[] {
  return cleanVocabulary(declared, owner, report, searchTermRules);
}

function withSearchTerms(
  descriptor: EndpointDescriptor,
  terms: readonly string[] | undefined,
): EndpointDescriptor {
  const { searchTerms: _declared, ...rest } = descriptor;
  return terms === undefined || terms.length === 0
    ? rest
    : { ...rest, searchTerms: [...terms] };
}

function withRevision(
  descriptor: EndpointDescriptor,
  revision: Revision | undefined,
): EndpointDescriptor {
  const { revision: _declared, ...rest } = descriptor;
  return revision === undefined ? rest : { ...rest, revision };
}

function reportBodyRoot(
  descriptor: EndpointDescriptor,
  report: DiagnosticReporter,
): void {
  const body = descriptor.requestBody;
  const parameterNames = (descriptor.parameters ?? []).map(
    (parameter) => parameter.name,
  );
  const reason = bodyRootReasonOf(body?.schema, body?.required, parameterNames);
  if (reason === undefined || body === undefined) {
    return;
  }
  const where = `${descriptor.method} ${descriptor.route}`;
  if (reason === "optional") {
    report({
      code: "optional_body_argument",
      message: `${where} binds an optional request body; it is exposed as a single optional '${bodyRootArgument}' argument, so omitting it sends no body at all.`,
    });
    return;
  }
  if (reason === "non_object") {
    report({
      code: "synthetic_body_argument",
      message: `${where} binds a request body that is not a JSON object; it is exposed as a single '${bodyRootArgument}' argument whose value becomes the whole body.`,
    });
    return;
  }
  if (reason === "collision") {
    const field = collidingBodyField(body.schema, parameterNames);
    report({
      code: "body_field_collision",
      message: `${where} binds a request body whose field '${field}' collides with a parameter of the same name; it is exposed as a single '${bodyRootArgument}' argument so neither slot is guessed.`,
    });
    return;
  }
  const key = unflattenableRootKey(body.schema) ?? "no flattenable member";
  report({
    code: "unflattenable_body_root",
    message: `${where} binds a request body whose root carries '${key}', which flattening would discard; it is exposed as a single '${bodyRootArgument}' argument that keeps the body schema whole.`,
  });
}
