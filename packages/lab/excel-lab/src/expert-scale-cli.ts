import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createExcelMcpServer,
  createWorkbookOutput,
  createWorkbookRoot,
} from "@sezzlee/excel-mcp";
import { z } from "zod";
import { prepareOutRoot } from "./run.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    rows: { type: "string", default: "24999" },
  },
});
const options = z
  .object({
    out: z.string().min(1),
    rows: z.coerce.number().int().min(10000).max(24999),
  })
  .parse(values);
const directory = await prepareOutRoot(options.out);
await mkdir(join(directory, "out"));
const root = await createWorkbookRoot(directory);
const server = createExcelMcpServer(root, {
  mode: "write",
  output: await createWorkbookOutput(root, "out"),
});
const client = new Client({ name: "expert-scale-acceptance", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
const versionSchema = z.object({
  version: z.object({ filePath: z.string(), versionId: z.string() }),
});
const text = (value: string) => ({ kind: "text", value });
const number = (value: number) => ({ kind: "number", value });
try {
  await Promise.all([client.connect(a), server.connect(b)]);
  async function call(name: string, args: Record<string, unknown>) {
    const response = await client.callTool({ name, arguments: args });
    const first = response.content[0];
    assert(first !== undefined && first.type === "text");
    assert(!response.isError, first.text);
    return versionSchema.parse(JSON.parse(first.text)).version;
  }
  const values = [
    [text("Region"), text("Amount"), text("Active"), text("Label")],
    ...Array.from({ length: options.rows }, (_, i) => [
      text(`R${(i + 1) % 100}`),
      number(i + 1),
      { kind: "boolean", value: i % 2 === 0 },
      text(`row-${i + 1}`),
    ]),
  ];
  const started = performance.now();
  const source = await call("create_workbook", {
    sheets: [
      { name: "Data", blocks: [{ startCell: "A1", values }] },
      { name: "Report", blocks: [] },
    ],
  });
  const hash = createHash("sha256")
    .update(await readFile(join(directory, source.filePath)))
    .digest("hex");
  const output = await call("edit_workbook", {
    source,
    changes: [
      {
        kind: "set_pivot",
        sheetName: "Report",
        name: "Regional",
        cell: "A1",
        sourceSheet: "Data",
        sourceRange: `A1:D${options.rows + 1}`,
        rowColumn: "Region",
        measures: [
          { column: "Amount", function: "sum", name: "Total" },
          { column: "Amount", function: "count", name: "Entries" },
        ],
      },
      {
        kind: "set_chart",
        sheetName: "Report",
        name: "Trend",
        chartType: "line",
        cell: "E1",
        series: [
          {
            name: "Amount",
            sheetName: "Data",
            categories: "A2:A10001",
            values: "B2:B10001",
          },
        ],
      },
    ],
  });
  const runtimeMs = performance.now() - started;
  const python = await promisify(execFile)(
    "python3",
    [
      "-I",
      fileURLToPath(new URL("../scripts/expert-oracle.py", import.meta.url)),
      join(directory, output.filePath),
      "--summary",
    ],
    { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
  );
  const checked = z
    .object({
      pivots: z.array(
        z.object({
          rows: z.number(),
          result: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
        }),
      ),
      charts: z.array(
        z.object({
          series: z.array(z.object({ numericValues: z.array(z.number()) })),
        }),
      ),
    })
    .parse(JSON.parse(python.stdout));
  assert.equal(checked.pivots[0]?.rows, options.rows);
  assert.deepEqual(checked.pivots[0]?.result.at(-1), [
    "Grand Total",
    (options.rows * (options.rows + 1)) / 2,
    options.rows,
  ]);
  assert.equal(checked.charts[0]?.series[0]?.numericValues.length, 10000);
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(directory, source.filePath)))
      .digest("hex"),
    hash,
  );
  const record = {
    passed: true,
    sourceCells: (options.rows + 1) * 4,
    records: options.rows,
    chartPoints: 10000,
    rowGroups: 100,
    runtimeMs,
    maxRSSKiB: process.resourceUsage().maxRSS,
    sourceUnchanged: true,
    output,
  };
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(record, null, 2),
  );
  console.log(JSON.stringify(record));
} finally {
  await client.close();
  await server.close();
}
