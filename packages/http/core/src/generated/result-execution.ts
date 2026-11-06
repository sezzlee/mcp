export type ResultExecution =
  ExecutedResult | ProviderStored | ExecutionFailure | SdkError;
export type StoredValueKind = "array" | "object" | "string" | "scalar";
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

export interface ExecutedResult {
  source: ExecutionSource;
  value: unknown;
}
export interface ExecutionSource {
  handle: string;
  tool: string;
  scope: "stored_body";
}
export interface ProviderStored {
  stored: StoredResult;
  message: string;
}
export interface StoredResult {
  handle: string;
  bytes: number;
  limit: number;
  expiresInSeconds: number;
  outline: [OutlineEntry, ...OutlineEntry[]];
}
export interface OutlineEntry {
  path: string;
  kind: StoredValueKind;
  count?: number;
  fields?: [string, ...string[]];
}
export interface ExecutionFailure {
  error: "result_execution_failed";
  message: string;
  reason:
    | "invalid_input"
    | "code_limit"
    | "input_limit"
    | "output_limit"
    | "invalid_program"
    | "program_failed"
    | "invalid_result"
    | "memory_limit"
    | "timeout"
    | "cancelled"
    | "busy"
    | "unavailable";
  limits: {
    maxCodeBytes: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    maxMemoryBytes: number;
    maxStackBytes: number;
    timeoutMs: number;
    maxConcurrent: number;
  };
  retryable: boolean;
}
export interface SdkError {
  error: SdkErrorCode;
  message: string;
  retryable: boolean;
  fields?: FieldError[];
  payload?: PayloadFacts;
  retryAfterSeconds?: number;
}
export interface FieldError {
  name?: string;
  message: string;
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
