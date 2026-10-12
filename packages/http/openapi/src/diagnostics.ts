import type { CatalogSeverity } from "@sezzlee/core";
import type { JsonPointer } from "./ir/brand.js";

export const ingestionSeverities = {
  openapi_document_unparseable: "fatal",
  openapi_version_unsupported: "fatal",
  openapi_document_invalid: "warning",
  external_ref_blocked: "fatal",
  server_variable_invalid: "fatal",
  server_url_unresolvable: "fatal",
  circular_component_ref: "endpointDropped",
  recursive_parameter_schema: "endpointDropped",
  unsupported_method: "endpointDropped",
  unsupported_collection_format: "endpointDropped",
  unsupported_parameter_content: "endpointDropped",
  unsupported_media_type: "endpointDropped",
  unsupported_encoding: "endpointDropped",
  streaming_response_unsupported: "endpointDropped",
  server_host_not_allowed: "endpointDropped",
  security_unsatisfiable: "endpointDropped",
  extension_invalid: "endpointDropped",
  extension_target_unknown: "fatal",
  family_member_rejected: "warning",
  security_scheme_unsupported: "warning",
  ref_siblings_ignored: "warning",
  annotation_removed: "warning",
  reserved_header_parameter_ignored: "warning",
  credential_parameter_ignored: "warning",
  allow_empty_value_ignored: "warning",
  identity_cookie_parameter: "warning",
  identity_cookie_uncovered: "warning",
  request_media_type_alternative_ignored: "warning",
  operation_id_unusable: "warning",
  search_terms_invalid: "warning",
  revision_invalid: "warning",
  extension_conflict: "warning",
  extension_overridden: "warning",
  callbacks_ignored: "warning",
  links_ignored: "warning",
  webhooks_ignored: "warning",
} as const satisfies Readonly<Record<string, CatalogSeverity>>;

export type IngestionCode = keyof typeof ingestionSeverities;

export interface IngestionDiagnostic {
  readonly code: IngestionCode;
  readonly severity: CatalogSeverity;
  readonly at: JsonPointer;
  readonly message: string;
}

const oncePerDocument: ReadonlySet<IngestionCode> = new Set([
  "annotation_removed",
  "ref_siblings_ignored",
  "callbacks_ignored",
  "links_ignored",
  "webhooks_ignored",
]);

/**
 * Collects ingestion diagnostics.
 *
 * @param strict raises `openapi_document_invalid` to fatal
 */
export class DiagnosticSink {
  private readonly entries: IngestionDiagnostic[] = [];
  private readonly reported = new Set<string>();

  constructor(private readonly strict = false) {}

  report(code: IngestionCode, at: JsonPointer, message: string): void {
    if (oncePerDocument.has(code)) {
      const key = `${code}|${message}`;
      if (this.reported.has(key)) {
        return;
      }
      this.reported.add(key);
    }
    const severity =
      this.strict && code === "openapi_document_invalid"
        ? "fatal"
        : ingestionSeverities[code];
    this.entries.push({ code, severity, at, message });
  }

  get all(): readonly IngestionDiagnostic[] {
    return this.entries;
  }

  get fatal(): boolean {
    return this.entries.some((entry) => entry.severity === "fatal");
  }
}

/** Raised inside one operation's lowering; the operation is dropped and the diagnostic reported. */
export class OperationDropped extends Error {
  constructor(
    readonly code: IngestionCode,
    readonly at: JsonPointer,
    message: string,
  ) {
    super(message);
    this.name = "OperationDropped";
  }
}
