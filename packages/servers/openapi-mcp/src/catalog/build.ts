import { asciiLower } from "../platform/ascii.js";
import {
  buildCatalog,
  severityIn,
  type CatalogBuild,
  type CatalogDiagnostic,
  type RevisionDeclarations,
} from "@sezzlee/core";
import {
  ingest,
  type IngestionDiagnostic,
  type SecurityModel,
  type SourcedEndpoint,
} from "@sezzlee/openapi";
import type { DocumentLoader } from "@sezzlee/openapi";
import {
  chooseCredentials,
  type ChosenCredentials,
} from "../credentials/credentials.js";
import type { GatewayConfig, ResolvedCredential } from "../platform/config.js";

export interface GatewaySource {
  readonly endpoint: SourcedEndpoint;
  readonly baseUrl: string;
  readonly credentials: ChosenCredentials;
}

export interface GatewayCatalog {
  readonly catalog: CatalogBuild<GatewaySource>;
  readonly allowedHosts: ReadonlySet<string>;
  readonly security: SecurityModel;
  readonly ingestion: readonly IngestionDiagnostic[];
  readonly dropped: readonly CatalogDiagnostic[];
}

/** Whether ingestion or the catalog build reported a fatal diagnostic; such a catalog is never served. */
export function hasFatal(gateway: GatewayCatalog): boolean {
  return (
    gateway.catalog.fatal.length > 0 ||
    gateway.ingestion.some((diagnostic) => diagnostic.severity === "fatal")
  );
}

/**
 * @param document the parsed document, or its text
 * @param configuredHosts hosts the operator allows beyond the root server; an operation whose
 * server is neither is dropped with `server_host_not_allowed`
 */
export async function buildGatewayCatalog(
  document: string | Record<string, unknown>,
  config: GatewayConfig,
  credentials: ReadonlyMap<string, ResolvedCredential>,
  configuredHosts: readonly string[],
  documentUrl: string | undefined,
  loader: DocumentLoader | undefined,
): Promise<GatewayCatalog> {
  const result = await ingest(document as Parameters<typeof ingest>[0], {
    ...(documentUrl === undefined ? {} : { documentUrl }),
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.serverVariables === undefined
      ? {}
      : { serverVariables: config.serverVariables }),
    ...(loader === undefined ? {} : { loader }),
    strict: config.strict,
    identityCookies: config.identityCookies,
    outputSchema: config.outputSchema,
    requestBodyRequired: config.requestBodyRequired,
    ...(config.hoistPathPrefix === undefined
      ? {}
      : { hoistPathPrefix: config.hoistPathPrefix }),
    operations: config.operations,
  });
  const allowedHosts = new Set(configuredHosts.map((host) => asciiLower(host)));
  if (result.rootBaseUrl !== undefined) {
    allowedHosts.add(asciiLower(new URL(result.rootBaseUrl).host));
  }
  const dropped: CatalogDiagnostic[] = [];
  const candidates = result.endpoints.flatMap((endpoint) => {
    if (endpoint.baseUrl === undefined) {
      return [];
    }
    const host = asciiLower(new URL(endpoint.baseUrl).host);
    if (!allowedHosts.has(host)) {
      dropped.push({
        code: "server_host_not_allowed",
        message: `${endpoint.key} is served by '${host}', which is not on the allowlist.`,
      });
      return [];
    }
    const chosen = chooseCredentials(
      endpoint.security,
      result.security,
      credentials,
    );
    if (chosen === undefined) {
      dropped.push({
        code: "security_unsatisfiable",
        message: `${endpoint.key} needs a credential none of the configured ones satisfies.`,
      });
      return [];
    }
    const name = config.names[endpoint.key];
    const searchTerms = config.searchTerms[endpoint.key];
    const descriptor =
      name === undefined
        ? endpoint.descriptor
        : { ...endpoint.descriptor, toolName: name };
    return [
      {
        source: { endpoint, baseUrl: endpoint.baseUrl, credentials: chosen },
        owner: endpoint.key,
        ...(endpoint.selection === undefined
          ? {}
          : { operation: endpoint.selection }),
        descriptor,
        ...(descriptor.tags === undefined ? {} : { tags: descriptor.tags }),
        ...(searchTerms === undefined ? {} : { searchTerms }),
        revision: revisionDeclarations(endpoint, config.revision),
        declare: (tags: readonly string[] | undefined) => ({
          ...descriptor,
          ...(tags === undefined ? {} : { tags: [...tags] }),
        }),
      },
    ];
  });
  const catalog = buildCatalog<GatewaySource>(candidates, {
    selection: config.selection,
    providers: new Set<string>(),
    severity: (code) =>
      severityIn(
        {
          name_collision: "fatal",
          invalid_name: "fatal",
          ambiguous_selection: "fatal",
        },
        code,
      ),
    failOn: "fatal",
    prior: dropped,
  });
  return {
    catalog,
    allowedHosts,
    security: result.security,
    ingestion: result.diagnostics,
    dropped,
  };
}

function revisionDeclarations(
  endpoint: SourcedEndpoint,
  configured: GatewayConfig["revision"],
): RevisionDeclarations {
  const declared = endpoint.descriptor.revision;
  return {
    catalog: [
      { value: configured.catalog, by: "revision.catalog" },
      { value: declared?.catalog, by: "the document's x-sezzlee revision" },
    ],
    container: [
      {
        value: configured.paths[endpoint.path],
        by: `revision.paths["${endpoint.path}"]`,
      },
      {
        value: declared?.container,
        by: `the x-sezzlee revision on path ${endpoint.path}`,
      },
    ],
    operation: [
      {
        value: configured.operations[endpoint.key],
        by: `revision.operations["${endpoint.key}"]`,
      },
      {
        value: declared?.operation,
        by: `the x-sezzlee revision on ${endpoint.key}`,
      },
    ],
  };
}

/** One line per diagnostic code, with its count and the first locations, so a large document stays readable. */
export function summarize(
  ingestion: readonly IngestionDiagnostic[],
  catalog: readonly CatalogDiagnostic[],
): string[] {
  const groups = new Map<
    string,
    { severity: string; count: number; samples: string[] }
  >();
  const add = (code: string, severity: string, sample: string): void => {
    const group = groups.get(code) ?? { severity, count: 0, samples: [] };
    group.count += 1;
    if (group.samples.length < 3) {
      group.samples.push(sample);
    }
    groups.set(code, group);
  };
  for (const diagnostic of ingestion) {
    add(
      diagnostic.code,
      diagnostic.severity,
      diagnostic.at === "" ? "(document)" : diagnostic.at,
    );
  }
  for (const diagnostic of catalog) {
    add(diagnostic.code, "catalog", diagnostic.message);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([code, group]) =>
        `${group.severity} ${code} ×${String(group.count)}: ${group.samples.join(" | ")}`,
    );
}
