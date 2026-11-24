import { coreLimits, type ModePolicy } from "@sezzlee/file-core";

const maxPdfBytes = 32 * 1024 * 1024;

/**
 * Guard: every readable PDF is extracted whole, so there is no chunked tier.
 * residentMaxBytes equals the byte cap deliberately — a document the store
 * admits is always one the engine can be handed in full.
 */
export const modePolicy: ModePolicy = { residentMaxBytes: maxPdfBytes };

export const limits = {
  ...coreLimits,
  maxPdfBytes,
  maxPages: 2_000,
  /**
   * Guard: a safe ceiling, not a measurement. The synthetic 200-page, text-only
   * document measured 21.1 ms to extract whole and 7.0 ms for one page, so
   * selecting pages saves a third, not 199/200 — which is why a document is
   * extracted once and cached. A real document with embedded fonts and images
   * is far slower, and nothing measured bounds it.
   */
  maxExtractMs: 20_000,
  maxConcurrentExtractions: 2,
  maxConcurrentListings: 4,
  documentCacheSize: 2,
  defaultReadPages: 10,
  maxReadPages: 50,
  defaultFindResults: 50,
  maxFindResults: 200,
  maxMatchContextChars: 240,
  maxQueryChars: 256,
  viewDpi: 144,
  maxViewDpi: 200,
  maxViewPages: 4,
  defaultViewImageBytes: 512 * 1024,
  maxViewImageBytes: 2 * 1024 * 1024,
  maxViewImagePayloadBytes: 8 * 1024 * 1024,
  maxViewMs: 20_000,
  ocrDpi: 200,
  maxOcrPagesPerCall: 10,
  maxOcrMs: 120_000,
  maxConcurrentOcr: 1,
  ocrCacheEntries: 256,
} as const;
