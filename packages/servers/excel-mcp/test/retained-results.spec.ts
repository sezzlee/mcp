import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import ExcelJS from "exceljs";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { limits } from "../src/platform/limits.js";
import { createExcelMcpServer } from "../src/server.js";

const customerCount = 1_000;
const referenceDate = "2026-10-15";
let directory: string;
const connections: { close: () => Promise<void> }[] = [];

function textOf(result: CallToolResult): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return content.text;
}

function payload(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function rowsOf(result: CallToolResult): unknown[][] {
  return payload(result)["rows"] as unknown[][];
}

function resultIdOf(result: CallToolResult): string {
  const resultId = payload(result)["resultId"];
  expect(result.isError).not.toBe(true);
  expect(typeof resultId).toBe("string");
  return resultId as string;
}

function customer(index: number): string {
  return `Customer-${String(index).padStart(4, "0")}`;
}

function paymentArguments(): Record<string, unknown> {
  return {
    filePath: "payments.xlsx",
    sheetName: "Payments",
    headerRow: 1,
    groupBy: ["Customer"],
    columns: [{ column: "Due", type: "date", format: "yyyy-MM-dd" }],
    where: [
      { column: "Due", op: "lt", value: referenceDate },
      { column: "Paid", op: "eq", value: false },
    ],
    metrics: [{ fn: "sum", column: "Amount" }, { fn: "count" }],
    orderBy: "group",
    descending: false,
  };
}

async function connect(root = directory): Promise<Client> {
  const server = createExcelMcpServer(await createWorkbookRoot(root));
  const client = new Client({
    name: "retained-results-spec",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  connections.push({
    close: async () => {
      await client.close();
      await server.close();
    },
  });
  return client;
}

async function retain(
  client: Client,
  args: Record<string, unknown> = paymentArguments(),
): Promise<CallToolResult> {
  return client.callTool({
    name: "aggregate_sheet",
    arguments: { ...args, resultMode: "retained" },
  });
}

function expectBounded(result: CallToolResult): void {
  expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThanOrEqual(
    limits.maxResultPageBytes,
  );
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
    limits.maxResultPageBytes,
  );
  expect(textOf(result)).not.toContain(directory);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-retained-mcp-"));
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Payments");
  sheet.addRow(["Customer", "Due", "Paid", "Amount"]);
  for (let index = 1; index <= customerCount; index += 1) {
    sheet.addRows([
      [customer(index), "2026-10-01", false, index],
      [customer(index), "2026-10-14", false, 2 * index],
      [customer(index), referenceDate, false, 1_000_000],
      [customer(index), "2026-09-01", true, 999_999],
    ]);
  }
  await book.xlsx.writeFile(join(directory, "payments.xlsx"));
  await writeFile(
    join(directory, "small.csv"),
    "Customer,Amount\nAlpha,4\nBeta,7\nAlpha,6\n",
  );
  await writeFile(
    join(directory, "sales.csv"),
    "Region,Quarter,Product,Amount\nNorth,Q1,Pen,10\nNorth,Q2,Pen,20\nSouth,Q1,Ink,5\nSouth,Q1,Pen,7\nEast,Q2,Ink,3\n",
  );
  await writeFile(join(directory, "allowed.csv"), "Region\nNorth\nEast\n");
  await writeFile(
    join(directory, "wide.csv"),
    [
      "Key,Pivot,Amount",
      ...Array.from(
        { length: 400 },
        (_, index) => `A,P${String(index + 1).padStart(3, "0")},${index + 1}`,
      ),
    ].join("\n"),
  );
  await mkdir(join(directory, "other-root"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) await connection.close();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("retained results through real MCP calls", () => {
  it("preserves default and explicit inline behavior for small results", async () => {
    const client = await connect();
    const args = {
      filePath: "small.csv",
      groupBy: ["Customer"],
      metrics: [{ fn: "sum", column: "Amount" }],
    };
    const previous = await client.callTool({
      name: "aggregate_sheet",
      arguments: args,
    });
    const explicit = await client.callTool({
      name: "aggregate_sheet",
      arguments: { ...args, resultMode: "inline" },
    });
    expect(previous.isError).not.toBe(true);
    expect(payload(explicit)).toEqual(payload(previous));
    expect(rowsOf(previous)).toEqual([
      ["Alpha", 10],
      ["Beta", 7],
    ]);
    expect(payload(previous)).toMatchObject({
      groupCount: 2,
      returnedGroups: 2,
      truncated: false,
    });
    expect(payload(previous)).not.toHaveProperty("resultId");
  });

  it("discovers a workbook, computes its complete requested scope and returns a bounded preview", async () => {
    const client = await connect();
    const described = await client.callTool({
      name: "describe_workbook",
      arguments: { filePath: "payments.xlsx" },
    });
    expect(described.isError).not.toBe(true);
    expect(payload(described)["sheets"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Payments" })]),
    );

    const result = await retain(client);
    const body = payload(result);
    resultIdOf(result);
    expect(body).toMatchObject({
      scannedRows: 4_000,
      matchedRows: 2_000,
      groupCount: 1_000,
      totalRows: 1_000,
      matchingRows: 1_000,
      matchingSourceRows: 2_000,
      resultComplete: true,
      sampled: false,
      preview: true,
      hasMore: true,
      sourcePolicy: "snapshot",
    });
    expect(body["returnedRows"]).toBe(rowsOf(result).length);
    expect(rowsOf(result).length).toBeGreaterThan(0);
    expect(rowsOf(result).length).toBeLessThanOrEqual(50);
    expect(body["nextOffset"]).toBe(rowsOf(result).length);
    expect(body["sourceVersion"]).toEqual(expect.any(String));
    expectBounded(result);
    expect(textOf(result)).not.toContain(customer(1_000));
    const expected = Array.from({ length: customerCount }, (_, index) => [
      customer(index + 1),
      3 * (index + 1),
      2,
    ]);
    expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(
      limits.maxResultPageBytes,
    );

    const queried = await client.callTool({
      name: "query_result",
      arguments: {
        resultId: resultIdOf(result),
        where: [{ column: 1, equals: customer(1_000) }],
      },
    });
    expect(queried.isError).not.toBe(true);
    expect(rowsOf(queried)).toEqual([[customer(1_000), 3_000, 2]]);
    expect(payload(queried)).toMatchObject({
      totalRows: 1_000,
      matchingRows: 1,
      matchingSourceRows: 2,
      returnedRows: 1,
      returnedMatchedRows: 2,
      resultComplete: true,
      sampled: false,
      preview: false,
      hasMore: false,
    });
    expectBounded(queried);
  });

  it("pages a projected result with no missing or repeated groups", async () => {
    const client = await connect();
    const resultId = resultIdOf(await retain(client));
    const all: unknown[][] = [];
    let offset = 0;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const result = await client.callTool({
        name: "query_result",
        arguments: { resultId, columns: [3, 1, 2], offset, maxRows: 137 },
      });
      expect(result.isError).not.toBe(true);
      expectBounded(result);
      const body = payload(result);
      const rows = rowsOf(result);
      expect(rows.length).toBeGreaterThan(0);
      expect(body["offset"]).toBe(offset);
      expect(body["returnedRows"]).toBe(rows.length);
      all.push(...rows);
      if (body["hasMore"] === false) {
        expect(body).not.toHaveProperty("nextOffset");
        break;
      }
      expect(body["nextOffset"]).toBe(offset + rows.length);
      offset = body["nextOffset"] as number;
    }
    expect(all).toEqual(
      Array.from({ length: customerCount }, (_, index) => [
        2,
        customer(index + 1),
        3 * (index + 1),
      ]),
    );
    expect(new Set(all.map((row) => row[1])).size).toBe(customerCount);
  });

  it("applies exact AND filters to original column indices before projection", async () => {
    const client = await connect();
    const resultId = resultIdOf(await retain(client));
    const match = await client.callTool({
      name: "query_result",
      arguments: {
        resultId,
        columns: [2],
        where: [
          { column: 1, equals: customer(731) },
          { column: 3, equals: 2 },
        ],
      },
    });
    expect(rowsOf(match)).toEqual([[2_193]]);
    const wrongType = await client.callTool({
      name: "query_result",
      arguments: { resultId, where: [{ column: 2, equals: "2193" }] },
    });
    expect(rowsOf(wrongType)).toEqual([]);
    expect(payload(wrongType)).toMatchObject({
      matchingRows: 0,
      returnedRows: 0,
      hasMore: false,
    });
    const mismatch = await client.callTool({
      name: "query_result",
      arguments: {
        resultId,
        where: [
          { column: 1, equals: customer(731) },
          { column: 3, equals: 1 },
        ],
      },
    });
    expect(rowsOf(mismatch)).toEqual([]);
  });

  it("continues byte-limited pages with escaped Unicode keys without losing or repeating rows", async () => {
    const client = await connect();
    const expected = Array.from(
      { length: 80 },
      (_, index) =>
        [
          `${String(index).padStart(3, "0")}-${'中"\\'.repeat(100)}`,
          index + 1,
        ] as const,
    );
    await writeFile(
      join(directory, "escaped-keys.csv"),
      [
        "Customer,Amount",
        ...expected.map(
          ([key, amount]) => `"${key.replaceAll('"', '""')}",${amount}`,
        ),
      ].join("\n"),
    );
    const initial = await retain(client, {
      filePath: "escaped-keys.csv",
      groupBy: ["Customer"],
      metrics: [{ fn: "sum", column: "Amount" }],
    });
    const resultId = resultIdOf(initial);
    expectBounded(initial);
    expect(rowsOf(initial).length).toBeGreaterThan(0);
    expect(rowsOf(initial).length).toBeLessThan(50);
    const all: unknown[][] = [];
    let offset = 0;
    for (let pageIndex = 0; pageIndex < 80; pageIndex += 1) {
      const result = await client.callTool({
        name: "query_result",
        arguments: { resultId, offset, maxRows: 500 },
      });
      expect(result.isError).not.toBe(true);
      expectBounded(result);
      const body = payload(result);
      const rows = rowsOf(result);
      expect(rows.length).toBeGreaterThan(0);
      expect(body["offset"]).toBe(offset);
      expect(body["valueTruncation"]).toMatchObject({ cells: 0 });
      all.push(...rows);
      if (pageIndex === 0) {
        expect(body["hasMore"]).toBe(true);
        expect(rows.length).toBeLessThan(expected.length);
      }
      if (body["hasMore"] === false) {
        expect(body).not.toHaveProperty("nextOffset");
        break;
      }
      expect(body["nextOffset"]).toBe(offset + rows.length);
      offset = body["nextOffset"] as number;
    }
    expect(all).toEqual(expected);
    expect(new Set(all.map((row) => row[0])).size).toBe(expected.length);
  });

  it("keeps a snapshot after the source is replaced and deleted", async () => {
    const client = await connect();
    const filePath = "changing.csv";
    await writeFile(
      join(directory, filePath),
      "Customer,Amount\nAlpha,10\nBeta,20\n",
    );
    const result = await retain(client, {
      filePath,
      groupBy: ["Customer"],
      metrics: [{ fn: "sum", column: "Amount" }],
    });
    const resultId = resultIdOf(result);
    const version = payload(result)["sourceVersion"];
    await writeFile(
      join(directory, filePath),
      "Customer,Amount\nAlpha,9000\nGamma,8000\n",
    );
    const replaced = await client.callTool({
      name: "query_result",
      arguments: { resultId },
    });
    expect(rowsOf(replaced)).toEqual([
      ["Alpha", 10],
      ["Beta", 20],
    ]);
    expect(payload(replaced)["sourceVersion"]).toBe(version);
    await rm(join(directory, filePath));
    const deleted = await client.callTool({
      name: "query_result",
      arguments: { resultId },
    });
    expect(rowsOf(deleted)).toEqual([
      ["Alpha", 10],
      ["Beta", 20],
    ]);
    expect(payload(deleted)["sourceVersion"]).toBe(version);
  });

  it("cannot resolve another server instance's result even under the same root", async () => {
    const origin = await connect();
    const resultId = resultIdOf(await retain(origin));
    for (const client of [
      await connect(),
      await connect(join(directory, "other-root")),
    ]) {
      const result = await client.callTool({
        name: "query_result",
        arguments: { resultId },
      });
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ error: "result_unavailable" });
      expectBounded(result);
    }
  });

  it("rejects unknown and expired IDs without extending the absolute lifetime on reads", async () => {
    const client = await connect();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const resultId = resultIdOf(await retain(client));
    const invalid = await client.callTool({
      name: "query_result",
      arguments: { resultId: "not-a-result" },
    });
    expect(payload(invalid)).toMatchObject({ error: "result_unavailable" });
    clock.mockReturnValue(now + limits.resultTtlMs - 1);
    const live = await client.callTool({
      name: "query_result",
      arguments: { resultId },
    });
    expect(live.isError).not.toBe(true);
    clock.mockReturnValue(now + limits.resultTtlMs);
    const expired = await client.callTool({
      name: "query_result",
      arguments: { resultId },
    });
    expect(expired.isError).toBe(true);
    expect(payload(expired)).toMatchObject({ error: "result_unavailable" });
    expect(payload(expired)).not.toHaveProperty("rows");
  });

  it("refuses a full store without evicting usable results and lazily reclaims expired entries", async () => {
    const client = await connect();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const args = {
      filePath: "small.csv",
      groupBy: ["Customer"],
      metrics: [{ fn: "sum", column: "Amount" }],
    };
    const ids: string[] = [];
    for (let index = 0; index < limits.maxResults; index += 1)
      ids.push(resultIdOf(await retain(client, args)));
    const refused = await retain(client, args);
    expect(refused.isError).toBe(true);
    expect(payload(refused)).toMatchObject({ error: "resource_limit" });
    expect(payload(refused)).not.toHaveProperty("resultId");
    const existing = await client.callTool({
      name: "query_result",
      arguments: { resultId: ids[0] },
    });
    expect(rowsOf(existing)).toEqual([
      ["Alpha", 10],
      ["Beta", 7],
    ]);
    clock.mockReturnValue(now + limits.resultTtlMs);
    resultIdOf(await retain(client, args));
    const old = await client.callTool({
      name: "query_result",
      arguments: { resultId: ids[0] },
    });
    expect(payload(old)).toMatchObject({ error: "result_unavailable" });
  });

  it("matches full retained strings when previews share the same truncated prefix", async () => {
    const client = await connect();
    const prefix = "Shared-" + "ü".repeat(600);
    const first = `${prefix}alpha`;
    const second = `${prefix}beta`;
    await writeFile(
      join(directory, "long-keys.csv"),
      `Customer,Amount\n${first},11\n${second},22\n`,
    );
    const initial = await retain(client, {
      filePath: "long-keys.csv",
      groupBy: ["Customer"],
      metrics: [{ fn: "sum", column: "Amount" }],
    });
    expect(payload(initial)["valueTruncation"]).toMatchObject({
      cells: 2,
      maxStringChars: 512,
    });
    expect(rowsOf(initial)[0]?.[0]).toBe(rowsOf(initial)[1]?.[0]);
    const result = await client.callTool({
      name: "query_result",
      arguments: {
        resultId: resultIdOf(initial),
        columns: [2],
        where: [{ column: 1, equals: second }],
      },
    });
    expect(rowsOf(result)).toEqual([[22]]);
    expect(payload(result)).toMatchObject({ totalRows: 2, matchingRows: 1 });
    expectBounded(result);
  });

  it("retains a pivot in its inline row shape and pages it with query_result", async () => {
    const client = await connect();
    const args = {
      filePath: "sales.csv",
      groupBy: ["Region"],
      pivotBy: ["Quarter"],
      metrics: [{ fn: "sum", column: "Amount" }],
    };
    const expected = [
      ["East", null, 3],
      ["North", 10, 20],
      ["South", 12, null],
    ];
    const inline = await client.callTool({
      name: "aggregate_sheet",
      arguments: args,
    });
    expect(rowsOf(inline)).toEqual(expected);
    const retained = await retain(client, args);
    const resultId = resultIdOf(retained);
    expectBounded(retained);
    expect(rowsOf(retained)).toEqual(expected);
    expect(payload(retained)).toMatchObject({
      totalRows: 3,
      columns: [{ role: "group" }, { pivotKey: ["Q1"] }, { pivotKey: ["Q2"] }],
    });

    const filtered = await client.callTool({
      name: "query_result",
      arguments: {
        resultId,
        columns: [1, 3],
        where: [{ column: 1, equals: "North" }],
      },
    });
    expect(rowsOf(filtered)).toEqual([["North", 20]]);

    const paged: unknown[][] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page: CallToolResult = await client.callTool({
        name: "query_result",
        arguments: { resultId, columns: [1, 2], offset, maxRows: 1 },
      });
      paged.push(...rowsOf(page));
      offset = payload(page)["nextOffset"] as number | undefined;
    }
    expect(paged).toEqual([
      ["East", null],
      ["North", 10],
      ["South", 12],
    ]);
  });

  it("retains every grouping set as its own result", async () => {
    const client = await connect();
    const retained = await retain(client, {
      filePath: "sales.csv",
      groupBy: ["Region"],
      groupingSets: [{ groupBy: ["Product"] }, { groupBy: [] }],
      metrics: [{ fn: "sum", column: "Amount" }],
    });
    const primaryId = resultIdOf(retained);
    expectBounded(retained);
    expect(rowsOf(retained)).toEqual([
      ["East", 3],
      ["North", 30],
      ["South", 12],
    ]);
    const sets = payload(retained)["groupingSets"] as Record<string, unknown>[];
    expect(sets.map((set) => set["rows"])).toEqual([
      [
        ["Ink", 8],
        ["Pen", 37],
      ],
      [[45]],
    ]);
    const ids = sets.map((set) => set["resultId"]);
    expect(new Set([primaryId, ...ids]).size).toBe(3);

    const pen = await client.callTool({
      name: "query_result",
      arguments: { resultId: ids[0], where: [{ column: 1, equals: "Pen" }] },
    });
    expect(rowsOf(pen)).toEqual([["Pen", 37]]);
    expect(payload(pen)).toMatchObject({
      columns: [{ label: "Product" }, { fn: "sum" }],
      totalRows: 2,
    });
  });

  it.each([
    {
      op: "inColumn",
      rows: [
        ["East", 3],
        ["North", 30],
      ],
    },
    { op: "notInColumn", rows: [["South", 12]] },
  ])(
    "retains $op filters and names the member source's version",
    async ({ op, rows }) => {
      const client = await connect();
      const args = {
        filePath: "sales.csv",
        groupBy: ["Region"],
        metrics: [{ fn: "sum", column: "Amount" }],
      };
      const retained = await retain(client, {
        ...args,
        where: [
          {
            column: "Region",
            op,
            source: { filePath: "allowed.csv", column: "Region" },
          },
        ],
      });
      resultIdOf(retained);
      expect(rowsOf(retained)).toEqual(rows);
      const versions = payload(retained)["memberSourceVersions"];
      expect(versions).toEqual([expect.any(String)]);
      expect(versions).not.toContain(payload(retained)["sourceVersion"]);

      const sameFile = await retain(client, {
        ...args,
        where: [{ column: "Region", op, source: { column: "Region" } }],
      });
      resultIdOf(sameFile);
      expect(payload(sameFile)).not.toHaveProperty("memberSourceVersions");
    },
  );

  it("narrows a preview too wide for its budget and keeps every column queryable", async () => {
    const client = await connect();
    const retained = await retain(client, {
      filePath: "wide.csv",
      groupBy: ["Key"],
      pivotBy: ["Pivot"],
      metrics: [{ fn: "sum", column: "Amount" }],
    });
    const resultId = resultIdOf(retained);
    expectBounded(retained);
    const body = payload(retained);
    const shown = body["columnNumbers"] as number[];
    expect(body["totalColumns"]).toBe(401);
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(401);
    expect(shown).toEqual(Array.from(shown, (_, index) => index + 1));
    expect(rowsOf(retained)).toEqual([
      ["A", ...Array.from(shown.slice(1), (_, index) => index + 1)],
    ]);

    const last = await client.callTool({
      name: "query_result",
      arguments: { resultId, columns: [1, 401] },
    });
    expect(rowsOf(last)).toEqual([["A", 400]]);
    expect(payload(last)).toMatchObject({
      columns: [{ label: "Key" }, { pivotKey: ["P400"] }],
    });
    expect(payload(last)).not.toHaveProperty("totalColumns");
  });

  it("keeps file access enforcement and error redaction on retained aggregate calls", async () => {
    const client = await connect();
    const result = await retain(client, {
      filePath: "../outside.xlsx",
      metrics: [{ fn: "count" }],
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "path_outside_root" });
    expect(textOf(result)).not.toContain(directory);
    expect(payload(result)).not.toHaveProperty("resultId");
  });
});
