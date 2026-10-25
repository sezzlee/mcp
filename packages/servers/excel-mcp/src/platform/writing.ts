import {
  createMcpOutputServer,
  guard as coreGuard,
  ownOutput,
  type GuardedHandler,
  type ToolCatalog,
  type ToolInputOf,
  type ToolNameOf,
} from "@sezzlee/mcp-core";
import { redactRoot } from "@sezzlee/file-core";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { asExcelError, fail } from "./errors.js";
import type { WorkbookRoot } from "./paths.js";

export { createMcpOutputServer, ownOutput };
export type { HandlersOf, ToolCatalog } from "@sezzlee/mcp-core";

export function guardWriting<D extends ToolCatalog, K extends ToolNameOf<D>>(
  root: WorkbookRoot,
  tool: K,
  handler: (
    args: ToolInputOf<D, K>,
    name: K,
    signal?: AbortSignal,
  ) => Promise<CallToolResult>,
): GuardedHandler<D, K> {
  const context = {
    root: root.real,
    tool,
    fail,
    redact: (detail: string) => redactRoot(detail, root.real),
  };
  return coreGuard<D, K>(context, handler, (error) =>
    asExcelError(error, context),
  );
}
