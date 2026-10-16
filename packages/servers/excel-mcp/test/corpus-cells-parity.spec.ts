import { readFileSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { CellSnapshot } from "../src/grid/cell-value.js";
import { compareWorkbook, type CellMismatch } from "./fixtures/cell-parity.js";

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

/**
 * Corpus files where the two readers are known to part ways, each with the
 * outcome this reader must keep. A `refused` file is invalid or hostile and is
 * refused on purpose. A `gap` is unsupported today and must still differ, so
 * the entry fails, and has to be removed, the day support lands. An
 * `intended` file differs only in the named way, where SheetJS departs from
 * the standard; every other cell must still agree.
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
  >
> = {
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
