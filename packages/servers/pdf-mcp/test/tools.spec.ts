import { beforeAll, describe, expect, inject, it } from "vitest";
import { limits } from "../src/platform/limits.js";
import { toolNames } from "../src/tools/definitions.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { bodyOf, bytesOf, codeOf, createHarness } from "./fixtures/harness.js";
import { createPdfDocumentStore } from "../src/document/store.js";
import {
  createDocumentRoot,
  resolveDocumentPath,
} from "../src/platform/paths.js";

let handlers: ToolHandlers;

beforeAll(async () => {
  const harness = await createHarness(inject("fixtures").root);
  handlers = harness.handlers;
});

describe("catalogue", () => {
  it("registers exactly the five read-only tools", () => {
    expect([...toolNames]).toStrictEqual([
      "list_documents",
      "describe_document",
      "read_pages",
      "view_pages",
      "find_in_document",
    ]);
  });
});

describe("list_documents", () => {
  it("lists PDF candidates without opening them", async () => {
    const body = bodyOf(await handlers.list_documents({}));
    const files = body["files"] as { filePath: string }[];
    const paths = files.map((file) => file.filePath);
    expect(paths).toContain("text.pdf");
    // A file that cannot be parsed is still a candidate: listing never parses.
    expect(paths).toContain("garbage.pdf");
    expect(paths).not.toContain("notes.txt");
    expect(body["totalExact"]).toBe(true);
  });

  it("honours a glob over the relative path", async () => {
    const body = bodyOf(
      await handlers.list_documents({ pattern: "nested/*.pdf" }),
    );
    const files = body["files"] as { filePath: string }[];
    expect(files.map((file) => file.filePath)).toStrictEqual([
      "nested/deep.pdf",
    ]);
  });
});

describe("describe_document", () => {
  it("reports per-page OCR need, not the classifier's smear", async () => {
    const body = bodyOf(
      await handlers.describe_document({ filePath: "mixed.pdf" }),
    );
    expect(body["pageCount"]).toBe(3);
    expect(body["pagesNeedingOcr"]).toStrictEqual([2]);
    expect(body["pagesWithoutText"]).toStrictEqual([2]);
    expect(body["needsOcr"]).toBe(true);
    expect(body["documentType"]).toBe("image_based");
  });

  it("names the confidence as a classification score", async () => {
    const body = bodyOf(
      await handlers.describe_document({ filePath: "text.pdf" }),
    );
    expect(body).toHaveProperty("classificationConfidence");
    expect(body).not.toHaveProperty("confidence");
    expect(body["pagesNeedingOcr"]).toStrictEqual([]);
  });

  it("declares that this server cannot run OCR", async () => {
    const body = bodyOf(
      await handlers.describe_document({ filePath: "scanned.pdf" }),
    );
    const capabilities = body["capabilities"] as Record<string, boolean>;
    expect(capabilities["ocr"]).toBe(false);
    expect(capabilities["pageImages"]).toBe(false);
    expect(capabilities["perPageOcrDetection"]).toBe(true);
    expect(body["needsOcr"]).toBe(true);
  });
});

describe("read_pages", () => {
  it("works without a prior describe_document call", async () => {
    const body = bodyOf(await handlers.read_pages({ filePath: "text.pdf" }));
    expect(body["returnedPages"]).toBe(3);
  });

  it("numbers pages from 1 and never emits page 0", async () => {
    const body = bodyOf(await handlers.read_pages({ filePath: "text.pdf" }));
    const pages = body["pages"] as { page: number }[];
    expect(pages.map((page) => page.page)).toStrictEqual([1, 2, 3]);
  });

  it("returns the page the caller asked for", async () => {
    const body = bodyOf(
      await handlers.read_pages({ filePath: "text.pdf", pages: [2] }),
    );
    const pages = body["pages"] as { page: number; markdown: string }[];
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe(2);
    expect(pages[0]?.markdown).toContain("2026-1188");
  });

  it("presents a scanned page as unreadable, not as empty", async () => {
    const body = bodyOf(await handlers.read_pages({ filePath: "mixed.pdf" }));
    const pages = body["pages"] as {
      page: number;
      needsOcr: boolean;
      empty: boolean;
    }[];
    const scanned = pages.find((page) => page.page === 2);
    expect(scanned?.needsOcr).toBe(true);
    expect(scanned?.empty).toBe(false);
    expect(pages).toHaveLength(3);
  });

  it("refuses a page beyond the document", async () => {
    expect(
      await codeOf(() =>
        handlers.read_pages({ filePath: "text.pdf", pages: [9999] }),
      ),
    ).toBe("invalid_argument");
  });

  it("refuses cursor combined with an explicit selection", async () => {
    expect(
      await codeOf(() =>
        handlers.read_pages({
          filePath: "text.pdf",
          pages: [1],
          cursor: "whatever",
        }),
      ),
    ).toBe("invalid_argument");
  });
});

describe("document failures", () => {
  it.each([
    ["empty.pdf", "malformed_pdf"],
    ["truncated.pdf", "malformed_pdf"],
    ["garbage.pdf", "malformed_pdf"],
    ["encrypted.pdf", "encrypted_pdf"],
  ])("reports %s as %s", async (filePath, expected) => {
    expect(await codeOf(() => handlers.describe_document({ filePath }))).toBe(
      expected,
    );
  });
});

describe("sandbox", () => {
  it("refuses a path outside the root", async () => {
    expect(
      await codeOf(() =>
        handlers.describe_document({ filePath: inject("fixtures").outside }),
      ),
    ).toBe("path_outside_root");
  });

  it("refuses a traversal", async () => {
    expect(
      await codeOf(() =>
        handlers.describe_document({ filePath: "../outside.pdf" }),
      ),
    ).toBe("path_outside_root");
  });

  it("refuses a non-PDF extension", async () => {
    expect(
      await codeOf(() => handlers.describe_document({ filePath: "notes.txt" })),
    ).toBe("unsupported_extension");
  });

  it("keeps the absolute root out of the error envelope", async () => {
    const result = await handlers.describe_document({
      filePath: "missing.pdf",
    });
    const rendered = JSON.stringify(bodyOf(result));
    expect(result.isError).toBe(true);
    expect(rendered).not.toContain(inject("fixtures").root);
  });
});

describe("payload budget", () => {
  it("keeps every response within the budget", async () => {
    const results = [
      await handlers.list_documents({}),
      await handlers.describe_document({ filePath: "many.pdf" }),
      await handlers.read_pages({ filePath: "many.pdf", maxPages: 50 }),
      await handlers.find_in_document({ filePath: "many.pdf", query: "MARK" }),
    ];
    for (const result of results) {
      expect(bytesOf(result)).toBeLessThanOrEqual(limits.maxPayloadBytes);
    }
  });
});

describe("document cache capacity", () => {
  /**
   * The failure this guards: the server validated documentCacheSize and then
   * dropped the result on the floor, so a configured capacity never reached the
   * store and every deployment ran on the default.
   */
  it("honours the configured capacity instead of the default", async () => {
    const root = await createDocumentRoot(inject("fixtures").root);
    const store = createPdfDocumentStore(root.real, 1);
    await store.load(await resolveDocumentPath(root, "text.pdf"));
    expect(store.size).toBe(1);
    await store.load(await resolveDocumentPath(root, "mixed.pdf"));
    expect(store.size).toBe(1);
  });

  it("keeps both documents when the capacity allows it", async () => {
    const root = await createDocumentRoot(inject("fixtures").root);
    const store = createPdfDocumentStore(root.real, 4);
    await store.load(await resolveDocumentPath(root, "text.pdf"));
    await store.load(await resolveDocumentPath(root, "mixed.pdf"));
    expect(store.size).toBe(2);
  });
});
