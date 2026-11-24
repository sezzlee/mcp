import {
  FileSourceError,
  internalErrorMessage,
  internalErrorRecovery,
  type CoreErrorCode,
  type ErrorContext,
  type ErrorFactory,
} from "@sezzlee/file-core";
import { vocabulary } from "./vocabulary.js";

export type SezzleePdfErrorCode =
  | CoreErrorCode
  | "malformed_pdf"
  | "encrypted_pdf"
  | "extraction_failed"
  | "ocr_unavailable"
  | "ocr_failed"
  | "pages_unavailable"
  | "pages_failed";

export class SezzleePdfError extends FileSourceError {
  declare readonly code: SezzleePdfErrorCode;

  constructor(code: SezzleePdfErrorCode, message: string, recovery?: string) {
    super(code, message, recovery);
  }
}

export const fail: ErrorFactory<SezzleePdfErrorCode> = (
  code,
  message,
  recovery,
) => new SezzleePdfError(code, message, recovery);

export function asPdfError(
  error: unknown,
  context: ErrorContext = {},
): SezzleePdfError {
  if (error instanceof SezzleePdfError) {
    return error;
  }
  return new SezzleePdfError(
    "internal_error",
    internalErrorMessage(error, context),
    internalErrorRecovery(vocabulary),
  );
}
