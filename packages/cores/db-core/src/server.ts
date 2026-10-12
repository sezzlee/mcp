import type { McpServer } from "@modelcontextprotocol/server";
import {
  createMcpSourceServer,
  type ErrorNormalizer,
  type ServerIdentity,
  type UnexpectedErrorReporter,
} from "@sezzlee/mcp-core";
import type { DbSource } from "./source.js";
import { toolDefinitions } from "./tools/definitions.js";
import { createHandlers } from "./tools/handlers.js";

export interface DbServerOptions {
  /** Where a driver error no normalizer classified is reported; stderr when absent. */
  readonly report?: UnexpectedErrorReporter;
}

/**
 * Builds the MCP server for one database source.
 *
 * Guard: `close()` is overridden to drain the connection pool first. Without it
 * a terminated process leaves open sockets holding the event loop, and the
 * server never exits.
 */
export function createDbMcpServer<TConfig>(
  identity: ServerIdentity,
  source: DbSource<TConfig>,
  normalize: ErrorNormalizer,
  options: DbServerOptions = {},
): McpServer {
  const server = createMcpSourceServer(
    identity,
    toolDefinitions,
    createHandlers(source, normalize, options.report),
  );
  const close = server.close.bind(server);
  server.close = async () => {
    await source.close();
    await close();
  };
  return server;
}
