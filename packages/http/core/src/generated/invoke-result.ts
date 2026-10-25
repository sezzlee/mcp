export type InvokeResult = InvokeSuccess | MappedError | SdkError;
export type BackendErrorCode =
  | "validation_failed"
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "backend_error"
  | "backend_unavailable";
export type SdkErrorCode =
  | "unknown_tool"
  | "provider_invalid_input"
  | "provider_forbidden"
  | "provider_failed"
  | "provider_invalid_output"
  | "provider_business_error"
  | "not_invocable"
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
  | "file_too_large"
  | "file_unresolved"
  | "response_too_large"
  | "invoke_timeout"
  | "backend_unreachable"
  | "search_ranker_unavailable"
  | "internal_error"
  | "tool_changed"
  | "rate_limit_exceeded"
  | "result_unavailable"
  | "invalid_selection";
export type PayloadShapeKind = "array" | "object" | "text";

export interface InvokeSuccess {
  status: number;
  body?: unknown;
  contentType?: string;
  bodyEncoding?: "base64";
  location?: string;
}
export interface MappedError {
  error: BackendErrorCode;
  message: string;
  status: number;
  retryable: boolean;
  fields?: FieldError[];
  retryAfterSeconds?: number;
  reference?: string;
}
export interface FieldError {
  name?: string;
  message: string;
}
export interface SdkError {
  error: SdkErrorCode;
  message: string;
  retryable: boolean;
  fields?: FieldError[];
  payload?: PayloadFacts;
  retryAfterSeconds?: number;
}
export interface PayloadFacts {
  bytes: number;
  limit: number;
  shape: PayloadShape;
}
export interface PayloadShape {
  kind: PayloadShapeKind;
  count?: number;
}
