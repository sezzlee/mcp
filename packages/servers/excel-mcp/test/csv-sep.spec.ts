import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseCsv } from "../src/format/csv.js";
import type { CsvOptions } from "../src/platform/delimited.js";
import { createWorkbookRoot } from "../src/platform/paths.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

function parse(text: string, options: CsvOptions = {}) {
  const bytes = Buffer.from(text, "utf8");
  return parseCsv(bytes, bytes.length, options, "sep.csv");
}

describe("CSV first-line separator declarations", () => {
  it.each([
    { text: "sep=,\nA,B\n1,2", delimiter: "comma" },
    { text: '"sep=,"\nA,B\n1,2', delimiter: "comma" },
    { text: "SEP=;\nA;B\n1;2", delimiter: "semicolon" },
    { text: '"SeP=;"\nA;B\n1;2', delimiter: "semicolon" },
    { text: "sEp=\t\nA\tB\n1\t2", delimiter: "tab" },
    { text: '"sep=\t"\nA\tB\n1\t2', delimiter: "tab" },
    { text: "seP=|\nA|B\n1|2", delimiter: "pipe" },
    { text: '"SEP=|"\nA|B\n1|2', delimiter: "pipe" },
  ])("recognizes $delimiter in $text", async ({ text, delimiter }) => {
    const table = await parse(text);
    expect(table.rows).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
    expect(table.report).toMatchObject({
      delimiter,
      delimiterSource: "sep",
      recordCount: 2,
      columnCount: 2,
      raggedRecordCount: 0,
    });
  });

  it("uses the declaration when the data alone has tied delimiters", async () => {
    const table = await parse("sep=;\na;b,c\n1;2,3");
    expect(table.rows).toEqual([
      ["a", "b,c"],
      ["1", "2,3"],
    ]);
    expect(table.report.delimiterSource).toBe("sep");
  });

  it("keeps an explicit delimiter and reports a conflicting omitted declaration", async () => {
    const table = await parse("sep=;\nA,B\n1,2", { delimiter: "comma" });
    expect(table.rows).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
    expect(table.report).toMatchObject({
      delimiter: "comma",
      delimiterSource: "explicit",
      warnings: [
        {
          code: "csv_preamble_ignored",
          message:
            "The CSV sep= preamble declares 'semicolon', but explicit delimiter 'comma' takes precedence. The preamble was omitted.",
        },
      ],
    });
  });

  it("keeps the explicit source without a conflict warning when delimiters agree", async () => {
    const table = await parse("sep=;\nA;B\n1;2", {
      delimiter: "semicolon",
    });
    expect(table.rows).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
    expect(table.report.delimiterSource).toBe("explicit");
    expect(table.report.warnings).toBeUndefined();
  });

  it("excludes the declaration from header and record diagnostics", async () => {
    const table = await parse("sep=;\r\nA;A;Note\r\n1;2;=1+1\r\n\r\n3;4\r\n");
    expect(table.rows).toEqual([
      ["A", "A", "Note"],
      ["1", "2", "=1+1"],
      [],
      ["3", "4"],
    ]);
    expect(table.bounds).toEqual({ top: 1, left: 1, bottom: 4, right: 3 });
    expect(table.report).toMatchObject({
      recordCount: 4,
      columnCount: 3,
      duplicateHeaders: ["A"],
      blankRecordCount: 1,
      raggedRecordCount: 1,
      formulaLikeCellCount: 1,
    });
  });

  it("preserves a blank first data record and both applicable warnings", async () => {
    const table = await parse("sep=;\r\n\r\nA,B\r\n1,2\r\n", {
      delimiter: "comma",
    });
    expect(table.rows).toEqual([[], ["A", "B"], ["1", "2"]]);
    expect(table.report).toMatchObject({
      recordCount: 3,
      blankRecordCount: 1,
    });
    expect(table.report.warnings).toEqual([
      {
        code: "csv_preamble_ignored",
        message:
          "The CSV sep= preamble declares 'semicolon', but explicit delimiter 'comma' takes precedence. The preamble was omitted.",
      },
      {
        code: "csv_blank_first_record",
        message:
          "The first CSV record is blank and remains the default header. Physical records are preserved; pass headerRow to select a different header.",
      },
    ]);
  });

  it.each([
    { text: "sep=:\nName\nAda", first: "sep=:" },
    { text: " sep=;\nName\nAda", first: " sep=;" },
    { text: "sep=; \nName\nAda", first: "sep=; " },
    { text: "sep=\\t\nName\nAda", first: "sep=\\t" },
    { text: "sep=||\nName\nAda", first: "sep=||" },
    { text: "ſep=;\nName\nAda", first: "ſep=;" },
    { text: '"sep=; "\nName\nAda', first: "sep=; " },
    { text: '"sep=;\ncontinued"\nName\nAda', first: "sep=;\ncontinued" },
  ])("preserves the first field in $text", async ({ text, first }) => {
    const table = await parse(text, { delimiter: "comma" });
    expect(table.rows).toEqual([[first], ["Name"], ["Ada"]]);
    expect(table.report.warnings).toBeUndefined();
  });

  it("does not remove a declaration-shaped later record", async () => {
    const table = await parse("Name\nsep=;\nAda", { delimiter: "comma" });
    expect(table.rows).toEqual([["Name"], ["sep=;"], ["Ada"]]);
  });

  it("consumes only the first declaration", async () => {
    const table = await parse("sep=;\nsep=;\nAda");
    expect(table.rows).toEqual([["sep=", ""], ["Ada"]]);
    expect(table.report.recordCount).toBe(2);
  });

  it("leaves invalid quote syntax to the CSV error contract", async () => {
    await expect(parse('"sep=;"x\nName\nAda')).rejects.toMatchObject({
      code: "corrupt_workbook",
      message: expect.stringContaining("text after a closing quote on line 1"),
    });
  });
});

describe("separator declarations after decoding", () => {
  it.each([
    {
      name: "UTF-8 BOM",
      hex: "efbbbf7365703d3b0a413b420a313b32",
      options: {},
      encoding: "utf-8",
      encodingSource: "bom",
      hadBom: true,
    },
    {
      name: "UTF-16LE BOM",
      hex: "fffe7300650070003d003b000a0041003b0042000a0031003b003200",
      options: {},
      encoding: "utf-16le",
      encodingSource: "bom",
      hadBom: true,
    },
    {
      name: "UTF-16BE BOM",
      hex: "feff007300650070003d003b000a0041003b0042000a0031003b0032",
      options: {},
      encoding: "utf-16be",
      encodingSource: "bom",
      hadBom: true,
    },
    {
      name: "explicit UTF-16LE without BOM",
      hex: "7300650070003d003b000a0041003b0042000a0031003b003200",
      options: { encoding: "utf-16le" },
      encoding: "utf-16le",
      encodingSource: "explicit",
      hadBom: false,
    },
  ] as const)("recognizes $name", async (vector) => {
    const bytes = Buffer.from(vector.hex, "hex");
    const table = await parseCsv(
      bytes,
      bytes.length,
      vector.options,
      "bom.csv",
    );
    expect(table.rows).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
    expect(table.report).toMatchObject({
      delimiter: "semicolon",
      delimiterSource: "sep",
      encoding: vector.encoding,
      encodingSource: vector.encodingSource,
      hadBom: vector.hadBom,
    });
  });

  it("recognizes an explicitly decoded legacy file without altering text or identifiers", async () => {
    const bytes = Buffer.from(
      "7365703d3b0a4e616d653b49640acff0e8e2e5f23b3030313233",
      "hex",
    );
    const table = await parseCsv(
      bytes,
      bytes.length,
      { encoding: "windows-1251" },
      "legacy.csv",
    );
    expect(table.rows).toEqual([
      ["Name", "Id"],
      ["Привет", "00123"],
    ]);
    expect(table.report).toMatchObject({
      delimiterSource: "sep",
      encoding: "windows-1251",
      encodingSource: "explicit",
    });
  });
});

describe("separator declarations and physical line information", () => {
  it.each([
    { text: "sep=;\nA;B", lineBreak: "lf" },
    { text: "sep=;\r\nA;B", lineBreak: "crlf" },
    { text: "sep=;\rA;B", lineBreak: "cr" },
    { text: "sep=;\r\nA;B\n1;2", lineBreak: "mixed" },
    { text: "sep=;\rA;B\r\n1;2", lineBreak: "mixed" },
    { text: 'sep=;\nA;B\n"one\r\ntwo";x\n', lineBreak: "lf" },
  ])("preserves record break classification in $text", async (vector) => {
    expect((await parse(vector.text)).report.lineBreak).toBe(vector.lineBreak);
  });

  it.each([
    { text: "sep=;", lineBreak: "none" },
    { text: '"SEP=;"\r\n', lineBreak: "crlf" },
  ])("treats declaration-only $text as an empty table", async (vector) => {
    const table = await parse(vector.text);
    expect(table.rows).toEqual([]);
    expect(table.bounds).toBeUndefined();
    expect(table.report).toMatchObject({
      delimiter: "semicolon",
      delimiterSource: "sep",
      lineBreak: vector.lineBreak,
      recordCount: 0,
      columnCount: 0,
      blankRecordCount: 0,
    });
  });

  it.each([
    {
      text: 'sep=;\r\nA;B\r\n1;x"y\r\n',
      message: "a quote inside an unquoted field on line 3",
    },
    {
      text: 'sep=;\nA;B\n1;"x"y\n',
      message: "text after a closing quote on line 3",
    },
    {
      text: 'sep=;\rA;B\r1;"x',
      message: "a quote opened on line 3 never closes",
    },
    {
      text: 'sep=;\nA;B\n1;"x\nmore"\n2;y"z',
      message: "a quote inside an unquoted field on line 5",
    },
  ])("reports the original physical line: $message", async (vector) => {
    await expect(parse(vector.text)).rejects.toMatchObject({
      code: "corrupt_workbook",
      message: expect.stringContaining(vector.message),
    });
  });
});

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  expect(result.isError, content.text.slice(0, 300)).not.toBe(true);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(content.text));
}

function errorCode(result: CallToolResult): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON error");
  expect(result.isError).toBe(true);
  return z.object({ error: z.string() }).parse(JSON.parse(content.text)).error;
}

describe("separator declarations through public handlers", () => {
  let directory: string;
  let handlers: ToolHandlers;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "excel-csv-sep-"));
    await writeFile(
      join(directory, "declared.csv"),
      "sep=;\nCode;Amount\n001;10\n002;20\n003;30\n",
    );
    await writeFile(
      join(directory, "override.csv"),
      "sep=;\nCode,Amount\n001,10\n002,20\n",
    );
    await writeFile(
      join(directory, "changing.csv"),
      "sep=;\nCode;Amount\n001;10\n002;20\n",
    );
    handlers = createHandlers(await createWorkbookRoot(directory));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("pages logical data rows while retaining the implicit sep source", async () => {
    let page = body(
      await handlers.read_sheet({ filePath: "declared.csv", maxCells: 2 }),
    );
    expect(page["columns"]).toMatchObject([
      { header: "Code" },
      { header: "Amount" },
    ]);
    for (const expected of [
      ["001", "10"],
      ["002", "20"],
      ["003", "30"],
    ]) {
      expect(page["values"]).toEqual([expected]);
      expect(page["csv"]).toMatchObject({
        delimiter: "semicolon",
        delimiterSource: "sep",
        recordCount: 4,
      });
      if (expected[0] === "003") {
        expect(page["nextCursor"]).toBeUndefined();
      } else {
        page = body(
          await handlers.read_sheet({
            filePath: "declared.csv",
            maxCells: 2,
            cursor: z.string().parse(page["nextCursor"]),
          }),
        );
      }
    }
  });

  it("uses post-declaration headers and addresses for aggregates and search", async () => {
    const aggregate = body(
      await handlers.aggregate_sheet({
        filePath: "declared.csv",
        columns: [{ column: "Amount", type: "number", decimal: "." }],
        metrics: [{ fn: "sum", column: "Amount" }, { fn: "count" }],
      }),
    );
    expect(aggregate["rows"]).toEqual([[60, 3]]);
    expect(aggregate["csv"]).toMatchObject({ delimiterSource: "sep" });
    const found = body(
      await handlers.find_in_sheet({
        filePath: "declared.csv",
        query: "002",
        matchMode: "exact",
      }),
    );
    expect(found["matches"]).toEqual([
      { address: "A3", row: 3, column: 1, value: "002" },
    ]);
  });

  it("inherits an explicit override and refuses a conflicting cursor option", async () => {
    const first = body(
      await handlers.read_sheet({
        filePath: "override.csv",
        delimiter: "comma",
        maxCells: 2,
      }),
    );
    expect(first["values"]).toEqual([["001", "10"]]);
    const cursor = z.string().parse(first["nextCursor"]);
    const second = body(
      await handlers.read_sheet({ filePath: "override.csv", cursor }),
    );
    expect(second["values"]).toEqual([["002", "20"]]);
    expect(second["csv"]).toMatchObject({
      delimiter: "comma",
      delimiterSource: "explicit",
      warnings: [
        expect.objectContaining({
          code: "csv_preamble_ignored",
          message: expect.stringContaining("explicit delimiter 'comma'"),
        }),
      ],
    });
    expect(
      errorCode(
        await handlers.read_sheet({
          filePath: "override.csv",
          delimiter: "semicolon",
          cursor,
        }),
      ),
    ).toBe("invalid_argument");
  });

  it("rejects a stale cursor when a declared CSV changes", async () => {
    const first = body(
      await handlers.read_sheet({ filePath: "changing.csv", maxCells: 2 }),
    );
    const cursor = z.string().parse(first["nextCursor"]);
    await writeFile(
      join(directory, "changing.csv"),
      "sep=;\nCode;Amount\n001;10\n002;20\n003;30\n",
    );
    expect(
      errorCode(
        await handlers.read_sheet({ filePath: "changing.csv", cursor }),
      ),
    ).toBe("stale_cursor");
  });
});
