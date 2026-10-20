import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createWorkbookRoot } from "../src/platform/paths.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

let directory: string;
let handlers: ToolHandlers;

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return JSON.parse(content.text) as Record<string, unknown>;
}

function rowsOf(result: CallToolResult): readonly (readonly unknown[])[] {
  return body(result)["rows"] as readonly (readonly unknown[])[];
}

function warningsOf(result: CallToolResult): readonly string[] {
  return (
    (body(result)["warnings"] as readonly { message: string }[] | undefined) ??
    []
  ).map((entry) => entry.message);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-typed-text-"));
  handlers = createHandlers(await createWorkbookRoot(directory));
  await writeFile(
    join(directory, "turkish.csv"),
    [
      "Tarih;Tutar;Hesap",
      "02.01.2023;1.234,50;00123",
      "15.01.2023;-250,00;00456",
      "03.02.2023;₺2.000,00;00789",
      "28.02.2023;(100,00);01000",
      "05.03.2023;N/A;01111",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "american.csv"),
    [
      "Date,Amount,Share",
      '01/25/2023,"1,234.50",12%',
      '02/01/2023,"$2,000.00",8.5%',
      "03/15/2023,(100.00),20%",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "currencies.csv"),
    ["Tutar", "₺100", "100 TL", "€50", '"1.000,00"'].join("\n"),
  );
  await writeFile(
    join(directory, "ambiguous.csv"),
    ["Date,Amount", "01/02/2023,1", "03/04/2023,2", "05/06/2023,3"].join("\n"),
  );
  await writeFile(
    join(directory, "comma-decimal.csv"),
    [
      "id,importo,tasso",
      '1,"80000000,00",1.50',
      '2,"1527319,20",2.25',
      '3,"",0.75',
      "4, ,1.00",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "numeric-boundaries.csv"),
    [
      "Amount",
      "1234.50",
      "-0.25",
      "900719925474099",
      "9007199254740991",
      "00123",
      "25%",
      "€50",
      "5.0e2",
      '"1,000.00"',
      " 2.50 ",
    ].join("\n"),
  );
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Traffic");
  sheet.addRow(["SAAT", "ARAÇ"]);
  for (const [fraction, count] of [
    [0.34375, 12],
    [0.75, 30],
  ] as const) {
    const row = sheet.addRow([fraction, count]);
    row.getCell(1).numFmt = "h:mm";
  }
  await book.xlsx.writeFile(join(directory, "clock.xlsx"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("keeps identifier, percentage and currency semantics when repeated metrics read ordinary decimal text", async () => {
  const result = await handlers.aggregate_sheet({
    filePath: "numeric-boundaries.csv",
    metrics: [
      { fn: "sum", column: "Amount" },
      { fn: "avg", column: "Amount" },
      { fn: "min", column: "Amount" },
    ],
    where: [{ column: "Amount", op: "isNumber" }],
  });
  expect(rowsOf(result)).toEqual([
    [900_719_925_476_886, 112_589_990_684_610.75, -0.25],
  ]);
  expect(body(result)["matchedRows"]).toBe(8);
});

describe("a Turkish CSV", () => {
  it("sums decimal-comma amounts with currency and accounting forms, and names what it skipped", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "turkish.csv",
      metrics: [{ fn: "sum", column: "Tutar" }],
    });
    expect(rowsOf(result)).toEqual([[1234.5 - 250 + 2000 - 100]]);
    expect(body(result)["readAs"]).toEqual({
      B: [{ type: "number", decimal: ",", group: "." }],
    });
    expect(warningsOf(result)).not.toContain(
      "B: 1 text cell does not read as a number, such as 'N/A'; the totals exclude them.",
    );
    expect(body(result)["columnStats"]).toEqual({
      B: { texts: 5, textNumbers: 4, missingLiterals: 1 },
    });
    expect(body(result)["columns"]).toEqual([
      expect.objectContaining({ counted: 4, skipped: 1 }),
    ]);
  });

  it("filters day-first dates against ISO bounds", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "turkish.csv",
      where: [
        {
          column: "Tarih",
          op: "between",
          values: ["2023-01-01", "2023-01-31"],
        },
      ],
      metrics: [{ fn: "count" }, { fn: "sum", column: "Tutar" }],
    });
    expect(rowsOf(result)).toEqual([[2, 1234.5 - 250]]);
    expect(warningsOf(result)).toEqual([]);
  });

  it("never sums account numbers with leading zeros", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "turkish.csv",
      metrics: [{ fn: "sum", column: "Hesap" }],
    });
    expect(rowsOf(result)).toEqual([[null]]);
    expect(warningsOf(result)).toContain(
      `C: 5 cells look like identifiers (a leading zero or more than 15 digits), such as '00123', '00456', '00789'; the totals exclude them. If they are quantities, pass columns [{"column":"C","type":"number","decimal":"."}].`,
    );
  });

  it("sums leading-zero values once columns says they are quantities", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "turkish.csv",
      columns: [{ column: "Hesap", type: "number", decimal: "," }],
      metrics: [{ fn: "sum", column: "Hesap" }],
    });
    expect(rowsOf(result)).toEqual([[123 + 456 + 789 + 1000 + 1111]]);
  });

  it("still shows the text as written in read_sheet", async () => {
    const read = body(
      await handlers.read_sheet({ filePath: "turkish.csv", range: "A2:B2" }),
    );
    expect(read["values"]).toEqual([["02.01.2023", "1.234,50"]]);
  });
});

describe("an American CSV", () => {
  it("sums grouped amounts and averages percentages as ratios", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "american.csv",
      metrics: [
        { fn: "sum", column: "Amount" },
        { fn: "avg", column: "Share" },
      ],
    });
    const [[total, share]] = rowsOf(result) as [[number, number]];
    expect(total).toBe(1234.5 + 2000 - 100);
    expect(share).toBeCloseTo((0.12 + 0.085 + 0.2) / 3, 12);
  });

  it("reads 02/01/2023 as 1 February once another date puts the month first", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "american.csv",
      where: [
        { column: "Date", op: "between", values: ["2023-02-01", "2023-02-28"] },
      ],
      metrics: [{ fn: "count" }],
    });
    expect(rowsOf(result)).toEqual([[1]]);
    expect(body(result)["readAs"]).toMatchObject({
      A: [{ type: "date", order: "mdy" }],
    });
  });
});

describe("a column of mixed currencies", () => {
  it("adds the amounts as written and says they are in more than one currency", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "currencies.csv",
      metrics: [{ fn: "sum", column: "Tutar" }],
    });
    expect(rowsOf(result)).toEqual([[100 + 100 + 50 + 1000]]);
    expect(warningsOf(result)).toEqual([
      "A: amounts are written in more than one currency (EUR, TRY); the totals add them as written, without conversion.",
    ]);
  });
});

describe("a column whose dates fit both orders", () => {
  const year = {
    column: "Date",
    op: "between" as const,
    values: ["2023-01-01", "2023-12-31"],
  };

  it("matches nothing, says why, and names the formats to choose from", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "ambiguous.csv",
      where: [year],
      metrics: [{ fn: "count" }],
    });
    expect(rowsOf(result)).toEqual([[0]]);
    const warnings = warningsOf(result);
    expect(warnings).toContain(
      `A: dates such as '01/02/2023' read either day first or month first, so they were not read as dates. Pass columns [{"column":"A","type":"date","format":"dd/MM/yyyy"}] or [{"column":"A","type":"date","format":"MM/dd/yyyy"}].`,
    );
    expect(warnings).toContain(
      "where Date between: 3 cells in A could not be compared with a date, such as '01/02/2023', '03/04/2023', '05/06/2023'; they did not match.",
    );
  });

  it("follows the format the caller names", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "ambiguous.csv",
      columns: [{ column: "Date", type: "date", format: "dd/MM/yyyy" }],
      where: [
        { column: "Date", op: "between", values: ["2023-02-01", "2023-02-28"] },
      ],
      metrics: [{ fn: "sum", column: "Amount" }],
    });
    expect(rowsOf(result)).toEqual([[1]]);
  });

  it("refuses a format outside the token set", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "ambiguous.csv",
      columns: [{ column: "Date", type: "date", format: "dd/MM/yy" }],
      metrics: [{ fn: "count" }],
    });
    expect(result.isError).toBe(true);
    expect(body(result)["error"]).toBe("invalid_argument");
  });
});

describe("comma_decimal_null.csv's shape: one decimal-comma and one decimal-point column", () => {
  it("decides the marks per column and sums both", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "comma-decimal.csv",
      metrics: [
        { fn: "sum", column: "importo" },
        { fn: "sum", column: "tasso" },
      ],
    });
    const [[importo, tasso]] = rowsOf(result) as [[number, number]];
    expect(importo).toBeCloseTo(80_000_000 + 1_527_319.2, 6);
    expect(tasso).toBe(1.5 + 2.25 + 0.75 + 1);
    expect(warningsOf(result)).toEqual([]);
  });

  it("treats a blank field as missing, not as a value that failed to compare", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "comma-decimal.csv",
      where: [{ column: "importo", op: "gt", value: 0 }],
      metrics: [{ fn: "count" }],
    });
    expect(rowsOf(result)).toEqual([[2]]);
    expect(warningsOf(result)).toEqual([]);
  });
});

describe("a time-only xlsx column", () => {
  it("reads h:mm cells as times of day, not as 1899 instants", async () => {
    const read = body(await handlers.read_sheet({ filePath: "clock.xlsx" }));
    expect(read["values"]).toEqual([
      ["08:15:00", 12],
      ["18:00:00", 30],
    ]);
  });

  it("filters and takes extremes over the times", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "clock.xlsx",
      where: [{ column: "SAAT", op: "lt", value: "12:00:00" }],
      metrics: [
        { fn: "sum", column: "ARAÇ" },
        { fn: "min", column: "SAAT" },
      ],
    });
    expect(rowsOf(result)).toEqual([[12, "08:15:00"]]);
  });
});
