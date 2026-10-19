import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { CellSnapshot } from "../src/grid/cell-value.js";
import { compareWorkbook, type CellMismatch } from "./fixtures/cell-parity.js";
import {
  linkedWorkbook,
  richErrorsWorkbook,
  richWorkbook,
} from "./fixtures/rich-workbook.js";

/**
 * Guard: runs only against a local corpus (`SEZZLEE_CORPUS`), never in CI. The
 * corpus is real-world data under licenses that forbid redistribution, so it
 * is read where it lives and nothing from it is written here. SheetJS needs
 * tens of times a file's size in memory, so files over the cap are left to the
 * excel-lab harness, which runs each file in its own process.
 */
const corpus = process.env["SEZZLEE_CORPUS"];
const maxBytes = 10 * 1024 * 1024;

type Tolerance = "line-endings" | "default-style";

const fixedWorkbooks = {
  rich: richWorkbook,
  linked: linkedWorkbook,
  errors: richErrorsWorkbook,
};

/**
 * Corpus files where the two readers are known to part ways, each with the
 * outcome this reader must keep. A `refused` file is invalid or hostile and is
 * refused on purpose. A `gap` is unsupported today and must still differ, so
 * the entry fails, and has to be removed, the day support lands. An
 * `intended` file differs only in the named way, where SheetJS departs from
 * the standard; every other cell must still agree. A `fixture` pins all
 * mismatch locations for independently generated, checksum-locked CI bytes;
 * it cannot authorize a difference in an external corpus workbook. Exact
 * snapshot values are checked separately in rich-differential.spec.ts.
 */
const divergences: Readonly<
  Record<
    string,
    | { readonly kind: "refused" | "gap"; readonly why: string }
    | {
        readonly kind: "intended";
        readonly tolerate: Tolerance;
        readonly why: string;
      }
    | {
        readonly kind: "fixture";
        readonly fixture: keyof typeof fixedWorkbooks;
        readonly sha256: string;
        readonly differences: Readonly<Record<string, string>>;
        readonly why: string;
      }
  >
> = {
  "test/fixtures/rich-values.xlsx.base64": {
    kind: "fixture",
    fixture: "rich",
    sha256: "b29d5664bfebd138af4f55135b4470e682065cb0a2fcbfce5a680e5f5c6ff9e3",
    differences: {
      "describe:Rich:imageCount":
        "two in-cell images supplement drawing images",
      "facts:Rich:images":
        "in-cell positions and accessibility text come from the verified rich relationship chain",
      "cell:Rich:A2":
        "the local image and its saved alternative text replace the #VALUE! compatibility cache",
      "cell:Rich:A3":
        "the local decorative image replaces the #VALUE! compatibility cache",
      "cell:Rich:C2":
        "the saved dynamic-array anchor, range and collapsed flag supplement the unchanged cached formula result",
      "cell:Rich:C3":
        "the saved result belongs to the C2:C4 array without any recalculation",
      "cell:Rich:C4":
        "the saved result belongs to the C2:C4 array without any recalculation",
    },
    why: "XlsxWriter fixed bytes have independent ZIP/XML expectations. Raw SheetJS retains F/D; its historical cell projection omits array metadata. Native fraction meaning and elapsed serial-to-seconds differences use the narrow cell-parity counters and independent format tests.",
  },
  "test/fixtures/linked-seattle.xlsx.base64": {
    kind: "fixture",
    fixture: "linked",
    sha256: "537a61c16e9c09a33d405e5f828d0e17b9462a69396e42203cc77706e63c6a12",
    differences: {
      "cell:Linked:A1":
        "the directly referenced _linkedentity2 record supplies the cached Seattle label and identifiers instead of #VALUE!; no nested data or refresh is inferred",
    },
    why: "Exact-source Microsoft OpenXML SDK bytes and an independent ZIP/XML oracle verify the metadata1.xml relationship and directly referenced record.",
  },
  "test/fixtures/rich-errors.xlsx.base64": {
    kind: "fixture",
    fixture: "errors",
    sha256: "9ee3db1974c3bebed188a0e098815806bae179a6b6dca0c453ea01c80b7cdaa1",
    differences: {
      "describe:Rich:imageCount":
        "the original two in-cell images remain present",
      "facts:Rich:images":
        "the original verified image relationships remain present",
      "cell:Rich:A2":
        "the original local image replaces its compatibility cache",
      "cell:Rich:A3":
        "the original decorative image replaces its compatibility cache",
      "cell:Rich:C2":
        "the original saved dynamic-array anchor and range remain present",
      "cell:Rich:C3":
        "the original cached array member remains associated with C2:C4",
      "cell:Rich:C4":
        "the original cached array member remains associated with C2:C4",
      "cell:Rich:E5":
        "the spec-defined _error errorType 8 resolves #SPILL! from a #VALUE! compatibility cache",
      "cell:Rich:E6":
        "the spec-defined _error errorType 13 resolves #CALC! from a #VALUE! compatibility cache",
    },
    why: "A labeled specification-derived mutation preserves the original image/array controls. Direct #SPILL!/#CALC! caches in F5/F6 must still agree exactly, as must every unlisted cell and workbook fact.",
  },
  "apache-testdata/files/poi/spreadsheet/poc-xmlbomb-empty.xlsx": {
    kind: "refused",
    why: "its shared string table declares an entity-expansion DOCTYPE",
  },
  "apache-testdata/files/poi/spreadsheet/poc-shared-strings.xlsx": {
    kind: "refused",
    why: "it numbers a row 0; rows start at 1",
  },
  "us-datagov/files/xlsx/Demand_Charge_Rate_Data-May2026_1-497a044a.xlsx": {
    kind: "intended",
    tolerate: "line-endings",
    why: "raw line breaks in XML text are normalised to LF, as XML 1.0 §2.11 requires and SheetJS skips",
  },
  "tr-ckan/files/ordu/ordu-ili-gulyali-ilcesi-mahalle-nufuslari__0590787d.xlsx":
    {
      kind: "intended",
      tolerate: "default-style",
      why: "a cell without `s` takes cell format 0, as ECMA-376 says; SheetJS gives it General",
    },
  "tr-ckan/files/ordu/ordu-ili-gurgentepe-ilcesi-mahalle-nufuslari__4e2dc915.xlsx":
    {
      kind: "intended",
      tolerate: "default-style",
      why: "a cell without `s` takes cell format 0, as ECMA-376 says; SheetJS gives it General",
    },
  "tr-ckan/files/ordu/ordu-ili-mesudiye-ilcesi-mahalle-nufuslari__a462e152.xlsx":
    {
      kind: "intended",
      tolerate: "default-style",
      why: "a cell without `s` takes cell format 0, as ECMA-376 says; SheetJS gives it General",
    },
};

function locationOf(mismatch: CellMismatch): string {
  if (mismatch.kind === "sheets") return "sheets";
  if (mismatch.kind === "cell") return `cell:${mismatch.sheet}:${mismatch.at}`;
  return `${mismatch.kind}:${mismatch.sheet}:${mismatch.field}`;
}

describe("fixed modern workbook divergence boundaries", () => {
  const fixtures = Object.entries(divergences).flatMap(([label, divergence]) =>
    divergence.kind === "fixture" ? [{ label, ...divergence }] : [],
  );
  it.each(fixtures)("$label", ({ fixture, sha256, differences }) => {
    const bytes = fixedWorkbooks[fixture]();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    const comparison = compareWorkbook(bytes, Number.MAX_SAFE_INTEGER);
    expect(comparison.kind).toBe("compared");
    if (comparison.kind !== "compared") return;
    expect(comparison.mismatches.map(locationOf).sort()).toEqual(
      Object.keys(differences).sort(),
    );
  });
});

function withoutCarriageReturns(snapshot: CellSnapshot | null): unknown {
  return JSON.parse(JSON.stringify(snapshot).replaceAll("\\r", ""));
}

function tolerated(tolerance: Tolerance, mismatch: CellMismatch): boolean {
  if (mismatch.kind !== "cell") return false;
  const { ours, theirs } = mismatch;
  switch (tolerance) {
    case "line-endings":
      return isDeepStrictEqual(
        withoutCarriageReturns(ours),
        withoutCarriageReturns(theirs),
      );
    case "default-style":
      return (
        ours !== null &&
        theirs?.numberFormat === "General" &&
        isDeepStrictEqual({ ...ours, numberFormat: "General" }, theirs)
      );
    default: {
      const _exhaustive: never = tolerance;
      return _exhaustive;
    }
  }
}

interface Entry {
  readonly label: string;
  readonly path: string;
}

function entriesOf(root: string): readonly Entry[] {
  const entries: Entry[] = [];
  for (const source of readdirSync(root).sort()) {
    if (source.startsWith("_") || source.startsWith(".")) continue;
    const sourceDir = join(root, source);
    let manifest: string;
    try {
      manifest = readFileSync(join(sourceDir, "manifest.jsonl"), "utf8");
    } catch {
      continue;
    }
    for (const line of manifest.split("\n")) {
      if (line.trim() === "") continue;
      const record: unknown = JSON.parse(line);
      if (typeof record !== "object" || record === null) continue;
      const file = "file" in record ? record.file : undefined;
      const format = "format" in record ? record.format : undefined;
      const bytes = "bytes" in record ? record.bytes : undefined;
      if (typeof file !== "string" || typeof bytes !== "number") continue;
      if (format !== "xlsx" && format !== "xlsm") continue;
      if (bytes > maxBytes) continue;
      const path = resolve(sourceDir, file);
      const rel = relative(sourceDir, path);
      if (isAbsolute(file) || rel.startsWith(`..${sep}`)) continue;
      entries.push({ label: `${source}/${file}`, path });
    }
  }
  return entries;
}

describe.skipIf(corpus === undefined)(
  "the OOXML cell reader agrees with SheetJS on the corpus",
  () => {
    const entries = corpus === undefined ? [] : entriesOf(corpus);

    it.each(entries.map(({ label, path }) => [label, path] as const))(
      "%s",
      async (label, path) => {
        const bytes = await readFile(path);
        const divergence = divergences[label];
        if (divergence?.kind === "fixture") {
          throw new Error(
            "A fixed CI fixture policy cannot waive an external corpus mismatch.",
          );
        }
        if (divergence?.kind === "refused") {
          expect(() => compareWorkbook(bytes, 5)).toThrow(
            expect.objectContaining({ code: "corrupt_workbook" }),
          );
          return;
        }
        if (divergence?.kind === "intended") {
          const comparison = compareWorkbook(bytes, Number.MAX_SAFE_INTEGER);
          if (comparison.kind === "reference_refused") return;
          expect(comparison.mismatches).not.toEqual([]);
          expect(
            comparison.mismatches.filter(
              (mismatch) => !tolerated(divergence.tolerate, mismatch),
            ),
          ).toEqual([]);
          return;
        }
        const comparison = compareWorkbook(bytes, 5);
        if (comparison.kind === "reference_refused") return;
        if (divergence?.kind === "gap") {
          expect(comparison.mismatches).not.toEqual([]);
          return;
        }
        expect(comparison.mismatches).toEqual([]);
      },
      120_000,
    );
  },
);
