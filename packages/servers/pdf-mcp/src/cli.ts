#!/usr/bin/env node
import { serveFileSourceStdio } from "@sezzlee/file-core";

const usage =
  "Usage: sezzlee-pdf <pdf-source-root> [--ocr <module>] [--pages <module>]";

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

interface Invocation {
  readonly root: string;
  readonly ocr?: string;
  readonly pages?: string;
}

/**
 * Guard: parsed here rather than with file-core's parseServerArgv, which refuses
 * any argument after the root. Bindings are loaded only when the operator
 * supplies a flag.
 */
function parse(argv: readonly string[]): Invocation | undefined {
  const [, , ...rest] = argv;
  let root: string | undefined;
  let ocr: string | undefined;
  let pages: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--ocr" || argument === "--pages") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      if (argument === "--ocr") ocr = value;
      else pages = value;
      index += 1;
      continue;
    }
    if (argument === undefined || argument.startsWith("-")) return undefined;
    if (root !== undefined) return undefined;
    root = argument;
  }
  if (root === undefined) return undefined;
  return {
    root,
    ...(ocr === undefined ? {} : { ocr }),
    ...(pages === undefined ? {} : { pages }),
  };
}

/**
 * Guard: the engine is reached through a dynamic import so a missing native
 * binary is catchable. The PDF engine ships prebuilt binaries for a narrower set
 * of platforms than the rest of this repo — there is no darwin-x64 build and the
 * wasm fallback its loader references is unpublished — and a static import would
 * abort the process before this file could explain why.
 */
function isEngineLoadFailure(detail: string): boolean {
  return (
    detail.includes("pdf-inspector") ||
    detail.includes("native binding") ||
    detail.includes(".node")
  );
}

const invocation = parse(process.argv);

if (invocation === undefined) {
  fail(usage, 2);
}

try {
  const [
    { createDocumentRoot },
    { createPdfMcpServer },
    { loadOcrBinding, loadPageImageBinding },
  ] = await Promise.all([
    import("./platform/paths.js"),
    import("./server.js"),
    import("./ocr/load.js"),
  ]);
  const ocr =
    invocation.ocr === undefined
      ? undefined
      : await loadOcrBinding(invocation.ocr);
  const pageImages =
    invocation.pages === undefined
      ? undefined
      : await loadPageImageBinding(invocation.pages);
  const root = await createDocumentRoot(invocation.root);
  const server = createPdfMcpServer(root, {
    ...(ocr === undefined ? {} : { ocr }),
    ...(pageImages === undefined ? {} : { pageImages }),
  });
  /**
   * Guard: stdio carries one connection per process, so pinning the single
   * eagerly built instance is what serveStdio's per-connection factory would
   * produce anyway — and it keeps a construction failure fatal here instead of
   * surfacing as an out-of-band error after the client has already opened.
   */
  serveFileSourceStdio(() => server);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (isEngineLoadFailure(detail)) {
    fail(
      `The PDF engine could not be loaded on ${process.platform}-${process.arch}. ${detail}`,
      3,
    );
  }
  fail(detail, 1);
}
