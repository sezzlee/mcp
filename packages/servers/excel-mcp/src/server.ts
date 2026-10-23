import { createRequire } from "node:module";
import type { McpServer } from "@modelcontextprotocol/server";
import { createFileSourceServer } from "@sezzlee/file-core";
import type { WorkbookRoot } from "./platform/paths.js";
import { toolDefinitions } from "./tools/definitions.js";
import { createHandlers } from "./tools/handlers.js";
import { closeRegexWorkers } from "./platform/regex.js";

/**
 * Guard: the specifier is relative to the package root. This file stays at the
 * src/ root, so one `..` from dist/server.js reaches package.json; a folder
 * below src/ needs another `..`, and getting it wrong throws MODULE_NOT_FOUND
 * at server construction rather than at build time.
 */
const manifest = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export function createExcelMcpServer(root: WorkbookRoot): McpServer {
  const handlers = createHandlers(root);
  const server = createFileSourceServer(
    { name: "sezzlee-excel", version: manifest.version },
    toolDefinitions,
    handlers,
  );
  const close = server.close.bind(server);
  server.close = async () => {
    handlers.dispose();
    await closeRegexWorkers();
    await close();
  };
  return server;
}
