import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";

const budget = vi.hoisted(() => ({
  maxAggregateCellVisits: 10_000,
  maxAggregateGroups: 100,
  maxResultBytes: 4_096,
  maxResultStoreBytes: 8_192,
  maxResultRows: 100,
  maxResultCells: 1_000,
  maxResultPageBytes: 16_384,
  maxResults: 4,
}));

vi.mock("../src/platform/limits.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/platform/limits.js")>();
  return {
    ...original,
    limits: {
      ...original.limits,
      get maxAggregateCellVisits() {
        return budget.maxAggregateCellVisits;
      },
      get maxAggregateGroups() {
        return budget.maxAggregateGroups;
      },
      get maxResultBytes() {
        return budget.maxResultBytes;
      },
      get maxResultStoreBytes() {
        return budget.maxResultStoreBytes;
      },
      get maxResultRows() {
        return budget.maxResultRows;
      },
      get maxResultCells() {
        return budget.maxResultCells;
      },
      get maxResultPageBytes() {
        return budget.maxResultPageBytes;
      },
      get maxResults() {
        return budget.maxResults;
      },
    },
  };
});

let directory: string;
const connections: { close: () => Promise<void> }[] = [];

function payload(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function connect(): Promise<Client> {
  const server = createExcelMcpServer(await createWorkbookRoot(directory));
  const client = new Client({ name: "retained-budget-spec", version: "0.0.0" });
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

async function aggregate(
  client: Client,
  filePath = "many.csv",
  retained = true,
): Promise<CallToolResult> {
  return client.callTool({
    name: "aggregate_sheet",
    arguments: {
      filePath,
      groupBy: ["Customer"],
      metrics: [{ fn: "sum", column: "Amount" }],
      ...(retained ? { resultMode: "retained" } : {}),
    },
  });
}

function expectRefused(result: CallToolResult): void {
  expect(result.isError).toBe(true);
  const body = payload(result);
  expect(body).toMatchObject({ error: "resource_limit" });
  expect(body).not.toHaveProperty("resultId");
  expect(body).not.toHaveProperty("resultComplete");
  expect(body).not.toHaveProperty("rows");
  expect(JSON.stringify(result)).not.toContain(directory);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-retained-budget-mcp-"));
  await writeFile(
    join(directory, "many.csv"),
    [
      "Customer,Amount",
      ...Array.from(
        { length: 12 },
        (_, index) => `Customer-${index},${index + 1}`,
      ),
    ].join("\n"),
  );
  await writeFile(
    join(directory, "long.csv"),
    `Customer,Amount\n${"x".repeat(2_100)},17\n`,
  );
  await writeFile(
    join(directory, "small.csv"),
    "Customer,Amount\nAlpha,4\nAlpha,6\n",
  );
});

beforeEach(() => {
  Object.assign(budget, {
    maxAggregateCellVisits: 10_000,
    maxAggregateGroups: 100,
    maxResultBytes: 4_096,
    maxResultStoreBytes: 8_192,
    maxResultRows: 100,
    maxResultCells: 1_000,
    maxResultPageBytes: 16_384,
    maxResults: 4,
  });
});

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("retained result budgets through real MCP calls", () => {
  it.each([
    ["maxAggregateCellVisits", 1],
    ["maxAggregateGroups", 3],
    ["maxResultRows", 3],
    ["maxResultCells", 6],
  ] as const)(
    "refuses %s exhaustion without publishing a partial snapshot",
    async (limit, maximum) => {
      budget[limit] = maximum;
      const client = await connect();
      expectRefused(await aggregate(client));
    },
  );

  it("accounts for full retained strings before presentation truncation", async () => {
    budget.maxResultBytes = 1_024;
    const client = await connect();
    expectRefused(await aggregate(client, "long.csv"));
  });

  it("refuses total byte exhaustion without evicting or altering an existing result", async () => {
    budget.maxResultStoreBytes = 4_096;
    const client = await connect();
    const initial = await aggregate(client, "long.csv");
    expect(initial.isError).not.toBe(true);
    const resultId = payload(initial)["resultId"] as string;
    expect(resultId).toEqual(expect.any(String));
    expectRefused(await aggregate(client, "long.csv"));
    const query = await client.callTool({
      name: "query_result",
      arguments: {
        resultId,
        columns: [2],
        where: [{ column: 1, equals: "x".repeat(2_100) }],
      },
    });
    expect(query.isError).not.toBe(true);
    expect(payload(query)).toMatchObject({
      rows: [[17]],
      totalRows: 1,
      matchingRows: 1,
      resultComplete: true,
    });
    const inline = await aggregate(client, "small.csv", false);
    expect(inline.isError).not.toBe(true);
    expect(payload(inline)["rows"]).toEqual([["Alpha", 10]]);
    expect(payload(inline)).not.toHaveProperty("resultId");
  });

  it("admits a result and its grouping sets together or not at all", async () => {
    budget.maxResults = 2;
    const client = await connect();
    const kept = payload(await aggregate(client, "small.csv"))["resultId"];
    expect(kept).toEqual(expect.any(String));
    expectRefused(
      await client.callTool({
        name: "aggregate_sheet",
        arguments: {
          filePath: "many.csv",
          groupBy: ["Customer"],
          groupingSets: [{ groupBy: [] }, { groupBy: [] }],
          metrics: [{ fn: "sum", column: "Amount" }],
          resultMode: "retained",
        },
      }),
    );
    const readable = await client.callTool({
      name: "query_result",
      arguments: { resultId: kept },
    });
    expect(payload(readable)["rows"]).toEqual([["Alpha", 10]]);
    const next = await aggregate(client);
    expect(next.isError).not.toBe(true);
    expect(payload(next)["resultId"]).toEqual(expect.any(String));
  });

  it("keeps a row for every grouping set when the primary preview fills the budget", async () => {
    budget.maxResultPageBytes = 1_700;
    const client = await connect();
    const result = await client.callTool({
      name: "aggregate_sheet",
      arguments: {
        filePath: "many.csv",
        groupBy: ["Customer"],
        groupingSets: [{ groupBy: [] }],
        metrics: [{ fn: "sum", column: "Amount" }],
        compact: true,
        resultMode: "retained",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_700);
    const body = payload(result);
    expect(body).toMatchObject({ totalRows: 12, hasMore: true });
    expect((body["rows"] as unknown[]).length).toBeLessThan(12);
    const [total] = body["groupingSets"] as Record<string, unknown>[];
    expect(total?.["rows"]).toEqual([[78]]);
  });

  it("does not admit an inaccessible result when even preview metadata cannot fit", async () => {
    budget.maxResults = 1;
    budget.maxResultPageBytes = 128;
    const client = await connect();
    const refused = await aggregate(client, "small.csv");
    expect(refused.isError).toBe(true);
    expect(payload(refused)).not.toHaveProperty("resultId");
    budget.maxResultPageBytes = 16_384;
    const recovered = await aggregate(client, "small.csv");
    expect(recovered.isError).not.toBe(true);
    expect(payload(recovered)).toMatchObject({
      rows: [["Alpha", 10]],
      resultComplete: true,
    });
    expect(payload(recovered)["resultId"]).toEqual(expect.any(String));
  });
});
