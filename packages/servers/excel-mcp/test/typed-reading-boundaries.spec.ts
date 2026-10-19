import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

let directory: string;
let handlers: ToolHandlers;

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return {
    ...(JSON.parse(content.text) as Record<string, unknown>),
    isError: result.isError === true,
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-typed-boundaries-"));
  handlers = createHandlers(await createWorkbookRoot(directory));
  await Promise.all([
    writeFile(
      join(directory, "dotted.csv"),
      "Date;Amount\n02.01.2023;10\n05.03.2023;20\n11.12.2023;30",
    ),
    writeFile(join(directory, "amounts.csv"), 'Amount\n"1,234.50"\n10\n100:30'),
    writeFile(join(directory, "grades.csv"), "Grade\nA\nB\nE\nB"),
    writeFile(join(directory, "status.csv"), "Status\nN/A\nOK\nN/A"),
    writeFile(join(directory, "flags.csv"), "Flag;Amount\nN;1\nH;2\nyes;3"),
    writeFile(join(directory, "small.csv"), "A;B;C\n1;2;3\n4;5;6"),
    writeFile(
      join(directory, "hours.csv"),
      "Time\n09:00\n23:00\n24:00:00\nnope",
    ),
    writeFile(join(directory, "us-early.csv"), "Date\n03/04/2026\n05/06/2026"),
    writeFile(join(directory, "us-dated.csv"), "Date\n04/13/2026\n03/04/2026"),
    writeFile(
      join(directory, "dotted-month-first.csv"),
      "Date\n01.15.2026\n02.03.2026",
    ),
    writeFile(join(directory, "points.csv"), 'Amount\n1.234\n"1,234.50"'),
  ]);
});

const languages =
  "af am ar az be bg bn bs ca cs cy da de el en es et eu fa fi fil fr ga gl gu he hi hr hu hy id is it ja ka kk km kn ko ky lo lt lv mk ml mn mr ms my nb ne nl pa pl pt ro ru si sk sl sq sr sv sw ta te th tk tr uk ur uz vi zh zu".split(
    " ",
  );
const regions = ["", "-US", "-GB", "-CA", "-AU", "-IN", "-CH", "-DE", "-BR"];

function numericDateForms(): ReadonlyMap<string, string> {
  const day = new Date(Date.UTC(2026, 2, 4));
  const forms = new Map<string, string>();
  for (const locale of Intl.DateTimeFormat.supportedLocalesOf(
    languages.flatMap((language) =>
      regions.map((region) => `${language}${region}-u-nu-latn`),
    ),
  )) {
    const parts = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "UTC",
    }).formatToParts(day);
    const order = parts
      .filter((part) => ["day", "month", "year"].includes(part.type))
      .map((part) => part.type.charAt(0))
      .join("");
    const dotted = parts.some(
      (part) => part.type === "literal" && part.value.trim() === ".",
    );
    if (dotted) forms.set(locale, order);
  }
  return forms;
}

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("day and month order does not follow the caller's locale", () => {
  it("rests on CLDR writing no dotted numeric date month first", () => {
    const forms = numericDateForms();
    expect(forms.size).toBeGreaterThan(50);
    expect([...forms].filter(([, order]) => order === "mdy")).toEqual([]);
  });

  it("reads a dotted date day first whatever locale the caller names", async () => {
    for (const locale of ["en-US", "tr-TR", "de-DE"]) {
      const result = body(
        await handlers.aggregate_sheet({
          filePath: "dotted.csv",
          locale,
          groupBy: [{ column: "Date", by: "month" }],
          metrics: [{ fn: "count" }],
        }),
      );
      expect(result["rows"], locale).toEqual([
        ["2023-01", 1],
        ["2023-03", 1],
        ["2023-12", 1],
      ]);
    }
  });

  it("does not let a reader's locale order an English file's slash dates", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "us-early.csv",
        locale: "tr-TR",
        groupBy: [{ column: "Date", by: "month" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([]);
    expect(result["ungroupedRows"]).toBe(2);
    expect(result["warnings"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("read either day first or month first"),
      ]),
    );
  });

  it("orders slash dates by the column's own evidence under any locale", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "us-dated.csv",
        locale: "tr-TR",
        groupBy: [{ column: "Date", by: "month" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([
      ["2026-03", 1],
      ["2026-04", 1],
    ]);
  });

  it("reports a dotted column that a value reads only month first", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "dotted-month-first.csv",
        groupBy: [{ column: "Date", by: "month" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([]);
    expect(result["ungroupedRows"]).toBe(2);
    expect(result["warnings"]).toEqual(
      expect.arrayContaining([expect.stringContaining('"MM.dd.yyyy"')]),
    );
  });

  it("names a value that the caller's locale reads as a different number", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "points.csv",
        locale: "tr-TR",
        metrics: [{ fn: "sum", column: "Amount" }],
      }),
    );
    expect(result["warnings"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "values such as '1.234' read as a different number with locale tr-TR",
        ),
      ]),
    );
  });
});

describe("typed reading at the tool boundary", () => {
  it("reads dotted dates through the column plan profile_sheet emits", async () => {
    const profile = body(
      await handlers.profile_sheet({ filePath: "dotted.csv" }),
    );
    const read = body(
      await handlers.read_sheet({
        filePath: "dotted.csv",
        columns: profile["columns"] as never,
        includeTyped: true,
      }),
    );
    expect(read["isError"]).toBe(false);
    expect((read["typedValues"] as unknown[][]).map((row) => row[0])).toEqual([
      "2023-01-02",
      "2023-03-05",
      "2023-12-11",
    ]);
  });

  it("keeps an amount column numeric when one cell looks like an elapsed time", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "amounts.csv",
        metrics: [{ fn: "sum", column: "Amount" }],
      }),
    );
    expect(result["rows"]).toEqual([[1244.5]]);
  });

  it("does not read a single letter that matches a boolean token as a boolean", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "grades.csv",
        where: [{ column: "Grade", op: "isText" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([[4]]);
  });

  it("matches a literal that equals a default missing token", async () => {
    const equal = body(
      await handlers.aggregate_sheet({
        filePath: "status.csv",
        where: [{ column: "Status", op: "eq", value: "N/A" }],
        metrics: [{ fn: "count" }],
      }),
    );
    const contains = body(
      await handlers.aggregate_sheet({
        filePath: "status.csv",
        where: [{ column: "Status", op: "contains", value: "n/" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(equal["rows"]).toEqual([[2]]);
    expect(contains["rows"]).toEqual([[2]]);
  });

  it("lets a caller's token list take a word from the defaults of another list", async () => {
    const missing = body(
      await handlers.aggregate_sheet({
        filePath: "flags.csv",
        missingValues: ["N", "NA"],
        metrics: [{ fn: "count" }, { fn: "sum", column: "Amount" }],
      }),
    );
    const truthy = body(
      await handlers.aggregate_sheet({
        filePath: "flags.csv",
        trueValues: ["H"],
        where: [{ column: "Flag", op: "eq", value: true }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(missing["isError"]).toBe(false);
    expect(missing["rows"]).toEqual([[3, 6]]);
    expect(truthy["isError"]).toBe(false);
    expect(truthy["rows"]).toEqual([[1]]);
  });

  it("still refuses two caller lists that claim the same word", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "flags.csv",
        missingValues: ["yes"],
        trueValues: ["Yes"],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["isError"]).toBe(true);
    expect(result["error"]).toBe("invalid_argument");
  });

  it("returns a complete page whose would-be cursor is over the cursor budget", async () => {
    const tokens = (prefix: string): string[] =>
      Array.from({ length: 64 }, (_, at) => `${prefix}${at}`.padEnd(128, "x"));
    const result = body(
      await handlers.read_sheet({
        filePath: "small.csv",
        columns: ["A", "B", "C"].map((column) => ({
          column,
          type: "number" as const,
          decimal: "." as const,
          missingValues: tokens(column),
        })),
        includeTyped: true,
      }),
    );
    expect(result["isError"]).toBe(false);
    expect(result["nextCursor"]).toBeUndefined();
    expect(result["typedValues"]).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("does not count ungrouped rows as rows that maxGroups omitted", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "hours.csv",
        groupBy: [{ column: "Time", by: "hour" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result).toMatchObject({
      matchedRows: 4,
      ungroupedRows: 2,
      returnedMatchedRows: 2,
      omittedMatchedRows: 0,
      truncated: false,
    });
  });
});
