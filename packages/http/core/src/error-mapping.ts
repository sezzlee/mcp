import { forwardable } from "./leak-filter.js";
import type {
  BackendErrorCode,
  FieldError,
  InvokeResult,
  InvokeSuccess,
  MappedError,
  SdkError,
} from "./generated/invoke-result.js";

export interface BackendResponse {
  readonly status: number;
  readonly contentType?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly bodyEncoding?: "base64";
}

export type ParsedBody =
  | { readonly kind: "empty" }
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "html"; readonly text: string }
  | { readonly kind: "text"; readonly text: string };

export interface InvokeOutcome {
  readonly message?: string;
  readonly fields?: readonly FieldError[];
}

export type Recognizer = (
  parsed: ParsedBody,
  response: BackendResponse,
) => InvokeOutcome | null;

export interface ErrorMappingOptions {
  readonly recognizers?: readonly Recognizer[];
  /** Agent-facing argument names, from the published input schema. */
  readonly knownFields?: readonly string[];
  /** Wire field name to agent argument name, for renamed arguments. */
  readonly fieldAliases?: Readonly<Record<string, string>>;
  /** Wire field names the agent cannot set. */
  readonly hiddenFields?: readonly string[];
}

/**
 * `status` is what separates the two error branches: an `SdkError` also carries `error`, so the
 * looser `"error" in result` test returns the right boolean with the wrong narrowed type. Pinned by
 * the sdk-envelope fixtures in conformance/error-mapping.
 */
export function isMappedError(result: InvokeResult): result is MappedError {
  return "error" in result && "status" in result;
}

export function isSdkError(result: InvokeResult): result is SdkError {
  return "error" in result && !("status" in result);
}

export function isInvokeError(
  result: InvokeResult,
): result is MappedError | SdkError {
  return "error" in result;
}

export const retryableStatuses: ReadonlySet<number> = new Set([
  408, 429, 502, 503, 504,
]);

export function codeFor(status: number, hasFields: boolean): BackendErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status === 409 || status === 412 || status === 428) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 502 || status === 503 || status === 504) {
    return "backend_unavailable";
  }
  if (status >= 500) return "backend_error";
  if ((status === 400 || status === 422) && hasFields) {
    return "validation_failed";
  }
  return "bad_request";
}

interface StandardMessageContext {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly reference?: string;
}

export const standardMessages = {
  validation_failed: () =>
    "The backend rejected one or more arguments. Fix the listed fields and call the operation again.",
  bad_request: ({ status }) =>
    `The backend rejected the request (${status}) without usable details. Check the arguments against the input schema.`,
  unauthenticated: () =>
    "The backend did not accept the credentials the call carried (401); retrying with the same session will not help.",
  forbidden: () =>
    "The caller is authenticated but not permitted to perform this operation (403).",
  not_found: () =>
    "No resource matched these arguments (404). The operation exists; check identifier arguments.",
  conflict: ({ status }) =>
    `The request conflicts with the current state of the resource (${status}). Re-read the resource before retrying.`,
  rate_limited: ({ retryAfterSeconds }) =>
    retryAfterSeconds === undefined
      ? "The backend is rate-limiting this caller (429)."
      : `The backend is rate-limiting this caller (429). Retry after ${retryAfterSeconds} seconds.`,
  backend_error: ({ status, reference }) =>
    reference === undefined
      ? `The backend failed while handling the call (${status}). Details were withheld.`
      : `The backend failed while handling the call (${status}). Details were withheld. Reference: ${reference}.`,
  backend_unavailable: ({ status }) =>
    `The backend is temporarily unavailable (${status}). Retry later.`,
} satisfies Record<BackendErrorCode, (ctx: StandardMessageContext) => string>;

const fieldLeakMessage = "The value was rejected; details were withheld.";

const referenceHeaders = [
  "x-correlation-id",
  "x-request-id",
  "request-id",
  "x-trace-id",
] as const;

const traceIdPattern = /^[A-Za-z0-9:_.-]{1,100}$/;

function mediaType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  const semicolon = contentType.indexOf(";");
  const raw = semicolon >= 0 ? contentType.slice(0, semicolon) : contentType;
  return raw.trim().toLowerCase();
}

function looksLikeHtml(trimmed: string): boolean {
  const lower = trimmed.toLowerCase();
  return lower.startsWith("<!doctype") || lower.startsWith("<html");
}

function shouldAttemptJson(type: string | undefined): boolean {
  if (type === undefined) return true;
  if (type === "application/json" || type === "text/json") return true;
  return type.endsWith("+json");
}

function tryParseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

export function parseBody(
  body: string | undefined,
  contentType: string | undefined,
): ParsedBody {
  const trimmed = (body ?? "").trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }

  const type = mediaType(contentType);
  if (type === "text/html" || looksLikeHtml(trimmed)) {
    return { kind: "html", text: trimmed };
  }

  const parsed = shouldAttemptJson(type) ? tryParseJson(trimmed) : undefined;
  if (parsed !== undefined) {
    return { kind: "json", value: parsed.value };
  }

  return { kind: "text", text: trimmed };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recognizeFieldErrors(parsed: ParsedBody): InvokeOutcome | null {
  if (parsed.kind !== "json" || !isPlainObject(parsed.value)) return null;
  const errors = parsed.value["errors"];
  if (!isPlainObject(errors)) return null;

  const fields: FieldError[] = [];
  for (const [name, raw] of Object.entries(errors)) {
    const messages = Array.isArray(raw) ? raw : [raw];
    for (const message of messages) {
      if (typeof message === "string" && message.length > 0) {
        fields.push({ name, message });
      }
    }
  }
  return fields.length === 0 ? null : { fields };
}

function recognizeProblemDetails(
  parsed: ParsedBody,
  response: BackendResponse,
): InvokeOutcome | null {
  if (parsed.kind !== "json" || !isPlainObject(parsed.value)) return null;
  const record = parsed.value;
  const detail =
    typeof record["detail"] === "string" ? record["detail"] : undefined;
  const title =
    typeof record["title"] === "string" ? record["title"] : undefined;

  const isProblemJson =
    mediaType(response.contentType) === "application/problem+json";
  const hasProblemShape =
    (detail !== undefined || title !== undefined) &&
    typeof record["status"] === "number";
  if (!isProblemJson && !hasProblemShape) return null;

  const message = detail ?? title;
  return message === undefined ? null : { message };
}

function recognizeNestException(
  parsed: ParsedBody,
  response: BackendResponse,
): InvokeOutcome | null {
  if (parsed.kind !== "json" || !isPlainObject(parsed.value)) return null;
  const record = parsed.value;
  if (typeof record["statusCode"] !== "number") return null;

  const message = record["message"];
  if (typeof message === "string") {
    return message.length > 0 ? { message } : null;
  }
  if (Array.isArray(message) && message.every((m) => typeof m === "string")) {
    const strings = message as string[];
    if (strings.length === 0) return null;
    if (response.status === 400 || response.status === 422) {
      return { fields: strings.map((text) => ({ message: text })) };
    }
    return { message: strings.join("; ") };
  }
  return null;
}

const envelopeKeys = [
  "message",
  "detail",
  "error_description",
  "error",
  "title",
  "reason",
] as const;

function recognizeMessageEnvelope(parsed: ParsedBody): InvokeOutcome | null {
  if (parsed.kind !== "json") return null;
  if (typeof parsed.value === "string") {
    return parsed.value.length > 0 ? { message: parsed.value } : null;
  }
  if (!isPlainObject(parsed.value)) return null;

  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(parsed.value)) {
    lowered.set(key.toLowerCase(), value);
  }
  for (const key of envelopeKeys) {
    const candidate = lowered.get(key);
    if (typeof candidate === "string" && candidate.length > 0) {
      return { message: candidate };
    }
  }
  return null;
}

function recognizePlainText(parsed: ParsedBody): InvokeOutcome | null {
  if (parsed.kind !== "text") return null;
  return parsed.text.length > 0 ? { message: parsed.text } : null;
}

export const builtInRecognizers = [
  recognizeFieldErrors,
  recognizeProblemDetails,
  recognizeNestException,
  recognizeMessageEnvelope,
  recognizePlainText,
] as const satisfies readonly Recognizer[];

function referenceFromHeaders(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  for (const name of referenceHeaders) {
    const value = headers[name];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function referenceFromProblemDetails(parsed: ParsedBody): string | undefined {
  if (parsed.kind !== "json" || !isPlainObject(parsed.value)) return undefined;
  const traceId = parsed.value["traceId"];
  if (typeof traceId !== "string") return undefined;
  return traceIdPattern.test(traceId) ? traceId : undefined;
}

function resolveReference(
  response: BackendResponse,
  parsed: ParsedBody,
): string | undefined {
  return (
    referenceFromHeaders(response.headers) ??
    referenceFromProblemDetails(parsed)
  );
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 10);
}

function matchInsensitively(
  name: string,
  candidates: readonly string[] | undefined,
): string | undefined {
  return candidates?.find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
}

/**
 * Resolution order: published names first, then the wire-to-agent alias.
 *
 * Published first because an agent name that happens to equal some other
 * argument's wire name has to resolve to the thing the agent can actually fix.
 */
function normalizeFieldName(
  name: string,
  options: ErrorMappingOptions,
): string | undefined {
  const stripped = name.startsWith("$.") ? name.slice(2) : name;
  const known = matchInsensitively(stripped, options.knownFields);
  if (known !== undefined) return known;
  const aliasKey = Object.keys(options.fieldAliases ?? {}).find(
    (candidate) => candidate.toLowerCase() === stripped.toLowerCase(),
  );
  if (aliasKey !== undefined) return options.fieldAliases?.[aliasKey];
  /**
   * A field the agent cannot set is emitted with its message and no name.
   * Dropping the entry loses the only useful information; keeping the wire name
   * sends the agent to repair an argument it does not have.
   */
  if (matchInsensitively(stripped, options.hiddenFields) !== undefined) {
    return undefined;
  }
  return stripped;
}

function normalizeField(
  field: FieldError,
  options: ErrorMappingOptions,
): FieldError {
  const message = forwardable(field.message) ?? fieldLeakMessage;
  if (field.name === undefined) {
    const resolved = fieldNameFromMessage(field.message, options);
    return resolved === undefined ? { message } : { name: resolved, message };
  }
  const name = normalizeFieldName(field.name, options);
  return name === undefined ? { message } : { name, message };
}

function fieldNameFromMessage(
  message: string,
  options: ErrorMappingOptions,
): string | undefined {
  const knownFields = options.knownFields;
  if (knownFields === undefined || knownFields.length === 0) {
    return undefined;
  }
  const leading = /^[A-Za-z_$][A-Za-z0-9_$.[\]]*/.exec(message.trimStart());
  if (leading === null) {
    return undefined;
  }
  const token = (leading[0].split(/[.[]/)[0] ?? "").toLowerCase();
  if (token.length === 0) {
    return undefined;
  }
  /**
   * A heuristic that names an unsettable argument is worse than no name, so a
   * hidden field is never guessed from a message.
   */
  if (matchInsensitively(token, options.hiddenFields) !== undefined) {
    return undefined;
  }
  const alias = Object.keys(options.fieldAliases ?? {}).find(
    (candidate) => candidate.toLowerCase() === token,
  );
  if (alias !== undefined) {
    return options.fieldAliases?.[alias];
  }
  return knownFields.find((candidate) => candidate.toLowerCase() === token);
}

function finalizeError(
  status: number,
  outcome: InvokeOutcome | null,
  response: BackendResponse,
  options: ErrorMappingOptions,
  reference: string | undefined,
): MappedError {
  const fields = outcome?.fields ?? [];
  const hasFields = fields.length > 0;
  const code = codeFor(status, hasFields);
  const retryAfterSeconds = parseRetryAfter(response.headers["retry-after"]);

  const rawMessage = outcome?.message;
  const forwardedMessage =
    rawMessage === undefined ? undefined : forwardable(rawMessage);
  const message =
    forwardedMessage ??
    standardMessages[code]({ status, retryAfterSeconds, reference });

  const result: MappedError = {
    error: code,
    message,
    status,
    retryable: retryableStatuses.has(status),
  };
  if (hasFields) {
    result.fields = fields.map((field) => normalizeField(field, options));
  }
  if (retryAfterSeconds !== undefined) {
    result.retryAfterSeconds = retryAfterSeconds;
  }
  if (reference !== undefined) {
    result.reference = reference;
  }
  return result;
}

function buildSuccess(
  response: BackendResponse,
  parsed: ParsedBody,
): InvokeSuccess {
  const result: InvokeSuccess = { status: response.status };
  if (response.bodyEncoding === "base64" && response.body !== undefined) {
    result.body = response.body;
    result.bodyEncoding = "base64";
    if (response.contentType !== undefined) {
      result.contentType = response.contentType;
    }
  } else if (parsed.kind === "json") {
    result.body = parsed.value;
  } else if (parsed.kind === "text") {
    result.body = parsed.text;
    if (response.contentType !== undefined) {
      result.contentType = response.contentType;
    }
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers["location"];
    if (location !== undefined && location.length > 0) {
      result.location = location;
    }
  }
  return result;
}

export function mapInvokeResult(
  response: BackendResponse,
  options: ErrorMappingOptions = {},
): InvokeResult {
  const parsed: ParsedBody =
    response.bodyEncoding === "base64"
      ? { kind: "empty" }
      : parseBody(response.body, response.contentType);
  const status = response.status;
  const reference =
    status >= 500 ? resolveReference(response, parsed) : undefined;

  for (const recognizer of options.recognizers ?? []) {
    const outcome = recognizer(parsed, response);
    if (outcome !== null) {
      return finalizeError(status, outcome, response, options, reference);
    }
  }

  if (status < 400) {
    return buildSuccess(response, parsed);
  }
  if (status === 401) {
    return finalizeError(status, null, response, options, undefined);
  }
  if (status >= 500) {
    return finalizeError(status, null, response, options, reference);
  }

  for (const recognizer of builtInRecognizers) {
    const outcome = recognizer(parsed, response);
    if (outcome !== null) {
      return finalizeError(status, outcome, response, options, undefined);
    }
  }

  return finalizeError(status, null, response, options, undefined);
}
