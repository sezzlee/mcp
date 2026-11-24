import { createPdfjsRasterizer } from "@sezzlee/pdf-raster-pdfjs";
import { beforeAll, expect, inject, it, vi } from "vitest";
import type { PageImageBinding, PageRasterizer } from "../src/ocr/port.js";
import {
  createDocumentRoot,
  type DocumentRoot,
} from "../src/platform/paths.js";
import { createHandlers } from "../src/tools/handlers.js";
import { bodyOf, bytesOf, codeOf } from "./fixtures/harness.js";

let root: DocumentRoot;
const filePath = "mixed.pdf";
const KiB = 1024;
const MiB = 1024 * KiB;

beforeAll(async () => {
  root = await createDocumentRoot(inject("fixtures").root);
});

function fakeRasterizer(size = 1) {
  return vi.fn<PageRasterizer["render"]>(async ({ pages }) =>
    [...pages].reverse().map((page) => ({
      page,
      image: new Uint8Array(size).fill(page),
      mediaType: page === 2 ? "image/jpeg" : "image/png",
    })),
  );
}

it("refuses page images without a rasterizer", async () => {
  const { view_pages } = createHandlers(root);
  expect(await codeOf(() => view_pages({ filePath, pages: [2] }))).toBe(
    "pages_unavailable",
  );
});

it.each([[[]], [[0]], [[1.5]], [[4]], [[2, 2]], [[1, 2, 3]]])(
  "refuses an invalid selection before rendering (%j)",
  async (pages) => {
    const render = fakeRasterizer();
    const { view_pages } = createHandlers(root, {
      pageImages: { rasterizer: { render }, maxPagesPerCall: 2 },
    });
    expect(await codeOf(() => view_pages({ filePath, pages }))).toBe(
      "invalid_argument",
    );
    expect(render).not.toHaveBeenCalled();
  },
);

it("returns images in request order with the rasterizer's media types", async () => {
  const render = fakeRasterizer();
  const handlers = createHandlers(root, {
    pageImages: { rasterizer: { render }, dpi: 96, maxPagesPerCall: 2 },
  });
  const described = bodyOf(await handlers.describe_document({ filePath }));
  expect(described).toMatchObject({
    pagesWithoutText: [2],
    capabilities: { ocr: false, pageImages: true },
    limits: { maxViewPages: 2 },
  });
  const result = await handlers.view_pages({ filePath, pages: [2, 1] });
  expect(render).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ dpi: 96, pages: [2, 1] }),
  );
  expect(result.content).toEqual([
    { type: "text", text: "Showing pages 2, 1." },
    { type: "image", data: "Ag==", mimeType: "image/jpeg" },
    { type: "image", data: "AQ==", mimeType: "image/png" },
  ]);
});

it("renders an image-only PDF as JPEG with the real adapter", async () => {
  const { view_pages } = createHandlers(root, {
    pageImages: { rasterizer: createPdfjsRasterizer({ format: "jpeg" }) },
  });
  const result = await view_pages({ filePath: "scanned.pdf", pages: [1] });
  expect(result.isError).toBeUndefined();
  const image = result.content[1];
  expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  if (image?.type !== "image") throw new Error("Expected an image block.");
  expect(Buffer.from(image.data, "base64").subarray(0, 3)).toEqual(
    Buffer.from([0xff, 0xd8, 0xff]),
  );
});

it("uses the OCR rasterizer as a fallback and prefers an explicit image binding", async () => {
  const render = fakeRasterizer();
  const recognize = vi.fn(async () => []);
  const ocr = { rasterizer: { render }, provider: { name: "fake", recognize } };
  const fallback = createHandlers(root, { ocr });
  const described = bodyOf(await fallback.describe_document({ filePath }));
  expect(described["capabilities"]).toMatchObject({
    ocr: true,
    pageImages: true,
  });
  expect(
    (await fallback.view_pages({ filePath, pages: [2] })).isError,
  ).toBeUndefined();
  expect(render).toHaveBeenCalledOnce();

  const explicit = fakeRasterizer();
  const handlers = createHandlers(root, {
    ocr,
    pageImages: { rasterizer: { render: explicit } },
  });
  await handlers.view_pages({ filePath, pages: [2] });
  expect(explicit).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledOnce();
  expect(recognize).not.toHaveBeenCalled();
});

it("refuses a single image over its configured byte limit", async () => {
  const pageImages: PageImageBinding = {
    rasterizer: { render: fakeRasterizer(2) },
    maxImageBytes: 1,
  };
  const { view_pages } = createHandlers(root, { pageImages });
  expect(await codeOf(() => view_pages({ filePath, pages: [2] }))).toBe(
    "resource_limit",
  );
});

it("accepts a 512 KiB image by default and caps text responses at 512 KiB", async () => {
  const { read_pages, view_pages } = createHandlers(root, {
    ocr: {
      rasterizer: { render: fakeRasterizer(512 * KiB) },
      provider: {
        name: "test",
        recognize: async () => [{ page: 2, markdown: "x".repeat(MiB) }],
      },
    },
  });
  const input = { filePath, pages: [2] };
  const image = await view_pages(input);
  expect(image.isError).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(image))).toBeGreaterThan(512 * KiB);
  const text = await read_pages({ ...input, ocr: true });
  expect(text.isError).toBeUndefined();
  expect(bytesOf(text)).toBeLessThanOrEqual(512 * KiB);
  expect(bodyOf(text)).toMatchObject({
    truncated: true,
    truncationReason: "maxPayloadBytes",
  });
});

it("refuses an image one byte above the default", async () => {
  const { view_pages } = createHandlers(root, {
    pageImages: { rasterizer: { render: fakeRasterizer(512 * KiB + 1) } },
  });
  expect(await codeOf(() => view_pages({ filePath, pages: [2] }))).toBe(
    "resource_limit",
  );
});

it("allows a binding to raise the per-image limit to 2 MiB", async () => {
  const pageImages = {
    rasterizer: { render: fakeRasterizer(2 * MiB) },
    maxImageBytes: 2 * MiB,
  };
  const { view_pages } = createHandlers(root, { pageImages });
  const result = await view_pages({ filePath, pages: [2] });
  expect(result.isError).toBeUndefined();
  expect(result.content[1]?.type).toBe("image");
  expect(() =>
    createHandlers(root, {
      pageImages: { ...pageImages, maxImageBytes: 2 * MiB + 1 },
    }),
  ).toThrow(/maxImageBytes must be an integer between 1 and 2097152/);
});

it("refuses the whole response when base64 and metadata exceed 8 MiB", async () => {
  const { view_pages } = createHandlers(root, {
    pageImages: {
      maxImageBytes: 2 * MiB,
      rasterizer: { render: fakeRasterizer(1.5 * MiB) },
    },
  });
  const input = { filePath: "alternating.pdf", pages: [1, 2, 3, 4] };
  const accepted = await view_pages({ ...input, pages: [1, 2, 3] });
  expect(accepted.isError).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(accepted))).toBeGreaterThan(6 * MiB);
  const result = await view_pages(input);
  expect(result.isError).toBe(true);
  expect(bodyOf(result)["error"]).toBe("resource_limit");
  expect(bodyOf(result)["message"]).toContain("the limit is 8388608 bytes");
  expect(result.content.map((block) => block.type)).toEqual(["text"]);
});

it("refuses a response with a page the rasterizer was never asked for", async () => {
  const { view_pages } = createHandlers(root, {
    pageImages: {
      rasterizer: {
        render: async () => [
          { page: 1, image: Uint8Array.of(1), mediaType: "image/png" },
        ],
      },
    },
  });
  expect(await codeOf(() => view_pages({ filePath, pages: [2] }))).toBe(
    "pages_failed",
  );
});

it("keeps the rendering slot occupied if a timed-out rasterizer has not settled", async () => {
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const render = vi.fn<PageRasterizer["render"]>(async () => {
    await pending;
    return [];
  });
  const { view_pages } = createHandlers(root, {
    pageImages: { rasterizer: { render }, timeoutMs: 50 },
  });
  const view = () => view_pages({ filePath, pages: [2] });
  try {
    expect(await codeOf(view)).toBe("pages_failed");
    expect(render.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(await codeOf(view)).toBe("resource_limit");
    expect(render).toHaveBeenCalledOnce();
  } finally {
    finish?.();
  }
});
