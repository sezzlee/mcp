import { DiagnosticSink, type IngestionDiagnostic } from "./diagnostics.js";
import { isObject, type JsonObject } from "./ir/json.js";
import { bundleExternal, type DocumentLoader } from "./normalize/external.js";
import { lowerOperations, type SourcedEndpoint } from "./lower/operations.js";
import { defaultCookieDenyList } from "./lower/parameters.js";
import { securitySchemesOf, type SecurityModel } from "./lower/security.js";
import { serverOf } from "./lower/servers.js";
import { childPointer, rootPointer } from "./ir/brand.js";
import { parseDocument, versionOf } from "./parse/parse.js";
import { upgradeSwagger2 } from "./parse/swagger2.js";

/**
 * @param documentUrl where the document was read from; relative servers and external references
 * resolve against it
 * @param baseUrl replaces the document's root servers
 * @param loader reads external references; without one, a document that has any is refused
 * @param strict makes a document that fails validation fatal
 * @param cookieDenyList cookie names treated as identity even when no security scheme declares them
 * @param identityCookies further cookie names treated as identity, on top of the deny-list
 * @param outputSchema `omit` for a backend whose responses do not match its document
 * @param hoistPathPrefix a leading path segment moved from every route into the base URL
 * @param requestBodyRequired `always` treats an undeclared `requestBody.required` as true, for a
 * generator that omits it although the backend rejects an empty body
 * @param operations `x-sezzlee` fields laid over the document's, keyed by `METHOD /path` as the
 * document writes the path; a key that names no operation is fatal
 */
export interface IngestOptions {
  readonly documentUrl?: string;
  readonly baseUrl?: string;
  readonly serverVariables?: Readonly<Record<string, string>>;
  readonly loader?: DocumentLoader;
  readonly strict?: boolean;
  readonly cookieDenyList?: RegExp;
  readonly identityCookies?: readonly string[];
  readonly outputSchema?: "document" | "omit";
  readonly hoistPathPrefix?: string;
  readonly requestBodyRequired?: "document" | "always";
  readonly operations?: Readonly<Record<string, JsonObject>>;
}

export interface IngestionResult {
  readonly endpoints: readonly SourcedEndpoint[];
  /** The resolved root server, or the configured base URL that replaces it. */
  readonly rootBaseUrl?: string;
  readonly security: SecurityModel;
  readonly diagnostics: readonly IngestionDiagnostic[];
  readonly fatal: boolean;
}

/**
 * Turns an OpenAPI document into catalog descriptors. It never throws for anything the document
 * contains: every construct it cannot carry is a diagnostic. Only the loader's I/O can reject.
 */
export async function ingest(
  source: string | JsonObject,
  options: IngestOptions = {},
): Promise<IngestionResult> {
  const diagnostics = new DiagnosticSink(options.strict ?? false);
  const failed = (): IngestionResult => ({
    endpoints: [],
    security: new Map(),
    diagnostics: diagnostics.all,
    fatal: true,
  });
  const parsed =
    typeof source === "string" ? parseDocument(source, diagnostics) : source;
  if (parsed === undefined || !isObject(parsed)) {
    return failed();
  }
  const version = versionOf(parsed, diagnostics);
  if (version === undefined) {
    return failed();
  }
  const upgraded =
    version === "2.0"
      ? upgradeSwagger2(parsed, diagnostics, new WeakMap())
      : parsed;
  const document = await bundleExternal(
    upgraded,
    options.documentUrl,
    options.loader,
    diagnostics,
  );
  if (document === undefined || diagnostics.fatal) {
    return failed();
  }
  const context = {
    document,
    version: version === "2.0" ? ("3.0" as const) : version,
    diagnostics,
  };
  const security = securitySchemesOf(document, diagnostics);
  const operationOptions = {
    ...(options.documentUrl === undefined
      ? {}
      : { documentUrl: options.documentUrl }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.serverVariables === undefined
      ? {}
      : { variables: options.serverVariables }),
    cookieDenyList: withIdentityCookies(
      options.cookieDenyList ?? defaultCookieDenyList,
      options.identityCookies ?? [],
    ),
    outputSchema: options.outputSchema ?? "document",
    requestBodyRequired: options.requestBodyRequired ?? "document",
    ...(options.hoistPathPrefix === undefined
      ? {}
      : { hoistPathPrefix: options.hoistPathPrefix }),
    ...(options.operations === undefined
      ? {}
      : { operations: options.operations }),
  };
  const endpoints = lowerOperations(context, security, operationOptions);
  const rootBaseUrl = serverOf(
    [],
    { servers: document["servers"], at: childPointer(rootPointer, "servers") },
    operationOptions,
    new DiagnosticSink(),
  );
  return {
    endpoints: diagnostics.fatal ? [] : endpoints,
    ...(rootBaseUrl === undefined ? {} : { rootBaseUrl }),
    security,
    diagnostics: diagnostics.all,
    fatal: diagnostics.fatal,
  };
}

/**
 * Guard: the names extend the deny-list and never replace it. An operator adding
 * the one session cookie their backend uses must not thereby switch off the
 * default names that catch every other one.
 */
function withIdentityCookies(
  denyList: RegExp,
  names: readonly string[],
): RegExp {
  if (names.length === 0) {
    return denyList;
  }
  const exact = names.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );

  return new RegExp(`${denyList.source}|^(?:${exact.join("|")})$`, "i");
}
