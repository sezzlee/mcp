import { createRequire } from "node:module";
import type { McpServer } from "@modelcontextprotocol/server";
import { createFileSourceServer } from "@sezzlee/file-core";
import { createPdfDocumentStore } from "./document/store.js";
import { SezzleePdfError } from "./platform/errors.js";
import { limits } from "./platform/limits.js";
import type { OcrBinding, PageImageBinding } from "./ocr/port.js";
import type { DocumentRoot } from "./platform/paths.js";
import { toolDefinitions } from "./tools/definitions.js";
import { createHandlers } from "./tools/handlers.js";

const manifest = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const maxDocumentCacheSize = 16;

export interface PdfMcpServerOptions {
  /**
   * A budget, not a guard: an extracted document holds every page's markdown in
   * the process heap, so the default is the value that is safe on the smallest
   * host rather than the largest useful one.
   */
  readonly documentCacheSize?: number;
  readonly maxConcurrentListings?: number;
  readonly maxConcurrentExtractions?: number;
  /**
   * Binds OCR. Absent means read_pages and find_in_document refuse `ocr: true`
   * outright rather than quietly returning untranscribed pages, and
   * describe_document reports `capabilities.ocr: false`.
   *
   * Both ports are supplied by the caller: this package ships no rasterizer and
   * no model client, and never opens a socket itself.
   */
  readonly ocr?: OcrBinding;
  readonly pageImages?: PageImageBinding;
}

function requireCacheSize(value: number | undefined): number {
  if (value === undefined) return limits.documentCacheSize;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maxDocumentCacheSize
  ) {
    throw new SezzleePdfError(
      "invalid_argument",
      `documentCacheSize must be an integer between 1 and ${String(maxDocumentCacheSize)}.`,
    );
  }
  return value;
}

export function createPdfMcpServer(
  root: DocumentRoot,
  options: PdfMcpServerOptions = {},
): McpServer {
  const store = createPdfDocumentStore(
    root.real,
    requireCacheSize(options.documentCacheSize),
  );
  const server = createFileSourceServer(
    { name: "sezzlee-pdf", version: manifest.version },
    toolDefinitions,
    createHandlers(root, {
      store,
      ...(options.ocr === undefined ? {} : { ocr: options.ocr }),
      ...(options.pageImages === undefined
        ? {}
        : { pageImages: options.pageImages }),
      ...(options.maxConcurrentListings === undefined
        ? {}
        : { maxConcurrentListings: options.maxConcurrentListings }),
      ...(options.maxConcurrentExtractions === undefined
        ? {}
        : { maxConcurrentExtractions: options.maxConcurrentExtractions }),
    }),
  );
  const close = server.close.bind(server);
  server.close = async () => {
    store.clear();
    await close();
  };
  return server;
}
