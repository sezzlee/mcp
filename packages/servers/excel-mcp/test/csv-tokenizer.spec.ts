import { describe, expect, it } from "vitest";
import { readRecords, type CsvFault } from "../src/format/csv-tokenizer.js";
import {
  anyBreak,
  csvParseOracle as oracle,
  knownCsvParseDeviation,
  outcomeOf as outcome,
} from "./fixtures/csv-oracle.js";

const roomy = { maxColumns: 1_000_000, maxCells: 1_000_000 };

function records(text: string, delimiter = ","): string[][] | CsvFault {
  const result = readRecords(text, delimiter, roomy);
  return result.kind === "records" ? result.records : result.fault;
}

describe("RFC 4180 records", () => {
  it.each([
    ["no input", "", []],
    ["one record without a line break", "a,b", [["a", "b"]]],
    ["a final line break adds no record", "a,b\n", [["a", "b"]]],
    [
      "CRLF records",
      "a,b\r\nc,d\r\n",
      [
        ["a", "b"],
        ["c", "d"],
      ],
    ],
    [
      "CR-only records",
      "a,b\rc,d\r",
      [
        ["a", "b"],
        ["c", "d"],
      ],
    ],
    [
      "a blank line is a record of one empty field",
      "a\n\nb\n",
      [["a"], [""], ["b"]],
    ],
    ["a lone line break", "\n", [[""]]],
    ["two final line breaks", "a\n\n", [["a"], [""]]],
    ["an empty last field", "a,b,\n", [["a", "b", ""]]],
    ["a delimiter at the end of the text", "a,", [["a", ""]]],
    ["only a delimiter", ",\n", [["", ""]]],
    [
      "quoted delimiter and line breaks",
      '"a,b","c\nd","e\r\nf"\n',
      [["a,b", "c\nd", "e\r\nf"]],
    ],
    ["doubled quotes", '"a""b","""",""\n', [['a"b', '"', ""]]],
    ["a quoted field at the end of the text", '"a"', [["a"]]],
    [
      "records of different widths",
      "a,b,c\n1\n1,2,3,4\n",
      [["a", "b", "c"], ["1"], ["1", "2", "3", "4"]],
    ],
    ["spaces are data", " a , b \n", [[" a ", " b "]]],
    ["NUL is data", "a,\u0000b\n", [["a", "\u0000b"]]],
  ] as const)("%s", (_, text, expected) => {
    expect(records(text)).toStrictEqual(expected);
  });

  it.each([
    [";", "a;b,c\n", [["a", "b,c"]]],
    ["\t", "a\tb\n", [["a", "b"]]],
    ["|", '"a|b"|c\n', [["a|b", "c"]]],
  ] as const)("splits on %j only", (delimiter, text, expected) => {
    expect(records(text, delimiter)).toStrictEqual(expected);
  });
});

describe("line breaks that mix outside quotes", () => {
  it.each([
    ["CRLF then LF", "a,b\r\nc,d\ne,f\r\n"],
    ["LF then CRLF", "a,b\nc,d\r\ne,f\n"],
    ["CR then CRLF then LF", "a,b\rc,d\r\ne,f\n"],
  ])("ends a record at every break: %s", (_, text) => {
    expect(records(text)).toStrictEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });
});

describe("the line break form of the records", () => {
  it.each([
    ["no line break", "a,b", "none"],
    ["LF", "a\nb\n", "lf"],
    ["CRLF", "a\r\nb", "crlf"],
    ["CR", "a\rb\r", "cr"],
    ["LF inside quotes of a CRLF file", 'a\r\n"b\nc"\r\n', "crlf"],
    ["CRLF inside quotes of an LF file", '"a\r\nb"\nc\n', "lf"],
    ["only inside quotes", '"a\nb"', "none"],
    ["CRLF then LF", "a\r\nb\nc", "mixed"],
  ] as const)("%s", (_, text, expected) => {
    expect(readRecords(text, ",", roomy)).toMatchObject({
      kind: "records",
      lineBreak: expected,
    });
  });
});

describe("malformed quoting is refused, never repaired", () => {
  it.each([
    [
      "a quote inside an unquoted field",
      'a,b"c\n',
      { kind: "stray_quote", line: 1 },
    ],
    [
      "a space before the opening quote",
      'a, "b"\n',
      { kind: "stray_quote", line: 1 },
    ],
    [
      "text after the closing quote",
      'x\n"a"b,c\n',
      { kind: "text_after_quote", line: 2 },
    ],
    [
      "a space after the closing quote",
      '"a" ,c\n',
      { kind: "text_after_quote", line: 1 },
    ],
    [
      "text after a quoted empty field",
      '""a\n',
      { kind: "text_after_quote", line: 1 },
    ],
    [
      "a quote that never closes, reported where it opened",
      'a\nb,"c\nd\n',
      { kind: "unclosed_quote", line: 2 },
    ],
    [
      "a doubled quote at the end of the text",
      '"a""',
      { kind: "unclosed_quote", line: 1 },
    ],
    [
      "a NUL after the closing quote",
      '"a"\u0000,b\n',
      { kind: "text_after_quote", line: 1 },
    ],
  ] as const)("%s", (_, text, expected) => {
    expect(records(text)).toStrictEqual(expected);
  });
});

describe("budget", () => {
  it("allows a record of exactly maxColumns fields and refuses one more", () => {
    const budget = { maxColumns: 3, maxCells: 100 };
    expect(readRecords("a,b,c\n", ",", budget).kind).toBe("records");
    expect(readRecords("x\na,b,c,d\n", ",", budget)).toStrictEqual({
      kind: "fault",
      fault: { kind: "too_many_columns", line: 2 },
    });
    expect(readRecords('"a,b",c,"d\ne",f\n', ",", budget)).toMatchObject({
      fault: { kind: "too_many_columns" },
    });
  });

  it("counts a blank record as one cell", () => {
    const budget = { maxColumns: 10, maxCells: 4 };
    expect(readRecords("a,b\n\n\n", ",", budget).kind).toBe("records");
    expect(readRecords("a,b\n\n\n\n", ",", budget)).toMatchObject({
      fault: { kind: "too_many_cells" },
    });
  });
});

/** mulberry32, so every run explores the same inputs and a failure replays. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const breaks = ["\n", "\r\n", "\r"] as const;
const delimiters = [",", ";", "\t", "|"] as const;

function pick<T>(items: readonly T[], next: () => number): T {
  const item = items[Math.floor(next() * items.length)];
  if (item === undefined) throw new Error("empty choice");
  return item;
}

/**
 * Records of plain, quoted and raw fields. Every line break form is drawn
 * independently, inside quotes and out, and raw pieces put quotes and NUL
 * where they do not belong.
 */
function generate(next: () => number): { text: string; delimiter: string } {
  const delimiter = pick(delimiters, next);
  const plain = ["a", "bc", " ", "1", "é", "\u{1F600}", "", "\u0000"];
  const quoted = [...plain, '""', ",", ";", "\t", "|", ...breaks];
  const raw = ['"', '""', " ", "a", "\u0000", delimiter, ...breaks];
  let text = "";
  const recordCount = 1 + Math.floor(next() * 4);
  for (let record = 0; record < recordCount; record += 1) {
    const fieldCount = 1 + Math.floor(next() * 4);
    for (let field = 0; field < fieldCount; field += 1) {
      if (field > 0) text += delimiter;
      const shape = next();
      if (shape < 0.45) {
        text += pick(plain, next) + pick(plain, next);
      } else if (shape < 0.85) {
        let content = "";
        for (let piece = Math.floor(next() * 4); piece > 0; piece -= 1)
          content += pick(quoted, next);
        text += `"${content}"`;
      } else {
        for (let piece = 1 + Math.floor(next() * 3); piece > 0; piece -= 1)
          text += pick(raw, next);
      }
    }
    if (record < recordCount - 1 || next() < 0.5) text += pick(breaks, next);
  }
  return { text, delimiter };
}

describe("differential fuzzing against csv-parse", () => {
  it("reads every generated text as csv-parse does when every line break ends a record", () => {
    const next = random(0xc5a1e);
    const disagreements: string[] = [];
    const deviations = new Map<string, number>();
    const seen = new Set<string>();
    for (let round = 0; round < 20_000; round += 1) {
      const { text, delimiter } = generate(next);
      const expected = oracle(text, delimiter, anyBreak);
      const actual = outcome(readRecords(text, delimiter, roomy));
      seen.add(typeof expected === "string" ? expected : "records");
      if (JSON.stringify(actual) === JSON.stringify(expected)) continue;
      const deviation = knownCsvParseDeviation(text, actual);
      if (deviation !== undefined) {
        deviations.set(deviation, (deviations.get(deviation) ?? 0) + 1);
        continue;
      }
      disagreements.push(
        `${JSON.stringify(text)} ${JSON.stringify(delimiter)}: csv-parse ${JSON.stringify(expected)}, ours ${JSON.stringify(actual)}`,
      );
    }
    expect(disagreements.slice(0, 20)).toStrictEqual([]);
    expect([...seen].sort()).toStrictEqual([
      "records",
      "stray_quote",
      "text_after_quote",
      "unclosed_quote",
    ]);
    expect([...deviations.keys()]).toStrictEqual(["NUL after a closing quote"]);
  }, 30_000);

  it.each([
    ["CRLF then LF", "a,b\r\nc,d\ne,f\r\n"],
    ["LF then CRLF", "a,b\nc,d\r\ne,f\n"],
    ["CR then CRLF then LF", "a\rb\r\nc\n"],
  ])(
    "departs from csv-parse's default, which keeps the first line break form: %s",
    (_, text) => {
      const ours = outcome(readRecords(text, ",", roomy));
      expect(ours).toStrictEqual(oracle(text, ",", anyBreak));
      expect(ours).not.toStrictEqual(oracle(text, ","));
    },
  );
});
