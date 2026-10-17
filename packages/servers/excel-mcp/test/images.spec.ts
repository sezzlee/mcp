import { describe, expect, inject, it } from "vitest";
import { loadDocument, type LoadedWorkbook } from "../src/format/document.js";
import { collectImages } from "../src/metadata/images.js";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
  type SandboxedPath,
} from "../src/platform/paths.js";

async function pathTo(file: string): Promise<SandboxedPath> {
  const fixtures = inject("fixtures");
  const root = await createWorkbookRoot(fixtures.root);
  return resolveWorkbookPath(root, file);
}

async function loadXlsx(path: SandboxedPath): Promise<LoadedWorkbook> {
  const loaded = await loadDocument(path);
  if (loaded.format !== "xlsx") {
    throw new Error("expected an xlsx fixture");
  }
  return loaded;
}

async function facets(sheet: string) {
  const loaded = await loadXlsx(await pathTo("facets.xlsx"));
  return collectImages(
    sheet,
    loaded.workbook.facts(sheet).images,
    loaded.workbook.media,
  );
}

describe("collectImages", () => {
  it("reports every anchored picture", async () => {
    const report = await facets("Resimler");
    expect(report.count).toBe(2);
    expect(report.truncated).toBe(false);
  });

  it("reports the cells a two-cell anchor occupies, not its exclusive edge", async () => {
    const report = await facets("Resimler");
    const spanning = report.images[0];
    expect(spanning?.anchor).toBe("twoCell");
    expect(spanning?.range).toBe("C3:F8");
    expect("widthPx" in (spanning ?? {})).toBe(false);
    expect("heightPx" in (spanning ?? {})).toBe(false);
  });

  it("reports a one-cell anchor as its top-left cell and size, not as a one-cell range", async () => {
    const report = await facets("Resimler");
    const pinned = report.images[1];
    expect(pinned?.anchor).toBe("oneCell");
    expect(pinned?.cell).toBe("I3");
    expect("range" in (pinned ?? {})).toBe(false);
    expect(pinned?.widthPx).toBe(64);
    expect(pinned?.heightPx).toBe(48);
  });

  it("joins the media entry for the extension and the byte size", async () => {
    const report = await facets("Resimler");
    for (const image of report.images) {
      expect(image.imageId).toBe(0);
      expect(image.extension).toBe("png");
      expect(image.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("invents neither a name nor an alt text, because neither is parsed", async () => {
    const report = await facets("Resimler");
    for (const image of report.images) {
      expect("name" in image).toBe(false);
      expect("descr" in image).toBe(false);
      expect("buffer" in image).toBe(false);
    }
  });

  it("keeps editAs apart from the anchor kind", async () => {
    const report = await facets("Resimler");
    expect(report.images.map((image) => image.editAs)).toEqual([
      "oneCell",
      "oneCell",
    ]);
    expect(report.images.map((image) => image.anchor)).toEqual([
      "twoCell",
      "oneCell",
    ]);
  });

  it("reports an empty list for a sheet with no picture", async () => {
    const report = await facets("Bos");
    expect(report.count).toBe(0);
    expect(report.images).toEqual([]);
  });
});
