#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { DocumentLoader } from "@sezzlee/openapi";
import {
  buildGatewayCatalog,
  hasFatal,
  summarize,
  type GatewayCatalog,
} from "./catalog/build.js";
import {
  createCatalogReloader,
  type DocumentRead,
  type DocumentValidators,
  type ReloadOutcome,
} from "./catalog/reload.js";
import { fetchDocument } from "./catalog/source.js";
import { watchSource } from "./catalog/watch.js";
import { createBoundedFetch, HostNotAllowed } from "./net/fetch.js";
import { asciiLower } from "./platform/ascii.js";
import { readConfig } from "./platform/config.js";
import { directoryOf, readText, readWithin } from "./platform/files.js";
import { createOpenApiMcpServer } from "./server.js";
import { createTokenExchange } from "./credentials/token-exchange.js";
import { serveHttp } from "./transport/http.js";

function stop(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * Guard: the config path is read by name so `turbo/no-undeclared-env-vars` forces it into
 * `passThroughEnv`. The secrets a config names are read through the lookup below, the one place
 * this package reads an arbitrary variable, because their names belong to the operator.
 */
const configPath = process.env["SEZZLEE_OPENAPI_CONFIG"];
if (configPath === undefined || configPath === "") {
  stop(
    "sezzlee-openapi reads its config from the file SEZZLEE_OPENAPI_CONFIG names.",
    2,
  );
}

let raw: unknown;
try {
  raw = JSON.parse(await readText(configPath));
} catch (error) {
  stop(
    `sezzlee-openapi cannot read its config: ${(error as Error).message}`,
    2,
  );
}

const outcome = readConfig(raw, (name) => process.env[name]);
if (outcome.kind === "invalid") {
  stop(outcome.reason, 2);
}
const { config, credentials } = outcome;

const isUrl = /^https?:\/\//i.test(config.source);
const sourcePath = isUrl
  ? undefined
  : resolve(directoryOf(configPath), config.source);
const documentUrl = isUrl
  ? config.source
  : new URL(`file://${sourcePath ?? ""}`).href;
const documentHost = isUrl
  ? asciiLower(new URL(config.source).host)
  : undefined;
const documentFetch = createBoundedFetch(
  new Set([
    ...(documentHost === undefined ? [] : [documentHost]),
    ...config.refHosts.map((host) => asciiLower(host)),
  ]),
);
const documentLimit = 64 * 1024 * 1024;

const readHttp = (
  url: URL,
  validators: DocumentValidators,
): Promise<DocumentRead> =>
  fetchDocument({
    fetch: documentFetch,
    url,
    validators,
    timeoutMs: config.limits.timeoutMs,
    maxBytes: documentLimit,
  });

async function readDocument(url: URL): Promise<string> {
  if (url.protocol === "file:") {
    return readWithin(directoryOf(sourcePath ?? "."), fileURLToPath(url));
  }
  const read = await readHttp(url, {});
  if (read.kind === "unchanged") {
    throw new Error(`sezzlee-openapi: ${url.href} answered 304.`);
  }
  return read.text;
}

const loader: DocumentLoader = readDocument;

async function readSource(
  validators: DocumentValidators,
): Promise<DocumentRead> {
  if (isUrl) {
    return readHttp(new URL(config.source), validators);
  }
  return {
    kind: "document",
    text: await readText(sourcePath ?? ""),
    validators: {},
  };
}

const build = (text: string): Promise<GatewayCatalog> =>
  buildGatewayCatalog(
    text,
    config,
    credentials,
    config.allowHosts,
    documentUrl,
    loader,
  );

function describe(error: unknown): string {
  if (error instanceof HostNotAllowed) {
    return `the document references a schema on '${error.host}', which is not a reference host; add it to "refHosts" in the config to allow it.`;
  }
  return error instanceof Error ? error.message : String(error);
}

let first: DocumentRead;
try {
  first = await readSource({});
} catch (error) {
  stop(`sezzlee-openapi cannot read the document: ${describe(error)}`, 2);
}
if (first.kind === "unchanged") {
  stop("sezzlee-openapi cannot read the document: it answered 304.", 2);
}

const gateway = await build(first.text).catch((error: unknown) =>
  stop(
    error instanceof HostNotAllowed
      ? `sezzlee-openapi: ${describe(error)}`
      : `sezzlee-openapi cannot resolve the document: ${describe(error)}`,
    2,
  ),
);
for (const line of summarize(gateway.ingestion, gateway.catalog.diagnostics)) {
  process.stderr.write(`${line}\n`);
}
process.stderr.write(
  `sezzlee-openapi: ${String(gateway.catalog.entries.length)} tool(s) from ${String(gateway.catalog.selected)} selected operation(s).\n`,
);
if (hasFatal(gateway)) {
  stop("sezzlee-openapi: the catalog has fatal diagnostics; see above.", 1);
}

const reloader = createCatalogReloader({
  initial: gateway,
  text: first.text,
  validators: first.validators,
  read: readSource,
  build,
  describe,
});
const fetcher = createBoundedFetch(gateway.allowedHosts);
const factory = (announce: boolean) => () =>
  createOpenApiMcpServer(reloader, fetcher, config.limits, { announce });

function report(outcome: ReloadOutcome): void {
  switch (outcome.kind) {
    case "unchanged":
      return;
    case "reloaded": {
      for (const line of outcome.diagnostics) {
        process.stderr.write(`${line}\n`);
      }
      process.stderr.write(
        `sezzlee-openapi: reloaded the document; generation ${String(outcome.snapshot.generation)}, ${String(outcome.snapshot.gateway.catalog.entries.length)} tool(s).\n`,
      );
      return;
    }
    case "kept": {
      process.stderr.write(
        `sezzlee-openapi: kept the current catalog (${outcome.reason}).\n`,
      );
      for (const line of outcome.details) {
        process.stderr.write(`${line}\n`);
      }
      return;
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

const stopWatching =
  config.reload === undefined
    ? () => undefined
    : watchSource(config.reload, () => reloader.reload().then(report));

if (config.transport.kind === "http") {
  const exchangeConfig = config.tokenExchange;
  const exchange =
    exchangeConfig === undefined
      ? undefined
      : createTokenExchange(
          exchangeConfig,
          outcome.clientSecret ?? "",
          createBoundedFetch(
            new Set([asciiLower(new URL(exchangeConfig.tokenEndpoint).host)]),
          ),
          config.limits.timeoutMs,
        );
  const listening = await serveHttp(factory(false), exchange, config.transport);
  reloader.onChange(() => {
    listening.notifyToolsChanged();
  });
  process.stderr.write(
    `sezzlee-openapi: listening on http://${config.transport.host}:${String(config.transport.port)}${config.transport.path}\n`,
  );
  const close = (): void => {
    stopWatching();
    listening.server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} else {
  serveOverStdio();
}

function serveOverStdio(): void {
  const handle = serveStdio(factory(true), {
    onerror: (error) => {
      process.stderr.write(`${error.message}\n`);
    },
  });
  const shutdown = (): void => {
    stopWatching();
    void handle.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
