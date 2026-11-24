export { createPdfMcpServer, type PdfMcpServerOptions } from "./server.js";
export {
  createDocumentRoot,
  resolveDocumentPath,
  listDocuments,
  type DocumentEntry,
  type DocumentListing,
  type DocumentRoot,
} from "./platform/paths.js";
export { formats, type DocumentFormat } from "./platform/formats.js";
export { limits, modePolicy } from "./platform/limits.js";
export {
  capabilities,
  capabilitiesWith,
  type PdfCapabilities,
} from "./platform/capabilities.js";
export { createGate, type Gate } from "./platform/gate.js";
export { vocabulary } from "./platform/vocabulary.js";
export {
  SezzleePdfError,
  asPdfError,
  fail,
  type SezzleePdfErrorCode,
} from "./platform/errors.js";
export {
  createPdfDocumentStore,
  type LoadedPdf,
  type PdfDocumentStore,
} from "./document/store.js";
export {
  pageAt,
  resolvedPagesOf,
  type PdfBody,
  type ResolvedPage,
} from "./document/extraction.js";
export {
  applyOcr,
  createOcrCache,
  type OcrCache,
  type OcrOutcome,
} from "./ocr/apply.js";
export type {
  OcrBinding,
  OcrProvider,
  PageImageBinding,
  PageRasterizer,
  RecognizeJob,
  RecognizedPage,
  RenderJob,
  RenderedPage,
} from "./ocr/port.js";
export {
  classify,
  extractAll,
  type ClassifiedPdf,
  type DocumentType,
  type ExtractedPage,
  type ExtractedPdf,
} from "./engine/inspector.js";
export {
  assertSelectablePages,
  toOneBased,
  toZeroBased,
} from "./engine/pages.js";
export {
  scanLiteral,
  type LiteralMatch,
  type MatchMode,
  type ScanOptions,
  type ScanResult,
} from "./search/literal.js";
export {
  toolDefinitions,
  toolNames,
  type ToolHandlers,
  type ToolName,
} from "./tools/definitions.js";
export { createHandlers, type PdfHandlerDeps } from "./tools/handlers.js";
export {
  cursorTtlMs,
  decodeCursor,
  encodePosition,
  optionsHash,
  type CursorTool,
  type PdfCursorOf,
  type PdfPosition,
} from "./tools/cursor.js";
