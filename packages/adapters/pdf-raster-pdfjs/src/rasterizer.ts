import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PageRasterizer, RenderJob, RenderedPage } from "./port.js";

const require = createRequire(import.meta.url);

/**
 * Guard: pdf.js loads the 14 standard fonts from disk, and without this path it
 * warns once and then draws nothing for every glyph in a non-embedded font. The
 * page still renders, still has the right dimensions, and is blank — a silent
 * wrong answer that an OCR model would faithfully report as an empty page.
 */
const standardFontDataUrl = `${join(
  dirname(require.resolve("pdfjs-dist/package.json")),
  "standard_fonts",
)}/`;

export interface PdfjsRasterizerOptions {
  /** Upper bound on either rendered dimension, in pixels. Defaults to 4000. */
  readonly maxPixels?: number;
  readonly format?: "png" | "jpeg";
  /** JPEG encoder quality as an integer from 1 to 100. Defaults to 80. */
  readonly jpegQuality?: number;
}

const defaultMaxPixels = 4000;

function assertRequested(pages: readonly number[], pageCount: number): void {
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      throw new Error(
        `Page ${String(page)} is outside the document's ${String(pageCount)} pages.`,
      );
    }
  }
}

function assertLive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("Rasterization was aborted.");
  }
}

/**
 * Renders selected PDF pages to PNG or JPEG with pdf.js.
 *
 * Guard: `pdfjs-dist` and `@napi-rs/canvas` are pinned to exact versions that
 * were measured to work together. pdf.js 5 and `@napi-rs/canvas` 1.x fail at
 * `ctx.fill(path)` with "Value is none of these types `String`, `Path`" the
 * moment a glyph is drawn, so a caret on either dependency turns text pages into
 * a crash. Re-measure before moving either pin.
 */
export function createPdfjsRasterizer(
  options: PdfjsRasterizerOptions = {},
): PageRasterizer {
  const maxPixels = options.maxPixels ?? defaultMaxPixels;
  const format = options.format ?? "png";
  const jpegQuality = options.jpegQuality ?? 80;
  if (format !== "png" && format !== "jpeg") {
    throw new RangeError("format must be png or jpeg.");
  }
  if (
    !Number.isInteger(jpegQuality) ||
    jpegQuality < 1 ||
    jpegQuality > 100
  ) {
    throw new RangeError("jpegQuality must be an integer between 1 and 100.");
  }

  return {
    async render(job: RenderJob): Promise<readonly RenderedPage[]> {
      assertLive(job.signal);
      const document = await getDocument({
        data: new Uint8Array(job.bytes),
        standardFontDataUrl,
        isEvalSupported: false,
      }).promise;
      try {
        assertRequested(job.pages, document.numPages);
        const rendered: RenderedPage[] = [];
        for (const pageNumber of job.pages) {
          assertLive(job.signal);
          const page = await document.getPage(pageNumber);
          const unscaled = page.getViewport({ scale: 1 });
          const scale = Math.min(
            job.dpi / 72,
            maxPixels / Math.max(unscaled.width, unscaled.height),
          );
          const viewport = page.getViewport({ scale });
          const canvas = createCanvas(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
          const context = canvas.getContext("2d");
          /**
           * Guard: a PDF page has no background of its own. Without this fill
           * the canvas stays transparent, which can flatten to black and
           * hands the model an unreadable page.
           */
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          /**
           * Guard: @napi-rs/canvas implements every drawing operation pdf.js
           * issues, but not the DOM's focus-management methods, so its context
           * is not assignable to CanvasRenderingContext2D. The bridge is
           * narrowed to this one call rather than widening `context` itself, so
           * the fill calls above stay type-checked.
           */
          const canvasContext = context as unknown as CanvasRenderingContext2D;
          await page.render({ canvasContext, viewport }).promise;
          rendered.push(
            format === "jpeg"
              ? {
                  page: pageNumber,
                  image: canvas.toBuffer("image/jpeg", jpegQuality),
                  mediaType: "image/jpeg",
                }
              : {
                  page: pageNumber,
                  image: canvas.toBuffer("image/png"),
                  mediaType: "image/png",
                },
          );
          page.cleanup();
        }
        return rendered;
      } finally {
        await document.destroy();
      }
    },
  };
}
