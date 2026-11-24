import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  guard as guardSource,
  toToolError as toSourceToolError,
  type ErrorNormalizer,
  type GuardedHandler,
  type McpSourceError,
  type ToolDefinitions,
  type ToolInputOf,
  type ToolNameOf,
} from "@sezzlee/mcp-core";
import {
  redactRoot,
  type CoreErrorCode,
  type ErrorContext,
  type ErrorFactory,
} from "./errors.js";

export interface GuardContext<K extends string> extends ErrorContext {
  readonly tool: K;
  readonly fail: ErrorFactory<CoreErrorCode>;
  readonly maxBytes?: number;
  readonly maxImagePayloadBytes?: number;
}

/**
 * Guard: the redactor is bound here rather than at each call site, so no file
 * server can emit an error envelope that still carries an absolute path.
 */
function withRootRedactor<C extends ErrorContext>(context: C): C {
  return {
    ...context,
    redact: (detail: string): string => redactRoot(detail, context.root),
  };
}

export function guard<D extends ToolDefinitions, K extends ToolNameOf<D>>(
  context: GuardContext<K>,
  handler: (
    args: ToolInputOf<D, K>,
    tool: K,
    signal?: AbortSignal,
  ) => Promise<CallToolResult>,
  normalize: ErrorNormalizer,
): GuardedHandler<D, K> {
  return guardSource<D, K>(withRootRedactor(context), handler, normalize);
}

export function toToolError(
  error: McpSourceError,
  context: ErrorContext = {},
  maxBytes?: number,
): CallToolResult {
  return toSourceToolError(error, withRootRedactor(context), maxBytes);
}
