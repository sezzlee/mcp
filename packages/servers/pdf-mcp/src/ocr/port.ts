/**
 * One page turned into pixels, ready for recognition.
 *
 * Guard: `page` is 1-based like every other page number on this server's
 * surface. A rasterizer that echoes the library's 0-based indexing would shift
 * every recognised page by one, so the orchestrator verifies what comes back
 * against what it asked for rather than trusting the order.
 */
export interface RenderedPage {
  readonly page: number;
  readonly image: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export interface RenderJob {
  readonly bytes: Buffer;
  readonly pages: readonly number[];
  readonly dpi: number;
  readonly signal?: AbortSignal;
}

/**
 * Turns selected PDF pages into images. Injected: this server ships no
 * rasterizer and names none.
 */
export interface PageRasterizer {
  render(job: RenderJob): Promise<readonly RenderedPage[]>;
}

export interface RecognizedPage {
  readonly page: number;
  readonly markdown: string;
  /** 0-1 when the provider reports one. Never invented on its behalf. */
  readonly confidence?: number;
}

export interface RecognizeJob {
  readonly pages: readonly RenderedPage[];
  readonly signal?: AbortSignal;
}

/**
 * Turns page images into text. Injected, and the only part of this server that
 * may reach a network or a model: nothing under src/ may open a socket, which
 * lint enforces. Handing a provider a page means those pixels leave this
 * process — describe_document says so in its capabilities block.
 */
export interface OcrProvider {
  readonly name: string;
  recognize(job: RecognizeJob): Promise<readonly RecognizedPage[]>;
}

export interface OcrBinding {
  readonly rasterizer: PageRasterizer;
  readonly provider: OcrProvider;
  readonly dpi?: number;
  readonly maxPagesPerCall?: number;
  readonly timeoutMs?: number;
}
