import { SezzleePdfError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import type { PageImageBinding, RenderedPage } from "./port.js";

function bound(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new SezzleePdfError(
      "invalid_argument",
      `pageImages.${name} must be an integer between 1 and ${String(max)}.`,
    );
  }
  return value;
}

export function pageImageSettings(binding: PageImageBinding) {
  return {
    rasterizer: binding.rasterizer,
    dpi: bound("dpi", binding.dpi ?? limits.viewDpi, limits.maxViewDpi),
    maxPagesPerCall: bound(
      "maxPagesPerCall",
      binding.maxPagesPerCall ?? limits.maxViewPages,
      limits.maxViewPages,
    ),
    maxImageBytes: bound(
      "maxImageBytes",
      binding.maxImageBytes ?? limits.defaultViewImageBytes,
      limits.maxViewImageBytes,
    ),
    timeoutMs: bound(
      "timeoutMs",
      binding.timeoutMs ?? limits.maxViewMs,
      limits.maxViewMs,
    ),
  };
}

export async function renderPageImages(
  settings: ReturnType<typeof pageImageSettings>,
  bytes: Buffer,
  pages: readonly number[],
  signal: AbortSignal,
): Promise<readonly RenderedPage[]> {
  let rendered: readonly RenderedPage[];
  try {
    signal.throwIfAborted();
    rendered = await settings.rasterizer.render({
      bytes,
      pages: [...pages],
      dpi: settings.dpi,
      signal,
    });
    signal.throwIfAborted();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SezzleePdfError("pages_failed", `Page rendering failed: ${detail}`);
  }

  const byPage = new Map(rendered.map((entry) => [entry.page, entry]));
  if (rendered.length !== pages.length || byPage.size !== pages.length) {
    throw new SezzleePdfError(
      "pages_failed",
      "The rasterizer must return exactly one image for each requested page.",
    );
  }
  return pages.map((page) => {
    const entry = byPage.get(page);
    if (
      entry === undefined ||
      !(entry.image instanceof Uint8Array) ||
      entry.image.byteLength === 0 ||
      (entry.mediaType !== "image/png" &&
        entry.mediaType !== "image/jpeg" &&
        entry.mediaType !== "image/webp")
    ) {
      throw new SezzleePdfError(
        "pages_failed",
        `The rasterizer did not return a usable image for page ${String(page)}.`,
      );
    }
    if (entry.image.byteLength > settings.maxImageBytes) {
      throw new SezzleePdfError(
        "resource_limit",
        `The image for page ${String(page)} exceeds the ${String(settings.maxImageBytes)} byte per-image limit.`,
        "Configure a lower DPI or a rasterizer that produces smaller images.",
      );
    }
    return entry;
  });
}
