import {
  familySeverities,
  severityIn,
  type CatalogSeverity,
  type DiagnosticsOptions,
  type SeverityTable,
} from "@sezzlee/core";

import { sdkFamilySeverities } from "../families.js";
import { sdkSelectionSeverities } from "../selection-source.js";

export { atLeast } from "@sezzlee/core";
export type {
  CatalogDiagnostic,
  CatalogSeverity,
  DiagnosticsOptions,
} from "@sezzlee/core";

const defaults: SeverityTable = {
  ...familySeverities,
  ...sdkFamilySeverities,
  ...sdkSelectionSeverities,
  name_collision: "fatal",
  ambiguous_selection: "fatal",
  invalid_name: "fatal",
  prm_path_prefixed: "fatal",
  query_parser_not_extended: "fatal",
  argument_collision: "endpointDropped",
  multiple_body_bindings: "endpointDropped",
  unsupported_binding: "endpointDropped",
  unsupported_body_shape: "endpointDropped",
  content_type_not_accepted: "endpointDropped",
  unresolved_file_field: "endpointDropped",
  body_parser_missing: "endpointDropped",
  unsupported_method: "endpointDropped",
  schema_def_conflict: "endpointDropped",
  template_rejected: "endpointDropped",
  duplicate_argument: "endpointDropped",
  unsupported_object_style: "endpointDropped",
  unsupported_object_nesting: "endpointDropped",
  unresolved_query_shape: "endpointDropped",
  version_not_carried: "endpointDropped",
  curation_unresolved: "endpointDropped",
  invalid_fill_constant: "endpointDropped",
  hidden_required_omitted: "endpointDropped",
  unknown_fill_source: "endpointDropped",
  variant_declaration_conflict: "endpointDropped",
  sealed_curation_overridden: "fatal",
  ambiguous_curation: "fatal",
  curated_open_body: "warning",
  curation_leaks_name: "warning",
  curation_leaks_name_in_argument: "warning",
  curation_unused_on_kept_route: "warning",
  variant_indistinguishable: "warning",
  visibility_uncovered: "warning",
  route_folded: "warning",
  optional_body_argument: "warning",
  synthetic_body_argument: "warning",
  unflattenable_body_root: "warning",
  body_field_collision: "warning",
  unbound_query_object: "warning",
  unbound_header_object: "warning",
  query_member_shadowed: "warning",
};

export function severityOf(
  code: string,
  options: DiagnosticsOptions = {},
): CatalogSeverity {
  return severityIn(defaults, code, options);
}
