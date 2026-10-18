import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv, sniffDelimiter } from "../src/format/csv.js";
import { readRecords } from "../src/format/csv-tokenizer.js";
import { delimiterNames, type CsvOptions } from "../src/platform/delimited.js";
import type { SezzleeExcelError } from "../src/platform/errors.js";
import {
  anyBreak,
  csvParseOracle,
  knownCsvParseDeviation,
  outcomeOf,
} from "./fixtures/csv-oracle.js";

/**
 * Guard: runs only against a local corpus (`SEZZLEE_CORPUS`), never in CI. The
 * corpus is real-world data under licenses that forbid redistribution, so it
 * is read where it lives and nothing from it is written here.
 */
const corpus = process.env["SEZZLEE_CORPUS"];
const roomy = {
  maxColumns: Number.MAX_SAFE_INTEGER,
  maxCells: Number.MAX_SAFE_INTEGER,
};

interface Entry {
  readonly source: string;
  readonly label: string;
  readonly path: string;
  readonly groundTruth: string | undefined;
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
      const truth = "ground_truth" in record ? record.ground_truth : undefined;
      if (typeof file !== "string" || format !== "csv") continue;
      const path = resolve(sourceDir, file);
      const rel = relative(sourceDir, path);
      if (isAbsolute(file) || rel.startsWith(`..${sep}`)) continue;
      entries.push({
        source,
        label: `${source}/${file}`,
        path,
        groundTruth:
          typeof truth === "string" ? resolve(sourceDir, truth) : undefined,
      });
    }
  }
  return entries;
}

/**
 * Decodes a corpus file for the comparison only: both readers receive the same
 * text, so the guess here can make a file harder but never makes them agree.
 */
function decodeForComparison(bytes: Buffer, source: string): string {
  const boms = [
    [[0xef, 0xbb, 0xbf], "utf-8"],
    [[0xff, 0xfe], "utf-16le"],
    [[0xfe, 0xff], "utf-16be"],
  ] as const;
  for (const [bom, encoding] of boms) {
    if (bom.every((byte, index) => bytes[index] === byte))
      return new TextDecoder(encoding).decode(bytes.subarray(bom.length));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder(
      source === "tr-ckan" ? "windows-1254" : "windows-1252",
    ).decode(bytes);
  }
}

function sniffedOrComma(text: string): string {
  try {
    return delimiterNames[sniffDelimiter(text, undefined).delimiter];
  } catch {
    return ",";
  }
}

const entries = corpus === undefined ? [] : entriesOf(corpus);

describe.skipIf(corpus === undefined)(
  "the tokenizer agrees with csv-parse on every corpus CSV",
  () => {
    const deviations = new Map<string, string[]>();

    it.each(
      entries.map(({ label, path, source }) => [label, path, source] as const),
    )(
      "%s",
      (label, path, source) => {
        const text = decodeForComparison(readFileSync(path), source);
        const delimiter = sniffedOrComma(text);
        const expected = csvParseOracle(text, delimiter, anyBreak);
        const actual = outcomeOf(readRecords(text, delimiter, roomy));
        if (JSON.stringify(actual) === JSON.stringify(expected)) return;
        const deviation = knownCsvParseDeviation(text, actual);
        expect(deviation, label).toBeDefined();
        if (deviation !== undefined)
          deviations.set(deviation, [
            ...(deviations.get(deviation) ?? []),
            label,
          ]);
      },
      120_000,
    );

    it("meets only the known csv-parse deviation", () => {
      expect(
        [...deviations.keys()].filter(
          (name) => name !== "NUL after a closing quote",
        ),
      ).toStrictEqual([]);
    });
  },
);

type Expectation =
  | { readonly kind: "refuse"; readonly code: string }
  | { readonly kind: "table"; readonly rows: readonly (readonly string[])[] }
  | {
      readonly kind: "table";
      readonly records: number;
      readonly columns: number;
      readonly first: readonly string[] | null;
      readonly last: readonly string[] | null;
    };

interface SyntheticTruth {
  readonly basis: "constructed" | "contract";
  readonly options: CsvOptions;
  readonly delimiter: string;
  readonly expect: Expectation;
}

async function answer(path: string, options: CsvOptions) {
  const bytes = readFileSync(path);
  try {
    return {
      kind: "table" as const,
      table: await parseCsv(bytes, bytes.length, options, "corpus.csv"),
    };
  } catch (error) {
    return { kind: "refuse" as const, code: (error as SezzleeExcelError).code };
  }
}

describe.skipIf(corpus === undefined)(
  "parseCsv gives the synthetic ground truth",
  () => {
    const synthetic = entries.filter(
      (entry) =>
        entry.source === "csv-synthetic" && entry.groundTruth !== undefined,
    );

    it.each(
      synthetic.map(
        ({ label, path, groundTruth }) =>
          [label, path, groundTruth ?? ""] as const,
      ),
    )(
      "%s",
      async (label, path, truthPath) => {
        const truth = JSON.parse(
          readFileSync(truthPath, "utf8"),
        ) as SyntheticTruth;
        const got = await answer(path, truth.options);
        const expected = truth.expect;
        if (expected.kind === "refuse") {
          expect(got, label).toStrictEqual({
            kind: "refuse",
            code: expected.code,
          });
          return;
        }
        expect(got.kind, label).toBe("table");
        if (got.kind !== "table") return;
        expect(got.table.report.delimiter, label).toBe(truth.delimiter);
        if ("rows" in expected) {
          expect(got.table.rows, label).toStrictEqual(expected.rows);
          return;
        }
        expect(got.table.report.recordCount, label).toBe(expected.records);
        expect(got.table.report.columnCount, label).toBe(expected.columns);
        if (expected.first !== null)
          expect(got.table.rows[0], label).toStrictEqual(expected.first);
        if (expected.last !== null)
          expect(got.table.rows.at(-1), label).toStrictEqual(expected.last);
      },
      120_000,
    );
  },
);

/**
 * csv-spectrum files whose expected reading breaks RFC 4180, with the answer
 * excel-mcp keeps instead.
 */
const spectrumRefusals: Readonly<Record<string, string>> = {
  "csv-spectrum/files/location_coordinates.csv":
    "a quote inside an unquoted field (37°36'37.8\"N); RFC 4180 section 2.5 forbids it",
};

describe.skipIf(corpus === undefined)(
  "parseCsv gives the csv-spectrum ground truth",
  () => {
    const spectrum = entries.filter(
      (entry) =>
        entry.source === "csv-spectrum" && entry.groundTruth !== undefined,
    );

    it.each(
      spectrum.map(
        ({ label, path, groundTruth }) =>
          [label, path, groundTruth ?? ""] as const,
      ),
    )("%s", async (label, path, truthPath) => {
      const bytes = readFileSync(path);
      if (spectrumRefusals[label] !== undefined) {
        expect(await answer(path, {})).toStrictEqual({
          kind: "refuse",
          code: "corrupt_workbook",
        });
        return;
      }
      const objects = JSON.parse(readFileSync(truthPath, "utf8")) as Record<
        string,
        string
      >[];
      const table = await parseCsv(bytes, bytes.length, {}, "spectrum.csv");
      const [header = [], ...body] = table.rows;
      /** Guard: csv-spectrum's git normalises its `*_crlf` files to LF, while the JSON keeps CRLF. */
      const lfOnly = !bytes.includes(0x0d);
      const read = body.map((record) =>
        Object.fromEntries(
          header.map((name, index) => [name, record[index] ?? ""]),
        ),
      );
      const want = objects.map((object) =>
        Object.fromEntries(
          Object.entries(object).map(([key, value]) => [
            key,
            lfOnly ? value.replaceAll("\r\n", "\n") : value,
          ]),
        ),
      );
      expect(read, label).toStrictEqual(want);
    });
  },
);
