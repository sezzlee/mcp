import type {
  FieldError,
  PayloadFacts,
  PayloadShape,
  SdkError,
  SdkErrorCode,
} from "./generated/invoke-result.js";
import type { JsonSchemaObject } from "./generated/tool-definition.js";
import { tokenize } from "./search.js";

/** The defaults both SDKs start from; a host may lower either. */
export const invokeLimits = {
  maxResponseBytes: 262_144,
  invokeTimeoutMs: 30_000,
  maxInlineFileBytes: 1_048_576,
  maxFileBytes: 16_777_216,
} as const;

export const narrowingFallback = "Constrains the result set.";

export const maxNarrowingArguments = 8;

const cardinalityTokens: ReadonlySet<string> = new Set([
  "limit",
  "top",
  "take",
  "max",
  "count",
  "size",
  "page",
  "per",
]);

const selectionTokens: ReadonlySet<string> = new Set([
  "offset",
  "skip",
  "cursor",
  "after",
  "before",
  "filter",
  "query",
  "search",
  "field",
  "select",
  "since",
  "from",
  "until",
  "status",
]);

/**
 * A fact about a value, never a string taken from it.
 *
 * @param value the parsed body, or the meta-tool payload about to be emitted
 * @returns the shape summary a refusal carries in place of the body
 */
export function describePayload(value: unknown): PayloadShape {
  if (Array.isArray(value)) {
    return { kind: "array", count: value.length };
  }
  if (typeof value === "object" && value !== null) {
    return { kind: "object", count: Object.keys(value).length };
  }
  if (typeof value === "string") {
    return { kind: "text", count: value.length };
  }
  return { kind: "text" };
}

/**
 * The published arguments that reduce how much an operation returns, most effective first.
 *
 * @param schema the tool's published input schema
 * @returns at most {@link maxNarrowingArguments} arguments, each with its own description
 */
export function narrowingArguments(
  schema: JsonSchemaObject | undefined,
): readonly FieldError[] {
  const properties = schema?.properties;
  if (properties === undefined) {
    return [];
  }
  const cardinality: FieldError[] = [];
  const selection: FieldError[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const tokens = tokenize(name);
    const target = tokens.some((token) => cardinalityTokens.has(token))
      ? cardinality
      : tokens.some((token) => selectionTokens.has(token))
        ? selection
        : undefined;
    target?.push({
      name,
      message: property.description ?? narrowingFallback,
    });
  }
  return [...cardinality, ...selection].slice(0, maxNarrowingArguments);
}

/**
 * The shared SDK-side envelope, for codes that build their own message.
 *
 * @param code the SDK-side code
 * @param message the agent-facing message
 */
export function sdkError(code: SdkErrorCode, message: string): SdkError {
  return { error: code, message, retryable: false };
}

export interface OversizeResponse {
  readonly bytes: number;
  readonly limit: number;
  readonly shape: PayloadShape;
  readonly narrowing?: readonly FieldError[];
}

/**
 * Refuses a response that exceeded the payload budget.
 *
 * @param refusal the measured size and a summary of the discarded value
 */
export function refuseOversizeResponse(refusal: OversizeResponse): SdkError {
  const fields = refusal.narrowing ?? [];
  const payload: PayloadFacts = {
    bytes: refusal.bytes,
    limit: refusal.limit,
    shape: refusal.shape,
  };
  const message = [
    `The response is ${refusal.bytes} bytes; the limit is ${refusal.limit} bytes.`,
    "It is refused, not truncated: no part of the body was returned.",
    shapeSentence(refusal.shape),
    fields.length === 0
      ? "No argument of this call narrows the response."
      : `Narrow it and call again: ${fields.map((field) => field.name).join(", ")}.`,
  ].join(" ");
  return {
    error: "response_too_large",
    message,
    retryable: false,
    ...(fields.length === 0 ? {} : { fields: [...fields] }),
    payload,
  };
}

/**
 * Refuses an invocation that outlived its deadline.
 *
 * @param limitMs the deadline in whole milliseconds
 */
export type FileRefusalReason =
  "not_found" | "forbidden" | "unavailable" | "too_large";

/**
 * Refuses a call whose `ref` file argument the resolver did not deliver.
 *
 * Guard: `not_found` and `forbidden` produce one message. A ref is a string the agent wrote, and
 * a refusal that told the two apart would let it probe which refs exist for other callers.
 *
 * @param field the file argument, as the agent named it
 * @param limit the per-file byte limit, named when the file was too large
 */
export function refuseUnresolvedFile(
  field: string,
  reason: FileRefusalReason,
  limit: number,
): SdkError {
  switch (reason) {
    case "too_large":
      return {
        error: "file_too_large",
        message: `File argument '${field}' is over the limit of ${limit} bytes and was not sent.`,
        retryable: false,
      };
    case "unavailable":
      return {
        error: "file_unresolved",
        message: `File argument '${field}' could not be resolved right now. Retry the call.`,
        retryable: true,
      };
    default:
      return {
        error: "file_unresolved",
        message: `File argument '${field}' names a ref that could not be resolved. Retrying with the same ref will not help.`,
        retryable: false,
      };
  }
}

export function refuseTimedOutInvoke(limitMs: number): SdkError {
  return {
    error: "invoke_timeout",
    message:
      `The backend did not answer within ${limitMs} ms and the call was abandoned. ` +
      "The operation may already have been applied; re-read before retrying.",
    retryable: true,
  };
}

export function refuseChangedTool(name: string): SdkError {
  return {
    error: "tool_changed",
    message:
      `The tool '${name}' changed after it was loaded, so the call was refused before reaching the backend. ` +
      "Load it again with load_tool and retry with the new version.",
    retryable: false,
  };
}

export function refuseRankerUnavailable(): SdkError {
  return {
    error: "search_ranker_unavailable",
    message:
      "Search is unavailable: the ranker did not answer this query. Call search_tools again later.",
    retryable: true,
  };
}

function shapeSentence(shape: PayloadShape): string {
  if (shape.count === undefined) {
    return "The body is not a JSON array or object.";
  }
  switch (shape.kind) {
    case "array":
      return `The body is an array of ${shape.count} items.`;
    case "object":
      return `The body is an object with ${shape.count} properties.`;
    case "text":
      return `The body is a text value of ${shape.count} characters.`;
  }
}
