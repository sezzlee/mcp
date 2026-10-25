import type { IncomingHttpHeaders } from "node:http";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/express";
import {
  defaultRankerTimeoutMs,
  invokeLimits,
  resultLimits,
} from "@sezzlee/core";
import type {
  RankerFailureMode,
  Recognizer,
  SelectionDefault,
  SelectionRule,
} from "@sezzlee/core";
import type { ArgumentRule, JsonValue } from "./decorators.js";
import type { CatalogSeverity } from "./discovery/diagnostics.js";
import type { McpEndpointInfo } from "./discovery/endpoint-discovery.js";
import type { TypeShapeBinderOptions } from "./discovery/type-shape.js";
import { ToolFamilyOptions } from "./families.js";
import {
  SelectionSourceSettings,
  type McpSelectionSource,
} from "./selection-source.js";
import type { SezzleeFileOptions } from "./files.js";
import type { OuterConnection } from "./outer-connection.js";
import type { SezzleeRateLimitingOptions } from "./rate-limiting/types.js";
import type { ProviderToolRegistration } from "./provider-tools.js";

export interface OuterRequest {
  readonly headers: IncomingHttpHeaders;
  readonly protocol?: string;
  readonly connection?: OuterConnection;
  /**
   * The MCP transport's verified token, when `resourceServer` is configured.
   *
   * Without it a value provider sees headers only and decodes the token itself.
   */
  readonly auth?: VerifiedToken;
}

export interface VerifiedToken {
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly resource?: string | URL;
  readonly expiresAt?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** What a value provider sees. */
export interface McpCaller {
  readonly subject?: string;
  readonly clientId?: string;
  readonly scopes: readonly string[];
  readonly resource?: string;
  readonly expiresAt?: Date;
  claim(name: string): string | undefined;
  header(name: string): string | undefined;
}

export function callerOf(outer: OuterRequest | undefined): McpCaller {
  const auth = outer?.auth;
  const extra = auth?.extra ?? {};
  const subject =
    typeof extra["sub"] === "string" ? extra["sub"] : auth?.clientId;
  return {
    ...(subject === undefined ? {} : { subject }),
    ...(auth?.clientId === undefined ? {} : { clientId: auth.clientId }),
    scopes: auth?.scopes ?? [],
    ...(auth?.resource === undefined
      ? {}
      : { resource: auth.resource.toString() }),
    ...(auth?.expiresAt === undefined
      ? {}
      : { expiresAt: new Date(auth.expiresAt * 1000) }),
    claim: (name) => {
      const value = extra[name];
      return typeof value === "string" ? value : undefined;
    },
    header: (name) => {
      const value = outer?.headers[name.toLowerCase()];
      return Array.isArray(value) ? value.join(", ") : value;
    },
  };
}

export type ArgumentValueProvider = (
  caller: McpCaller,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface CurationTarget {
  readonly controller?: NewableFunction;
  readonly handler?: string;
  readonly method?: string;
  /** Matched against the final descriptor route, after prefixes and versioning. */
  readonly route?: string;
}

export interface CurationRule {
  readonly target: CurationTarget;
  readonly rules: Readonly<Record<string, ArgumentRule>>;
  readonly sealed: boolean;
  readonly specificity: number;
}

function specificityOf(target: CurationTarget): number {
  if (target.handler !== undefined) {
    return 3;
  }
  if (target.controller !== undefined || target.route !== undefined) {
    return 2;
  }
  return 1;
}

/**
 * Central curation: rules for controllers the host cannot decorate, and rules that repeat.
 *
 * `seal` exists because plain "most specific wins" lets a method decorator defeat a tenancy rule.
 * A sealed field cannot be overridden by any layer; attempting it is a build error.
 */
export class ArgumentCurationOptions {
  private readonly valueProviders = new Map<string, ArgumentValueProvider>();
  private readonly declarations: CurationRule[] = [];

  get providers(): ReadonlyMap<string, ArgumentValueProvider> {
    return this.valueProviders;
  }

  get rules(): readonly CurationRule[] {
    return this.declarations;
  }

  provide(name: string, provider: ArgumentValueProvider): this {
    this.valueProviders.set(name, provider);
    return this;
  }

  curate(
    target: CurationTarget,
    rules: Readonly<Record<string, ArgumentRule>>,
  ): this {
    this.declarations.push({
      target,
      rules,
      sealed: false,
      specificity: specificityOf(target),
    });
    return this;
  }

  everywhere(rules: Readonly<Record<string, ArgumentRule>>): this {
    return this.curate({}, rules);
  }

  seal(
    target: CurationTarget,
    rules: Readonly<Record<string, ArgumentRule>>,
  ): this {
    this.declarations.push({
      target,
      rules,
      sealed: true,
      specificity: specificityOf(target),
    });
    return this;
  }
}

export type SyntheticHeaders = Record<string, string>;

export class IdentityForwardingOptions {
  private readonly names = new Set<string>(["authorization"]);

  projector?: (outer: OuterRequest, syntheticHeaders: SyntheticHeaders) => void;

  get carriers(): ReadonlySet<string> {
    return this.names;
  }

  forward(name: string): this {
    this.names.add(name.toLowerCase());
    return this;
  }

  clear(): this {
    this.names.clear();
    return this;
  }

  project(
    projector: (
      outer: OuterRequest,
      syntheticHeaders: SyntheticHeaders,
    ) => void,
  ): this {
    this.projector = projector;
    return this;
  }
}

export interface SyntheticRequestOptions {
  host?: string;
  scheme?: string;
  accept?: string;
  userAgent?: string;
}

export interface SezzleeCacheOptions {
  lifetimeMs: number;
  maxCallers: number;
}

/** What a per-endpoint budget or timeout override sees. */
export interface InvokeTarget {
  readonly tool: string;
  readonly method: string;
  readonly route: string;
}

export interface SezzleeInvokeOptions {
  /** The largest tool response, in UTF-8 bytes, that may reach the agent. */
  maxResponseBytes: number;
  /** The largest backend body read, in bytes; a larger one is refused unread. */
  maxBufferedBytes: number;
  /**
   * How long an invocation waits for the backend, in whole milliseconds. Zero means no deadline.
   *
   * Values at or above 60000 are unreachable through a stock MCP client, whose own request timeout
   * (`DEFAULT_REQUEST_TIMEOUT_MSEC` in the TypeScript client) cancels first.
   */
  timeoutMs: number;
  maxResponseBytesFor?: (target: InvokeTarget) => number | undefined;
  timeoutMsFor?: (target: InvokeTarget) => number | undefined;
  /** Decoded `base64` file bytes one call may carry inline. */
  maxInlineFileBytes: number;
  /** The bytes one resolved `ref` file may carry. */
  maxFileBytes: number;
}

/**
 * The default result store's limits; packages/http/spec/result-reading.md. A store bound through
 * `extensionTokens.resultStore` replaces the default and these with it.
 */
export interface SezzleeResultOptions {
  lifetimeMs: number;
  maxCallerBytes: number;
  maxBytes: number;
}

export class ErrorMappingOptions {
  private readonly items: Recognizer[] = [];

  get recognizers(): readonly Recognizer[] {
    return this.items;
  }

  recognize(recognizer: Recognizer): this {
    this.items.push(recognizer);
    return this;
  }
}

export interface SezzleeResourceServerOptions {
  resource: URL;
  authorizationServers: URL[];
  scopesSupported?: string[];
  resourceName?: string;
  verifier: OAuthTokenVerifier;
  mcpPath?: string;
}

/**
 * Selection beyond the decorators: config-level rules, and a source for a host whose list of
 * exposed endpoints lives in data.
 *
 * The levels rank `operation`, `container`, the rows a source provides, `rules`, then `default`.
 * `rules` order carries no meaning, and equally specific rules that disagree are a build error
 * rather than a silent first-match win. Until a provided source has returned, an endpoint without
 * a decorator is not selected, because the source may be the only thing excluding it.
 *
 * @param source how the provided source is loaded; the same settings as `families`
 */
export class SezzleeSelectionOptions {
  default: SelectionDefault = "exclude";
  rules?: readonly SelectionRule[];
  readonly source = new SelectionSourceSettings();
  private supplier: McpSelectionSource | undefined;

  get provider(): McpSelectionSource | undefined {
    return this.supplier;
  }

  provide(source: McpSelectionSource): this {
    this.supplier = source;
    return this;
  }
}

/**
 * How a named, object-typed query binding reaches the agent.
 *
 * `flatten` leaves today's binding alone; `group` publishes one object-valued
 * argument the composer expands in the notation this SDK's backend parses. The
 * default is `flatten` because switching rewrites the `inputSchema` of every
 * affected tool and renames the namespace curation is keyed by.
 */
export interface SezzleeQueryOptions {
  grouping: "flatten" | "group";
}

export interface SezzleeNamingOptions {
  prefixMode: "always" | "onCollision";
  prefix?: (container: string) => string | undefined;
}

export interface SezzleeDiagnosticsOptions {
  failOn?: CatalogSeverity;
  readonly escalate: Set<string>;
  readonly downgrade: Set<string>;
}

/**
 * How `search_tools` treats a ranker bound through `extensionTokens.toolRanker`.
 *
 * @param rankerTimeoutMs the ranker's deadline in whole milliseconds; zero means none
 * @param onRankerFailure `fallback` ranks with BM25 and logs, `error` answers
 * `search_ranker_unavailable`
 */
export interface SezzleeSearchOptions {
  rankerTimeoutMs: number;
  onRankerFailure: RankerFailureMode;
}

export type SezzleeVisibilityTier = "declarative" | "probe";

export type SezzleeUnknownVisibility = "show" | "hide";

export type SezzleeUncoveredPolicy = "report" | "fatal";

/**
 * @param onUnknown what a tool no tier decided becomes; unset, it is `"hide"` when a
 * `toolAuthorizer` is bound and `"show"` otherwise
 * @param onUncovered `"fatal"` makes a selected tool no tier can decide before a call fail the
 * catalog as `visibility_uncovered`, and turns the check on without an authorizer
 * @param maxProbesPerSearch the most probe requests one `search_tools` call sends while it fills
 * its page; at the cap the page is returned as it stands and the tools left unprobed follow
 * `onUnknown`. Zero stops search from probing, and counts the probe tier as unable to reach a tool
 * in the coverage check. A verdict already cached does not count
 */
export interface SezzleeVisibilityOptions {
  tier: SezzleeVisibilityTier;
  onUnknown?: SezzleeUnknownVisibility;
  onUncovered: SezzleeUncoveredPolicy;
  maxProbesPerSearch: number;
  probeConcurrency: number;
  readonly probeValues: Map<string, string>;
}

export class SezzleeOptions {
  readonly tools: ProviderToolRegistration[] = [];
  readonly identity = new IdentityForwardingOptions();
  readonly synthetic: SyntheticRequestOptions = { accept: "application/json" };
  readonly cache: SezzleeCacheOptions = { lifetimeMs: 30_000, maxCallers: 128 };
  readonly errors = new ErrorMappingOptions();
  readonly selection = new SezzleeSelectionOptions();
  readonly query: SezzleeQueryOptions = { grouping: "flatten" };
  readonly naming: SezzleeNamingOptions = { prefixMode: "always" };
  readonly diagnostics: SezzleeDiagnosticsOptions = {
    failOn: "fatal",
    escalate: new Set<string>(),
    downgrade: new Set<string>(),
  };
  readonly arguments = new ArgumentCurationOptions();
  readonly families = new ToolFamilyOptions();
  readonly visibility: SezzleeVisibilityOptions = {
    tier: "declarative",
    onUncovered: "report",
    maxProbesPerSearch: 50,
    probeConcurrency: 4,
    probeValues: new Map<string, string>(),
  };
  readonly invoke: SezzleeInvokeOptions = {
    maxResponseBytes: invokeLimits.maxResponseBytes,
    maxBufferedBytes: invokeLimits.maxBufferedBytes,
    timeoutMs: invokeLimits.invokeTimeoutMs,
    maxInlineFileBytes: invokeLimits.maxInlineFileBytes,
    maxFileBytes: invokeLimits.maxFileBytes,
  };
  readonly results: SezzleeResultOptions = {
    lifetimeMs: resultLimits.lifetimeMs,
    maxCallerBytes: resultLimits.maxCallerBytes,
    maxBytes: resultLimits.maxBytes,
  };
  readonly search: SezzleeSearchOptions = {
    rankerTimeoutMs: defaultRankerTimeoutMs,
    onRankerFailure: "fallback",
  };
  /** Binding `files.resolver` is what makes `ref` appear in a file argument's schema. */
  readonly files: SezzleeFileOptions = {};
  /**
   * Grouping labels for a container the host cannot decorate. It sits below a `@McpTool({ tags })`
   * declaration and above the container-derived default, and like a declaration it replaces that
   * default rather than adding to it.
   */
  tags?: (container: string) => readonly string[] | undefined;
  /** Search vocabulary for a container the host cannot decorate, below a `@McpTool({ searchTerms })`. */
  searchTerms?: (container: string) => readonly string[] | undefined;
  /**
   * Grouping labels decided per endpoint. It sits below a `@McpTool({ tags })` declaration and
   * above `options.tags`; returning undefined keeps the next level.
   */
  endpointTags?: (endpoint: McpEndpointInfo) => readonly string[] | undefined;
  /**
   * Search vocabulary decided per endpoint. It sits below a `@McpTool({ searchTerms })` declaration
   * and above `options.searchTerms`; returning undefined keeps the next level.
   */
  endpointSearchTerms?: (
    endpoint: McpEndpointInfo,
  ) => readonly string[] | undefined;
  /**
   * A description for an endpoint the host documents elsewhere. It sits below a
   * `@McpTool({ description })` declaration and above the endpoint's `@ApiOperation` text, which
   * it receives as `declared`; returning undefined or blank keeps that.
   */
  description?: (endpoint: McpEndpointInfo) => string | undefined;
  /**
   * Per-caller limits on `tools/call`. Unset, nothing is limited and no wrapper runs; see
   * packages/http/spec/rate-limiting.md.
   */
  rateLimiting?: SezzleeRateLimitingOptions;
  /** The behaviour revision of the whole catalog; raising it changes every tool version. */
  revision?: number;
  /** A behaviour revision for a container the host cannot decorate, below a `@McpTool({ revision })`. */
  containerRevision?: (container: string) => number | undefined;
  schema?: TypeShapeBinderOptions;
  resourceServer?: SezzleeResourceServerOptions;
}

export const SEZZLEE_OPTIONS = "SEZZLEE_OPTIONS";
