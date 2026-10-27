import { createRequire } from "node:module";
import type { McpServer } from "@modelcontextprotocol/server";
import { createFileSourceServer } from "@sezzlee/file-core";
import type { WorkbookRoot } from "./platform/paths.js";
import { toolDefinitions } from "./tools/definitions.js";
import { createHandlers } from "./tools/handlers.js";
import { createResultStore } from "./tools/retained-results.js";
import { closeRegexWorkers } from "./platform/regex.js";
import { createMcpOutputServer } from "./platform/writing.js";
import type { WorkbookOutput } from "./platform/versions.js";
import {
  createWritingHandlers,
  writingToolDefinitions,
} from "./tools/writing.js";

/**
 * Guard: the specifier is relative to the package root. This file stays at the
 * src/ root, so one `..` from dist/server.js reaches package.json; a folder
 * below src/ needs another `..`, and getting it wrong throws MODULE_NOT_FOUND
 * at server construction rather than at build time.
 */
const manifest = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export type ExcelMcpServerOptions =
  | { readonly mode: "read" }
  | { readonly mode: "write"; readonly output: WorkbookOutput };

export function createExcelMcpServer(
  root: WorkbookRoot,
  options: ExcelMcpServerOptions = { mode: "read" },
): McpServer {
  const identity = { name: "sezzlee-excel", version: manifest.version };
  const results = createResultStore();
  const { dispose, ...handlers } = createHandlers(root, results);
  const server =
    options.mode === "read"
      ? createFileSourceServer(identity, toolDefinitions, handlers)
      : createMcpOutputServer(
          identity,
          { ...toolDefinitions, ...writingToolDefinitions },
          {
            ...handlers,
            ...createWritingHandlers(root, options.output, results),
          },
        );
  const close = server.close.bind(server);
  server.close = async () => {
    dispose();
    await closeRegexWorkers();
    await close();
  };
  return server;
}
