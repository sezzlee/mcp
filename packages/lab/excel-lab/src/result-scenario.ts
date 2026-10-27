import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createExcelMcpServer,
  createWorkbookRoot,
  limits,
} from "@sezzlee/excel-mcp";
import { z } from "zod";
import { commitOf, prepareOutRoot } from "./run.ts";

const rowsSchema = z.array(z.array(z.unknown()));
const aggregateArguments = z
  .object({ filePath: z.string().min(1) })
  .catchall(z.unknown());
const queryArguments = z.strictObject({
  columns: z.array(z.int().positive()).optional(),
  where: z
    .array(
      z.strictObject({
        column: z.int().positive(),
        equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      }),
    )
    .optional(),
  maxRows: z.int().positive().optional(),
});

export const resultScenarioSchema = z.strictObject({
  schemaVersion: z.literal(1),
  label: z.string().min(1),
  referenceDate: z.string().optional(),
  aggregate: aggregateArguments,
  expected: z.strictObject({
    scannedRows: z.int().nonnegative(),
    matchedRows: z.int().nonnegative(),
    resultRows: z.int().nonnegative(),
    previewMaxRows: z.int().positive(),
  }),
  queries: z
    .array(
      z.strictObject({
        arguments: queryArguments,
        rows: rowsSchema,
        matchingSourceRows: z.int().nonnegative(),
      }),
    )
    .min(1),
  inline: z
    .strictObject({ aggregate: aggregateArguments, rows: rowsSchema })
    .optional(),
});

const retainedPageSchema = z.object({
  resultId: z.string().min(1),
  sourceVersion: z.string().min(1),
  sourcePolicy: z.literal("snapshot"),
  resultComplete: z.literal(true),
  sampled: z.literal(false),
  preview: z.boolean(),
  totalRows: z.int().nonnegative(),
  matchingRows: z.int().nonnegative(),
  matchingSourceRows: z.int().nonnegative(),
  returnedRows: z.int().nonnegative(),
  offset: z.int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.int().nonnegative().optional(),
  scannedRows: z.int().nonnegative(),
  matchedRows: z.int().nonnegative(),
  groupCount: z.int().nonnegative(),
  rows: rowsSchema,
});

function customer(number: number): string {
  return `C${String(number).padStart(4, "0")}`;
}

/** Generates an original synthetic fixture and independent known answers outside the repository. */
export async function generateResultScenario(outRoot: string): Promise<{
  root: string;
  scenario: string;
}> {
  const root = await mkdtemp(join(await prepareOutRoot(outRoot), "payments-"));
  const makeCsv = (customers: number): string => {
    const lines = ["Customer,Due,Paid,Amount"];
    for (let n = 1; n <= customers; n += 1) {
      lines.push(
        `${customer(n)},2026-10-01,false,${100 + n}`,
        `${customer(n)},2026-10-14,false,${25 + n / 4}`,
        `${customer(n)},2026-10-01,true,99999`,
        `${customer(n)},2026-10-15,false,88888`,
        `${customer(n)},2026-10-16,false,77777`,
      );
    }
    return `${lines.join("\n")}\n`;
  };
  const aggregate = {
    filePath: "payments.csv",
    delimiter: "comma",
    headerRow: 1,
    columnMode: "header",
    columns: [
      { column: "Customer", type: "text" },
      { column: "Due", type: "date", format: "yyyy-MM-dd" },
      {
        column: "Paid",
        type: "boolean",
        trueValues: ["true"],
        falseValues: ["false"],
      },
      { column: "Amount", type: "number", decimal: ".", group: "none" },
    ],
    groupBy: ["Customer"],
    metrics: [{ fn: "sum", column: "Amount" }, { fn: "count" }],
    where: [
      { column: "Due", op: "lt", value: "2026-10-15" },
      { column: "Paid", op: "eq", value: false },
    ],
    orderBy: "group",
    descending: false,
  };
  const scenario = resultScenarioSchema.parse({
    schemaVersion: 1,
    label: "overdue-payments-v1",
    referenceDate: "2026-10-15",
    aggregate,
    expected: {
      scannedRows: 6000,
      matchedRows: 2400,
      resultRows: 1200,
      previewMaxRows: 50,
    },
    queries: [
      {
        arguments: {
          columns: [1, 2, 3],
          where: [{ column: 1, equals: "C1200" }],
          maxRows: 5,
        },
        rows: [["C1200", 1625, 2]],
        matchingSourceRows: 2,
      },
      {
        arguments: { columns: [1, 2], maxRows: 137 },
        rows: Array.from({ length: 1200 }, (_, index) => [
          customer(index + 1),
          125 + 1.25 * (index + 1),
        ]),
        matchingSourceRows: 2400,
      },
    ],
    inline: {
      aggregate: { ...aggregate, filePath: "payments-small.csv" },
      rows: [
        ["C0001", 126.25, 2],
        ["C0002", 127.5, 2],
        ["C0003", 128.75, 2],
      ],
    },
  });
  await writeFile(join(root, "payments.csv"), makeCsv(1200));
  await writeFile(join(root, "payments-small.csv"), makeCsv(3));
  const scenarioPath = join(root, "scenario.json");
  await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  return { root, scenario: scenarioPath };
}

/** Verifies a saved scenario through MCP and records exact tool responses outside the repository. */
export async function runResultScenario(input: {
  readonly root: string;
  readonly scenario: string;
  readonly outRoot: string;
}) {
  const scenarioBytes = await readFile(input.scenario);
  const scenario = resultScenarioSchema.parse(
    JSON.parse(scenarioBytes.toString("utf8")),
  );
  const runDir = await mkdtemp(
    join(await prepareOutRoot(input.outRoot), "result-run-"),
  );
  const server = createExcelMcpServer(await createWorkbookRoot(input.root));
  const client = new Client({
    name: "excel-result-scenario",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const calls: {
    name: string;
    durationMs: number;
    textBytes: number;
    responseBytes: number;
    returnedRows?: number;
  }[] = [];
  const request = async (name: string, args: Record<string, unknown>) => {
    const started = performance.now();
    const answer = await client.callTool({ name, arguments: args });
    const durationMs = performance.now() - started;
    const text = answer.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    const payload: unknown = JSON.parse(text);
    const count = z.object({ returnedRows: z.number() }).safeParse(payload);
    calls.push({
      name,
      durationMs,
      textBytes: Buffer.byteLength(text, "utf8"),
      responseBytes: Buffer.byteLength(JSON.stringify(answer), "utf8"),
      ...(count.success ? { returnedRows: count.data.returnedRows } : {}),
    });
    await writeFile(
      join(runDir, `call-${calls.length}.json`),
      `${JSON.stringify({ request: { name, arguments: args }, response: answer }, null, 2)}\n`,
    );
    assert.notEqual(answer.isError, true, text);
    assert.ok(
      Buffer.byteLength(JSON.stringify(answer), "utf8") <=
        limits.maxPayloadBytes,
    );
    if (name === "query_result" || args["resultMode"] === "retained")
      assert.ok(
        Buffer.byteLength(JSON.stringify(answer), "utf8") <=
          limits.maxResultPageBytes,
      );
    return payload;
  };
  let previewRows = 0;
  let verifiedRows = 0;
  let sourceRows: number | null = null;
  let matchedRows: number | null = null;
  let resultRows: number | null = null;
  let sourceVersion: string | null = null;
  let failure: string | undefined;
  try {
    await request("list_workbooks", {});
    await request("describe_workbook", {
      filePath: scenario.aggregate.filePath,
      ...(scenario.aggregate["delimiter"] === undefined
        ? {}
        : { delimiter: scenario.aggregate["delimiter"] }),
      ...(scenario.aggregate["encoding"] === undefined
        ? {}
        : { encoding: scenario.aggregate["encoding"] }),
    });
    if (scenario.inline !== undefined) {
      const { resultMode: _mode, ...inlineArguments } =
        scenario.inline.aggregate;
      const inline = z
        .object({
          rows: rowsSchema,
          truncated: z.literal(false),
          resultId: z.undefined().optional(),
        })
        .parse(await request("aggregate_sheet", inlineArguments));
      assert.deepEqual(inline.rows, scenario.inline.rows);
    }
    const initial = retainedPageSchema.parse(
      await request("aggregate_sheet", {
        ...scenario.aggregate,
        resultMode: "retained",
      }),
    );
    sourceRows = initial.scannedRows;
    matchedRows = initial.matchedRows;
    resultRows = initial.totalRows;
    sourceVersion = initial.sourceVersion;
    assert.equal(initial.preview, true);
    assert.equal(initial.scannedRows, scenario.expected.scannedRows);
    assert.equal(initial.matchedRows, scenario.expected.matchedRows);
    assert.equal(initial.groupCount, scenario.expected.resultRows);
    assert.equal(initial.totalRows, scenario.expected.resultRows);
    assert.equal(initial.matchingRows, scenario.expected.resultRows);
    assert.equal(initial.returnedRows, initial.rows.length);
    assert.ok(initial.rows.length <= scenario.expected.previewMaxRows);
    assert.equal(initial.hasMore, initial.returnedRows < initial.totalRows);
    previewRows = initial.returnedRows;
    for (const query of scenario.queries) {
      let offset = 0;
      const found: unknown[][] = [];
      do {
        const page = retainedPageSchema.parse(
          await request("query_result", {
            ...query.arguments,
            resultId: initial.resultId,
            offset,
          }),
        );
        assert.equal(page.preview, false);
        assert.equal(page.resultId, initial.resultId);
        assert.equal(page.sourceVersion, initial.sourceVersion);
        assert.equal(page.totalRows, scenario.expected.resultRows);
        assert.equal(page.matchingRows, query.rows.length);
        assert.equal(page.matchingSourceRows, query.matchingSourceRows);
        assert.equal(page.offset, offset);
        assert.equal(page.returnedRows, page.rows.length);
        assert.deepEqual(
          page.rows,
          query.rows.slice(offset, offset + page.returnedRows),
        );
        found.push(...page.rows);
        assert.ok(found.length <= query.rows.length);
        assert.equal(page.hasMore, found.length < query.rows.length);
        if (!page.hasMore) {
          assert.equal(page.nextOffset, undefined);
          break;
        }
        assert.ok(page.returnedRows > 0, "A continuation must make progress");
        assert.equal(page.nextOffset, offset + page.returnedRows);
        offset += page.returnedRows;
      } while (offset < query.rows.length);
      assert.deepEqual(found, query.rows);
      verifiedRows += found.length;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await client.close();
    await server.close();
  }
  const report = {
    status: failure === undefined ? "passed" : "failed",
    label: scenario.label,
    referenceDate: scenario.referenceDate ?? null,
    sourceCommit: commitOf(
      fileURLToPath(new URL("../../../../", import.meta.url)),
    ),
    node: process.version,
    server: client.getServerVersion(),
    scenarioSha256: createHash("sha256").update(scenarioBytes).digest("hex"),
    sourceVersion,
    sourceRows,
    matchedRows,
    resultRows,
    previewRows,
    verifiedRows,
    calls,
    maxRssKiB: process.resourceUsage().maxRSS,
    measurementScope:
      "Durations cover each MCP call, excluding fixture generation and report writes. Bytes are UTF-8 text content and serialized CallToolResult, excluding JSON-RPC framing. maxRssKiB is the entire process peak, including fixture generation, client and server; it is not per-call memory. No model or tokenizer was used.",
    runDir,
    ...(failure === undefined ? {} : { failure }),
  };
  await writeFile(
    join(runDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (failure !== undefined)
    throw new Error(`${failure}\nReport: ${join(runDir, "report.json")}`);
  return report;
}
