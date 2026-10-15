export type FamilyErrorCode =
  | "family_parameter_unresolved"
  | "family_without_members"
  | "family_key_unfilled"
  | "family_key_duplicate"
  | "variant_body_without_family"
  | "variant_body_invalid";

export type SezzleeTemplateErrorCode =
  | FamilyErrorCode
  | "empty_route"
  | "body_not_allowed"
  | "conflicting_body_modes"
  | "duplicate_argument"
  | "identity_carrier_argument"
  | "path_parameter_array"
  | "header_parameter_array"
  | "unsupported_array_style"
  | "unsupported_object_style"
  | "unsupported_object_nesting"
  | "argument_collision"
  | "route_placeholder_mismatch"
  | "schema_def_conflict"
  | "curation_unresolved"
  | "invalid_fill_constant"
  | "hidden_required_omitted"
  | "variant_declaration_conflict"
  | "sealed_curation_overridden"
  | "ambiguous_curation"
  | "unsupported_body_shape"
  | "unsupported_parameter_style"
  | "invalid_cookie_name"
  | "identity_carrier_parameter"
  | "unsupported_parameter_content"
  | "multiple_querystring"
  | "querystring_with_query";

export class SezzleeTemplateError extends Error {
  constructor(
    readonly code: SezzleeTemplateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SezzleeTemplateError";
  }
}

export type SezzleeArgumentErrorCode =
  | "unknown_argument"
  | "invalid_path_type"
  | "missing_path_parameter"
  | "header_injection"
  | "null_not_allowed"
  | "invalid_type"
  | "deferred_value_missing"
  | "deferred_value_invalid"
  | "invalid_cookie_value"
  | "cookie_carrier_collision"
  | "invalid_file_argument"
  | "file_too_large";

export class SezzleeArgumentError extends Error {
  constructor(
    readonly code: SezzleeArgumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SezzleeArgumentError";
  }
}

/**
 * A code a catalog build raises on its own. `diagnostics.escalate` can make any diagnostic fatal,
 * so {@link SezzleeCatalogError.code} is any diagnostic code, not only these.
 */
export type SezzleeCatalogErrorCode =
  | "name_collision"
  | "invalid_name"
  | "ambiguous_selection"
  | "family_source_failed";

export class SezzleeCatalogError extends Error {
  constructor(
    readonly code: SezzleeCatalogErrorCode | (string & {}),
    message: string,
  ) {
    super(message);
    this.name = "SezzleeCatalogError";
  }
}
