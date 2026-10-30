import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { read as independentRead, type CellObject } from "@e965/xlsx";
import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  createWorkbookOutput,
  mutationReceiptSchema,
} from "../src/platform/versions.js";
import { createExcelMcpServer } from "../src/server.js";

const sales = [
  ["North", "Q1", "2026-01-15", 10],
  ["North", "Q2", "2026-04-15", 20],
  ["South", "Q1", "2026-01-20", 12],
  ["East", "Q2", "2026-05-01", 3],
] as const;

function payload(result: { readonly content: readonly unknown[] }): unknown {
  const block = result.content[0];
  if (
    typeof block !== "object" ||
    block === null ||
    !("text" in block) ||
    typeof block.text !== "string"
  )
    throw new Error("Expected a JSON tool result");
  return JSON.parse(block.text);
}

interface Session {
  readonly directory: string;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  refused(name: string, args: Record<string, unknown>): Promise<unknown>;
  cells(filePath: string, sheet: string): Promise<Record<string, CellObject>>;
}

async function workspace(run: (session: Session) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "excel-block-sources-"));
  await mkdir(join(directory, "out"));
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Sales");
  sheet.addRow(["Region", "Quarter", "Date", "Amount"]);
  for (const [region, quarter, date, amount] of sales)
    sheet.addRow([region, quarter, new Date(`${date}T00:00:00Z`), amount]);
  await book.xlsx.writeFile(join(directory, "sales.xlsx"));
  const root = await createWorkbookRoot(directory);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({ name: "block-sources", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await run({
      directory,
      async call(name, args) {
        const result = await preparedCall(client, { name, arguments: args });
        expect(result.isError, JSON.stringify(payload(result))).not.toBe(true);
        return payload(result);
      },
      async refused(name, args) {
        const result = await preparedCall(client, { name, arguments: args });
        expect(result.isError).toBe(true);
        return payload(result);
      },
      async cells(filePath, name) {
        const sheet = independentRead(
          await readFile(join(directory, filePath)),
          { type: "buffer", cellDates: true },
        ).Sheets[name];
        if (sheet === undefined) throw new Error(`Missing sheet ${name}`);
        return Object.fromEntries(
          Object.entries(sheet).filter(([key]) => !key.startsWith("!")),
        ) as Record<string, CellObject>;
      },
    });
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function retained(
  session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await session.call("aggregate_sheet", {
    filePath: "sales.xlsx",
    resultMode: "retained",
    ...args,
  });
  const resultId = (result as { resultId?: unknown }).resultId;
  if (typeof resultId !== "string") throw new Error("Expected a resultId");
  return resultId;
}

function values(cells: Record<string, CellObject>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(cells).map(([key, cell]) => [
      key,
      cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : cell.v,
    ]),
  );
}

const byRegion = {
  groupBy: ["Region"],
  metrics: [{ fn: "sum", column: "Amount" }],
};

it.each([
  {
    name: "a retained result under a replacement header",
    block: (resultId: string) => ({
      source: { kind: "result", resultId },
      header: ["Bölge", "Toplam"],
    }),
    expected: {
      A1: "Bölge",
      B1: "Toplam",
      A2: "East",
      B2: 3,
      A3: "North",
      B3: 30,
      A4: "South",
      B4: 12,
    },
  },
  {
    name: "an aggregate of the source file",
    block: () => ({
      source: {
        kind: "aggregate",
        filePath: "sales.xlsx",
        groupBy: ["Quarter"],
        metrics: [{ fn: "sum", column: "Amount" }],
      },
      header: ["Quarter", "Amount"],
    }),
    expected: {
      A1: "Quarter",
      B1: "Amount",
      A2: "Q1",
      B2: 22,
      A3: "Q2",
      B3: 23,
    },
  },
  {
    name: "filtered and projected records",
    block: () => ({
      source: {
        kind: "records",
        filePath: "sales.xlsx",
        where: [{ column: "Region", op: "eq", value: "North" }],
        selectColumns: ["Quarter", "Amount"],
      },
    }),
    expected: {
      A1: "Quarter",
      B1: "Amount",
      A2: "Q1",
      B2: 10,
      A3: "Q2",
      B3: 20,
    },
  },
  {
    name: "a raw range",
    block: () => ({
      source: { kind: "range", filePath: "sales.xlsx", range: "A1:B2" },
    }),
    expected: { A1: "Region", B1: "Quarter", A2: "North", B2: "Q1" },
  },
])("create_workbook writes a block from $name", async ({ block, expected }) => {
  await workspace(async (session) => {
    const resultId = await retained(session, byRegion);
    const receipt = mutationReceiptSchema.parse(
      await session.call("create_workbook", {
        sheets: [
          { name: "Out", blocks: [{ startCell: "A1", ...block(resultId) }] },
        ],
      }),
    );
    expect(
      values(await session.cells(receipt.version.filePath, "Out")),
    ).toEqual(expected);
    expect(receipt.sources).toHaveLength(1);
    expect(receipt.sources?.[0]).toMatchObject({
      at: "sheets[0].blocks[0]",
      rows: Object.keys(expected).length / 2,
      columns: 2,
    });
  });
});

it("writes retained dates as dates", async () => {
  await workspace(async (session) => {
    const latest = await retained(session, {
      groupBy: ["Region"],
      metrics: [{ fn: "max", column: "Date" }],
    });
    const days = await retained(session, {
      groupBy: ["Date"],
      columns: [{ column: "Date", type: "date" }],
      metrics: [{ fn: "sum", column: "Amount" }],
      where: [{ column: "Region", op: "eq", value: "North" }],
    });
    const receipt = mutationReceiptSchema.parse(
      await session.call("create_workbook", {
        sheets: [
          {
            name: "Out",
            blocks: [
              {
                startCell: "A1",
                source: {
                  kind: "result",
                  resultId: latest,
                  includeHeaders: false,
                },
              },
              {
                startCell: "D1",
                source: {
                  kind: "result",
                  resultId: days,
                  includeHeaders: false,
                },
              },
            ],
          },
        ],
      }),
    );
    const cells = await session.cells(receipt.version.filePath, "Out");
    for (const key of ["B1", "B2", "B3", "D1", "D2"])
      expect(cells[key]?.t, key).toBe("d");
    expect(values(cells)).toMatchObject({
      A1: "East",
      B1: "2026-05-01",
      A2: "North",
      B2: "2026-04-15",
      A3: "South",
      B3: "2026-01-20",
      D1: "2026-01-15",
      E1: 10,
      D2: "2026-04-15",
      E2: 20,
    });
  });
});

it("edits from a selected part of a retained result", async () => {
  await workspace(async (session) => {
    const resultId = await retained(session, byRegion);
    const source = (
      (await session.call("describe_workbook", { filePath: "sales.xlsx" })) as {
        version: unknown;
      }
    ).version;
    const receipt = mutationReceiptSchema.parse(
      await session.call("edit_workbook", {
        source,
        changes: [
          {
            kind: "insert_rows",
            sheetName: "Sales",
            at: 2,
            startColumn: "F",
            source: {
              kind: "result",
              resultId,
              where: [{ column: 1, equals: "North" }],
              includeHeaders: false,
            },
          },
          {
            kind: "write_cells",
            sheetName: "Sales",
            startCell: "H1",
            source: {
              kind: "result",
              resultId,
              columns: [2],
              offset: 1,
              maxRows: 1,
              includeHeaders: false,
            },
          },
        ],
      }),
    );
    const cells = values(
      await session.cells(receipt.version.filePath, "Sales"),
    );
    expect(cells).toMatchObject({ F2: "North", G2: 30, H1: 30, A3: "North" });
    expect(cells).not.toHaveProperty("H2");
    expect(receipt.sources).toEqual([
      { kind: "result", at: "changes[0]", resultId, rows: 1, columns: 2 },
      { kind: "result", at: "changes[1]", resultId, rows: 1, columns: 1 },
    ]);
  });
});

it.each([
  {
    name: "values and source together",
    block: (resultId: string) => ({
      values: [[{ kind: "blank" }]],
      source: { kind: "result", resultId },
    }),
    error: "invalid_argument",
  },
  {
    name: "a header of another width",
    block: (resultId: string) => ({
      source: { kind: "result", resultId },
      header: ["Only"],
    }),
    error: "invalid_argument",
  },
  {
    name: "a source that selects no rows",
    block: (resultId: string) => ({
      source: {
        kind: "result",
        resultId,
        where: [{ column: 1, equals: "Nowhere" }],
        includeHeaders: false,
      },
    }),
    error: "invalid_argument",
  },
  {
    name: "an unknown result",
    block: () => ({
      source: { kind: "result", resultId: "result_missing" },
    }),
    error: "result_unavailable",
  },
  {
    name: "a source version that no longer matches",
    block: () => ({
      source: {
        kind: "range",
        filePath: "sales.xlsx",
        versionId: "0".repeat(64),
        range: "A1:B2",
      },
    }),
    error: "file_changed",
  },
])("refuses a block with $name", async ({ block, error }) => {
  await workspace(async (session) => {
    const resultId = await retained(session, byRegion);
    expect(
      await session.refused("create_workbook", {
        sheets: [
          { name: "Out", blocks: [{ startCell: "A1", ...block(resultId) }] },
        ],
      }),
    ).toMatchObject({ error });
  });
});

it("refuses literal rows that retype a retained result and accepts fewer", async () => {
  await workspace(async (session) => {
    const resultId = await retained(session, byRegion);
    const row = (region: string, amount: number) => [
      { kind: "text", value: region },
      { kind: "number", value: amount },
    ];
    const write = (rows: unknown[]) => ({
      sheets: [{ name: "Out", blocks: [{ startCell: "A1", values: rows }] }],
    });
    const refusal = await session.refused(
      "create_workbook",
      write([row("East", 3), row("North", 30), row("South", 12)]),
    );
    expect(refusal).toMatchObject({ error: "invalid_argument" });
    expect((refusal as { message: string }).message).toContain(
      `source {kind:"result", resultId:"${resultId}"}`,
    );
    await session.call(
      "create_workbook",
      write([row("North", 30), row("South", 12)]),
    );
    await session.call(
      "create_workbook",
      write([row("East", 3), row("North", 31), row("South", 12)]),
    );
  });
});

it("writes header as a text row above literal values", async () => {
  await workspace(async (session) => {
    const receipt = mutationReceiptSchema.parse(
      await session.call("create_workbook", {
        sheets: [
          {
            name: "Out",
            blocks: [
              {
                startCell: "B2",
                header: ["Region", "Amount"],
                values: [
                  [
                    { kind: "text", value: "North" },
                    { kind: "number", value: 30 },
                  ],
                ],
              },
            ],
          },
        ],
      }),
    );
    const cells = await session.cells(receipt.version.filePath, "Out");
    expect(
      Object.fromEntries(
        Object.entries(cells).map(([key, cell]) => [key, cell.v]),
      ),
    ).toEqual({ B2: "Region", C2: "Amount", B3: "North", C3: 30 });
    expect(
      await session.refused("create_workbook", {
        sheets: [
          {
            name: "Out",
            blocks: [
              {
                startCell: "A1",
                header: ["Region"],
                values: [
                  [
                    { kind: "text", value: "North" },
                    { kind: "number", value: 30 },
                  ],
                ],
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      error: "invalid_argument",
      message: "header has 1 names but each values row has 2 cells.",
    });
    expect(
      await session.refused("edit_workbook", {
        source: { filePath: "sales.xlsx", versionId: "0".repeat(64) },
        changes: [
          {
            kind: "insert_rows",
            sheetName: "Sales",
            at: 2,
            count: 1,
            header: ["Region"],
          },
        ],
      }),
    ).toMatchObject({
      error: "invalid_argument",
      message: expect.stringContaining(
        "header names the columns that values or source write; insert_rows with count writes no cells.",
      ),
    });
  });
});
import { preparedCall } from "./fixtures/prepared-call.js";
