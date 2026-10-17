import {
  FileSourceError,
  internalErrorMessage,
  internalErrorRecovery,
  type CoreErrorCode,
  type ErrorContext,
  type ErrorFactory,
} from "@sezzlee/file-core";
import { vocabulary } from "./vocabulary.js";

export type SezzleeExcelErrorCode =
  | CoreErrorCode
  | "encrypted_workbook"
  | "corrupt_workbook"
  | "not_a_workbook"
  | "undecodable_text"
  | "ambiguous_delimiter"
  | "unsupported_object_kind"
  | "unknown_column"
  | "ambiguous_column"
  | "unknown_sheet"
  | "ambiguous_sheet"
  | "empty_sheet"
  | "chart_sheet"
  | "unknown_header_row"
  | "ambiguous_header_row"
  | "invalid_range"
  | "invalid_pattern"
  | "numeric_overflow"
  | "range_outside_used_range";

export class SezzleeExcelError extends FileSourceError {
  declare readonly code: SezzleeExcelErrorCode;

  constructor(code: SezzleeExcelErrorCode, message: string, recovery?: string) {
    super(code, message, recovery);
  }
}

export const fail: ErrorFactory<SezzleeExcelErrorCode> = (
  code,
  message,
  recovery,
) => new SezzleeExcelError(code, message, recovery);

export function asExcelError(
  error: unknown,
  context: ErrorContext = {},
): SezzleeExcelError {
  if (error instanceof SezzleeExcelError) {
    return error;
  }
  return new SezzleeExcelError(
    "internal_error",
    internalErrorMessage(error, context),
    internalErrorRecovery(vocabulary),
  );
}
