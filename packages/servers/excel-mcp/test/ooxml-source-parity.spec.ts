import { readFile } from "node:fs/promises";
import * as XLSX from "@e965/xlsx";
import { describe, expect, inject, it } from "vitest";
import { openPackage } from "../src/metadata/spreadsheetml/package.js";
import { zipSource } from "../src/metadata/spreadsheetml/reader.js";
import { sheetJsSource } from "./fixtures/sheetjs/source.js";

const fixtures = () => inject("fixtures");

/**
 * SheetJS hands back a Buffer and the zip reader a Uint8Array. Buffer is a
 * subclass, so a strict comparison would fail on the prototype while the bytes
 * agree; the contract promises bytes, not a constructor.
 */
function plain(bytes: Uint8Array | undefined): number[] | undefined {
  return bytes === undefined ? undefined : Array.from(bytes);
}

const workbookKeys = [
  "sample",
  "validations",
  "empty",
  "longStrings",
  "wide",
  "turkish",
  "parity",
  "analysis",
  "titleBand",
  "facets",
  "prefixed",
  "unnumberedSheet",
] as const;

async function bothSources(path: string) {
  const bytes = await readFile(path);
  const book = XLSX.read(bytes, {
    type: "buffer",
    bookFiles: true,
    dense: true,
  });
  return { viaSheetJs: sheetJsSource(book), viaZip: zipSource(bytes) };
}

/**
 * The zip reader and SheetJS's own unzip are two independent implementations
 * over the same archives. Agreement across every fixture workbook is what earns
 * the switch, and keeping this spec after the switch is what stops the two
 * drifting apart.
 */
describe.each(workbookKeys)("%s.xlsx reads the same both ways", (key) => {
  it("indexes the same parts at the same sizes", async () => {
    const { viaSheetJs, viaZip } = await bothSources(fixtures()[key]);
    const shape = (source: {
      entries: readonly { path: string; sizeBytes: number }[];
    }) =>
      [...source.entries]
        .map((entry) => `${entry.path}:${String(entry.sizeBytes)}`)
        .sort();
    expect(shape(viaZip)).toStrictEqual(shape(viaSheetJs));
  });

  it("returns byte-identical parts", async () => {
    const { viaSheetJs, viaZip } = await bothSources(fixtures()[key]);
    for (const entry of viaSheetJs.entries) {
      expect(plain(viaZip.read(entry.path)), entry.path).toStrictEqual(
        plain(viaSheetJs.read(entry.path)),
      );
    }
  });

  it("opens to the same package shape", async () => {
    const { viaSheetJs, viaZip } = await bothSources(fixtures()[key]);
    const fromSheetJs = openPackage(viaSheetJs);
    const fromZip = openPackage(viaZip);
    expect([...fromZip.sheetParts.entries()].sort()).toStrictEqual(
      [...fromSheetJs.sheetParts.entries()].sort(),
    );
    expect(fromZip.mediaParts).toStrictEqual(fromSheetJs.mediaParts);
    for (const [name, part] of fromSheetJs.sheetParts) {
      expect(fromZip.part(part), name).toBe(fromSheetJs.part(part));
      expect(
        [...fromZip.relationshipsFor(part).entries()].sort(),
        name,
      ).toStrictEqual([...fromSheetJs.relationshipsFor(part).entries()].sort());
    }
  });
});
