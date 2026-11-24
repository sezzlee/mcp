/**
 * The shape `@sezzlee/pdf-mcp` injects a rasterizer through.
 *
 * Guard: declared structurally rather than imported, so this adapter names no
 * `@sezzlee/*` package and the dependency graph stays acyclic — pdf-mcp may
 * devDepend on this package without a cycle. `test/adapters.spec.ts` in pdf-mcp
 * assigns this factory's result to the real `PageRasterizer` at compile time, so
 * the two cannot drift apart unnoticed.
 */
export interface RenderedPage {
  readonly page: number;
  readonly image: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg";
}

export interface RenderJob {
  readonly bytes: Buffer;
  readonly pages: readonly number[];
  readonly dpi: number;
  readonly signal?: AbortSignal;
}

export interface PageRasterizer {
  render(job: RenderJob): Promise<readonly RenderedPage[]>;
}
