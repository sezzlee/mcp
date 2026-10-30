import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  createExcelMcpServer,
  createWorkbookRoot,
  createWorkbookOutput,
  columnToLetters,
  writingToolDefinitions,
  workbookVersionSchema,
  bulkJobSchema,
  bulkGroupReceiptSchema,
  bulkBatchReceiptSchema,
  type BulkGroupReceipt,
} from "@sezzlee/excel-mcp";
import { prepareOutRoot } from "./run.ts";

const entry = fileURLToPath(import.meta.url);
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    rows: { type: "string" },
    columns: { type: "string" },
    operation: { type: "string" },
    worker: { type: "boolean" },
    "heap-mib": { type: "string" },
  },
});
const options = z
  .object({
    out: z.string().min(1),
    rows: z.coerce.number().int().min(2).max(99_999).default(10_000),
    columns: z.coerce.number().int().min(3).max(20).default(10),
    operation: z
      .enum([
        "update",
        "replace",
        "upsert",
        "append",
        "join",
        "sort",
        "deduplicate",
        "atomic",
        "independent",
      ])
      .default("update"),
    worker: z.boolean().default(false),
    heapMiB: z.coerce.number().int().min(512).max(2048).default(1024),
  })
  .parse({ ...values, heapMiB: values["heap-mib"] });
function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function payload(result: { readonly content: readonly unknown[] }): unknown {
  const block = result.content[0];
  if (
    typeof block !== "object" ||
    block === null ||
    !("text" in block) ||
    typeof block.text !== "string"
  )
    throw new Error("Expected JSON result");
  return JSON.parse(block.text);
}

async function measure(): Promise<void> {
  await mkdir(join(options.out, "out"));
  const headers = [
    "Id",
    "Group",
    "Value",
    ...Array.from({ length: options.columns - 3 }, (_, i) => `C${i + 3}`),
  ];
  const source =
    headers.join(",") +
    "\n" +
    Array.from({ length: options.rows }, (_, r) =>
      [
        "id" + r,
        ...Array.from({ length: options.columns - 1 }, (_, i) =>
          i === 0 ? r % 10 : i === 1 ? r : r * options.columns + i + 1,
        ),
      ].join(","),
    ).join("\n") +
    "\n";
  const paths: Record<string, string> = {};
  async function save(name: string, text: string) {
    await writeFile(join(options.out, name), text);
    paths[name] = digest(text);
  }
  await save("source.csv", source);
  const root = await createWorkbookRoot(options.out),
    server = createExcelMcpServer(root, {
      mode: "write",
      output: await createWorkbookOutput(root, "out"),
    });
  const client = new Client({ name: "bulk-scale-evidence", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  const calls: {
    tool: string;
    ms: number;
    requestBytes: number;
    responseBytes: number;
  }[] = [];
  async function call(tool: string, args: Record<string, unknown>) {
    const start = performance.now(),
      response = await client.callTool({ name: tool, arguments: args });
    calls.push({
      tool,
      ms: performance.now() - start,
      requestBytes: Buffer.byteLength(JSON.stringify(args)),
      responseBytes: Buffer.byteLength(JSON.stringify(response)),
    });
    assert.notEqual(response.isError, true, JSON.stringify(payload(response)));
    return payload(response);
  }
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const selection = {
      kind: "range",
      headerRow: 0,
      columns: headers
        .slice(1)
        .map((column) => ({ column, type: "number", decimal: "." })),
      range: `A1:${columnToLetters(options.columns)}${options.rows + 1}`,
    };
    const ready = await call("prepare_transfer", {
      filePath: "source.csv",
      selection: {
        ...selection,
        kind: "records",
        headerRow: 1,
        includeHeaders: true,
      },
    });
    const transfer = z
      .object({
        transfer:
          writingToolDefinitions.transfer_data.inputSchema.shape.transfer,
      })
      .parse(ready).transfer;
    const seed = z
      .object({
        version: workbookVersionSchema,
      })
      .parse(
        await call("transfer_data", {
          transfer,
          target: { kind: "new", sheetName: "S" },
        }),
      ).version;
    paths[seed.filePath] = digest(
      await readFile(join(options.out, seed.filePath)),
    );
    const read = {
      kind: "read",
      id: "source",
      source: seed,
      selection: {
        kind: "records",
        sheetName: "S",
        range: `A1:${columnToLetters(options.columns)}${options.rows + 1}`,
        headerRow: 1,
      },
    };
    const steps: unknown[] = [read];
    let input = "source";
    let edit = false;
    async function csvRead(
      name: string,
      text: string,
      id: string,
      width = options.columns,
      count = options.rows,
    ) {
      await save(name, text);
      steps.push({
        kind: "read",
        id,
        source: { filePath: name, versionId: paths[name] },
        selection: {
          kind: "records",
          range: `A1:${columnToLetters(width)}${count + 1}`,
          headerRow: 1,
          columns: headers
            .slice(1, width)
            .map((column) => ({ column, type: "number", decimal: "." })),
        },
      });
    }
    switch (options.operation) {
      case "update":
        steps.push({
          kind: "update",
          id: "result",
          input,
          where: [{ column: "Group", op: "eq", value: 3 }],
          set: [{ column: "Value", value: { kind: "number", value: -1 } }],
        });
        input = "result";
        edit = true;
        break;
      case "replace": {
        const count = Math.floor(options.rows * 0.8),
          text =
            headers.join(",") +
            "\n" +
            Array.from({ length: count }, (_, r) =>
              [
                "new" + r,
                ...Array.from(
                  { length: options.columns - 1 },
                  (_, i) => 100000 + r * options.columns + i + 1,
                ),
              ].join(","),
            ).join("\n") +
            "\n";
        await csvRead(
          "replacement.csv",
          text,
          "replacement",
          options.columns,
          count,
        );
        steps.push({
          kind: "replace",
          id: "result",
          target: input,
          source: "replacement",
        });
        input = "result";
        edit = true;
        break;
      }
      case "upsert": {
        const count = Math.max(2, Math.floor(options.rows / 10)),
          text =
            headers.join(",") +
            "\n" +
            Array.from({ length: count }, (_, r) =>
              [
                (r % 2 === 0 ? "id" : "new") + r,
                ...Array.from(
                  { length: options.columns - 1 },
                  (_, i) => -1 - r * options.columns - i,
                ),
              ].join(","),
            ).join("\n") +
            "\n";
        await csvRead("changes.csv", text, "changes", options.columns, count);
        steps.push({
          kind: "upsert",
          id: "result",
          target: input,
          source: "changes",
          keys: [{ sourceColumn: "Id", targetColumn: "Id" }],
          set: headers
            .slice(1)
            .map((column) => ({ sourceColumn: column, targetColumn: column })),
        });
        input = "result";
        edit = true;
        break;
      }
      case "append":
        steps.push({
          kind: "append",
          id: "result",
          inputs: [input, input],
          columns: headers,
        });
        input = "result";
        break;
      case "join": {
        const text =
          "Id,Group,Value\n" +
          Array.from(
            { length: options.rows },
            (_, r) => `id${r},${r % 10},${-r - 1}`,
          ).join("\n") +
          "\n";
        await csvRead("right.csv", text, "right", 3);
        steps.push({
          kind: "join",
          id: "result",
          left: input,
          right: "right",
          join: "left",
          keys: [{ sourceColumn: "Id", targetColumn: "Id" }],
          columns: [
            { side: "left", column: "Id", as: "Id" },
            { side: "right", column: "Group", as: "Group" },
            { side: "right", column: "Value", as: "Value" },
          ],
        });
        input = "result";
        break;
      }
      case "sort":
        steps.push({
          kind: "sort",
          id: "result",
          input,
          by: [{ column: "Value", direction: "desc", blanks: "last" }],
        });
        input = "result";
        edit = true;
        break;
      case "deduplicate": {
        const text =
          headers.join(",") +
          "\n" +
          Array.from({ length: options.rows }, (_, r) =>
            [
              "id" + Math.floor(r / 2),
              ...Array.from(
                { length: options.columns - 1 },
                (_, i) => r * options.columns + i + 1,
              ),
            ].join(","),
          ).join("\n") +
          "\n";
        steps.length = 0;
        await csvRead("duplicates.csv", text, "duplicates");
        steps.push({
          kind: "deduplicate",
          id: "result",
          input: "duplicates",
          keys: ["Id"],
          keep: "last",
        });
        input = "result";
        break;
      }
      case "atomic":
        steps.push({
          kind: "project",
          id: "projected",
          input,
          columns: headers
            .slice(0, 3)
            .map((column) => ({ column, as: column })),
        });
        break;
      case "independent":
        break;
    }
    const output = edit
      ? {
          kind: "edit",
          id: "report",
          target: "source",
          input,
          mode:
            options.operation === "update" || options.operation === "upsert"
              ? "changed_values"
              : "replace_values",
          overwrite: true,
        }
      : { kind: "new", id: "report", sheets: [{ name: "S", input }] };
    const group = {
      steps,
      outputs: [
        output,
        ...(options.operation === "atomic"
          ? [
              {
                kind: "new",
                id: "summary",
                sheets: [{ name: "S", input: "projected" }],
              },
            ]
          : []),
      ],
    };
    const job = bulkJobSchema.parse(
      options.operation !== "independent"
        ? { kind: "dependent", group }
        : {
            kind: "independent",
            jobs: Array.from({ length: 10 }, (_, i) => ({
              id: `report${i}`,
              group: {
                steps: [
                  i === 7
                    ? {
                        ...read,
                        source: { ...read.source, filePath: "missing.xlsx" },
                      }
                    : read,
                  {
                    kind: "transform",
                    id: "numbered",
                    input: "source",
                    transformations: [
                      {
                        kind: "constant",
                        column: "Batch",
                        value: { kind: "number", value: i },
                      },
                    ],
                  },
                ],
                outputs: [
                  {
                    kind: "new",
                    id: "report",
                    sheets: [{ name: "S", input: "numbered" }],
                  },
                ],
              },
            })),
          },
    );
    if (options.operation === "independent") {
      const first = bulkBatchReceiptSchema.parse(
        await call("run_bulk_job", { job }),
      );
      assert.equal(first.kind, "partial");
      assert.equal(
        first.jobs.filter((child) => child.kind === "complete").length,
        9,
      );
      await writeFile(
        join(options.out, "missing.xlsx"),
        await readFile(join(options.out, seed.filePath)),
      );
      paths["missing.xlsx"] = paths[seed.filePath] ?? "";
    } else {
      const prepared = await call("prepare_bulk_job", { job });
      assert.equal(
        z.object({ kind: z.string() }).parse(prepared).kind,
        "ready",
      );
    }
    const result = await call("run_bulk_job", { job }),
      replay = await call("run_bulk_job", { job });
    assert.deepEqual(replay, result);
    const results: BulkGroupReceipt[] = [];
    if (options.operation === "independent") {
      for (const child of bulkBatchReceiptSchema.parse(result).jobs)
        if (child.kind === "complete")
          results.push(
            child.details === "full"
              ? child.result
              : bulkGroupReceiptSchema.parse(
                  await call("get_bulk_job", { jobId: child.result.jobId }),
                ),
          );
    } else results.push(bulkGroupReceiptSchema.parse(result));
    for (const [path, hash] of Object.entries(paths))
      assert.equal(
        digest(await readFile(join(options.out, path))),
        hash,
        `Changed input ${path}`,
      );
    const implementation = createHash("sha256");
    for (const name of [
      "bulk-dataset",
      "bulk-jobs",
      "bulk-output",
      "bulk-job-schemas",
      "writing",
      "transfer",
    ]) {
      implementation.update(
        await readFile(
          new URL(
            `../../../servers/excel-mcp/dist/tools/${name}.js`,
            import.meta.url,
          ),
        ),
      );
    }
    for (const path of [
      "servers/excel-mcp/dist/authoring/bulk-key.js",
      "servers/excel-mcp/dist/platform/versions.js",
      "servers/excel-mcp/dist/format/bulk-table.js",
      "cores/file-core-native/index.js",
      "cores/file-core-native/src/secure.cc",
      "cores/file-core-native/build.mjs",
    ])
      implementation.update(
        await readFile(new URL(`../../../${path}`, import.meta.url)),
      );
    const report = {
      operation: options.operation,
      rows: options.rows,
      columns: options.columns,
      heapMiB: options.heapMiB,
      maxRssKiB: process.resourceUsage().maxRSS,
      generatorSha256: digest(await readFile(entry)),
      implementationSha256: implementation.digest("hex"),
      inputs: paths,
      calls,
      results,
      job,
    };
    await writeFile(
      join(options.out, "bulk-results.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    process.stdout.write(
      JSON.stringify({
        operation: options.operation,
        maxRssKiB: report.maxRssKiB,
        calls,
      }) + "\n",
    );
  } finally {
    await client.close();
    await server.close();
  }
}
if (options.worker) await measure();
else {
  const out = await mkdtemp(join(await prepareOutRoot(options.out), "bulk-"));
  const child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${options.heapMiB}`,
      entry,
      "--worker",
      "--out",
      out,
      "--rows",
      String(options.rows),
      "--columns",
      String(options.columns),
      "--operation",
      options.operation,
      "--heap-mib",
      String(options.heapMiB),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    stdout = (stdout + data.toString()).slice(-16000);
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8000);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, stderr);
    process.stdout.write(JSON.stringify({ out, ...JSON.parse(stdout) }) + "\n");
  } finally {
    clearTimeout(timer);
  }
}
