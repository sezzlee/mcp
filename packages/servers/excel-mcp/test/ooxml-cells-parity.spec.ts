import { readFile } from "node:fs/promises";
import { describe, expect, inject, it } from "vitest";
import { compareWorkbook } from "./fixtures/cell-parity.js";

const workbookKeys = [
  "sample",
  "validations",
  "large",
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

describe("the OOXML cell reader agrees with SheetJS", () => {
  it.each(workbookKeys)(
    "builds the same cell snapshots for %s",
    async (key) => {
      const bytes = await readFile(inject("fixtures")[key]);

      expect(compareWorkbook(bytes)).toMatchObject({
        kind: "compared",
        mismatches: [],
      });
    },
  );
});
