import { describe, expect, inject, it } from "vitest";
import ExcelJS from "exceljs";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { collectImages } from "../src/metadata/images.js";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { parseOoxml } from "../src/format/ooxml-workbook.js";
import { createHandlers } from "../src/tools/handlers.js";

function payload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected a text payload");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/2gAAAABJRU5ErkJggg==";

describe("the OOXML image reader agrees with ExcelJS", () => {
  it("reports the same anchors, ranges and extents", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("R");
    const media = workbook.addImage({
      base64: onePixelPng,
      extension: "png",
    });
    sheet.addImage(media, "D2:E6");
    sheet.addImage(media, {
      tl: { col: 0, row: 0 },
      ext: { width: 120, height: 80 },
    });
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    const reference = new ExcelJS.Workbook();
    await reference.xlsx.load(Uint8Array.from(bytes).buffer);
    const referenceSheet = reference.worksheets[0]!;
    const expected = (
      referenceSheet.getImages() as unknown as readonly {
        readonly range?: {
          readonly tl?: { nativeCol: number; nativeRow: number };
          readonly br?: { nativeCol: number; nativeRow: number };
          readonly ext?: { width?: number; height?: number };
        };
      }[]
    ).map((image) => ({
      anchor: image.range?.br === undefined ? "oneCell" : "twoCell",
      fromCol: image.range?.tl?.nativeCol,
      fromRow: image.range?.tl?.nativeRow,
      toCol: image.range?.br?.nativeCol,
      toRow: image.range?.br?.nativeRow,
      widthPx: image.range?.ext?.width,
      heightPx: image.range?.ext?.height,
    }));

    const parsed = parseOoxml(bytes, "images.xlsx");
    const actual = parsed.facts("R").images.map((image) => ({
      anchor: image.anchor,
      fromCol: image.from?.column,
      fromRow: image.from?.row,
      toCol: image.to?.column,
      toRow: image.to?.row,
      widthPx: image.widthPx,
      heightPx: image.heightPx,
    }));

    expect(actual).toEqual(expected);
  });

  it("resolves the media part behind each picture", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("R");
    const media = workbook.addImage({
      base64: onePixelPng,
      extension: "png",
    });
    sheet.addImage(media, "A1:B2");
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const parsed = parseOoxml(bytes, "media.xlsx");
    const report = collectImages("R", parsed.facts("R").images, parsed.media);
    expect(report.count).toBe(1);
    expect(report.images[0]).toMatchObject({
      imageId: 0,
      anchor: "twoCell",
      range: "A1:B2",
      extension: "png",
      sizeBytes: 67,
    });
  });
});

describe("images no longer need the ExcelJS metadata reader", () => {
  for (const file of ["prefixed.xlsx", "unnumbered-sheet.xlsx"]) {
    it(`reads both anchor kinds declared in ${file}`, async () => {
      const fixtures = inject("fixtures");
      const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
      const result = await handlers.get_images({ filePath: file });
      expect(result.isError).not.toBe(true);
      const body = payload(result);
      expect(body).toMatchObject({ sheet: "Veri", count: 2 });
      expect(body["images"]).toEqual([
        {
          imageId: 0,
          anchor: "twoCell",
          range: "D2:E6",
          extension: "png",
          sizeBytes: 67,
          editAs: "oneCell",
          hyperlink: "https://ornek.test/urun",
          tooltip: "Ürün sayfası",
        },
        {
          imageId: 0,
          anchor: "absolute",
          extension: "png",
          sizeBytes: 67,
          widthPx: 120,
          heightPx: 80,
        },
      ]);
    });

    it(`declares images as a capability for ${file}`, async () => {
      const fixtures = inject("fixtures");
      const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
      const body = payload(
        await handlers.describe_workbook({ filePath: file }),
      );
      const capabilities = body["capabilities"] as Record<string, boolean>;
      expect(capabilities["images"]).toBe(true);
      const sheets = body["sheets"] as readonly Record<string, unknown>[];
      expect(sheets[0]?.["imageCount"]).toBe(2);
    });
  }
});

describe("an absolute anchor is reported rather than dropped", () => {
  it("names the anchor kind and omits the range it does not have", async () => {
    const fixtures = inject("fixtures");
    const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
    const body = payload(
      await handlers.get_images({ filePath: "prefixed.xlsx" }),
    );
    const images = body["images"] as readonly Record<string, unknown>[];
    const absolute = images.find((image) => image["anchor"] === "absolute");
    expect(absolute).toBeDefined();
    expect(absolute?.["range"]).toBeUndefined();
    expect(body["limitations"]).toEqual([]);
  });
});
