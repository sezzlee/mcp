import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createExcelMcpServer,
  createWorkbookOutput,
  createWorkbookRoot,
  type WriteCell,
} from "@sezzlee/excel-mcp";
import { z } from "zod";
import { prepareOutRoot } from "./run.ts";

const entry = fileURLToPath(import.meta.url);
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    rows: { type: "string" },
    columns: { type: "string" },
    worker: { type: "boolean" },
    "heap-mib": { type: "string" },
    dataset: { type: "string" },
  },
});
const options = z
  .object({
    out: z.string().min(1),
    rows: z.coerce.number().int().min(1).max(50_000).default(50_000),
    columns: z.coerce.number().int().min(1).max(20).default(20),
    heapMiB: z.coerce.number().int().min(512).max(2048).default(1024),
    worker: z.boolean().default(false),
    dataset: z.enum(["sequence", "mixed"]).default("sequence"),
  })
  .parse({ ...values, heapMiB: values["heap-mib"] });
const receiptSchema = z.object({
  kind: z.literal("complete"),
  version: z.object({ filePath: z.string(), versionId: z.string() }),
  sizeBytes: z.number(),
  changes: z.object({ cellsWritten: z.number() }),
});

function valueAt(row: number, column: number): WriteCell {
  if (options.dataset === "mixed") {
    switch (column) {
      case 0:
        return { kind: "text", value: String(row).padStart(8, "0") };
      case 1:
        return { kind: "number", value: row / 4 };
      case 2:
        return { kind: "boolean", value: row % 2 === 0 };
      case 3:
        return { kind: "blank" };
      case 4:
        return { kind: "text", value: "" };
      case 5:
        return { kind: "date", value: "2026-10-25" };
      case 6:
        return { kind: "datetime", value: "2026-10-25T09:30:00.125" };
      case 7:
        return { kind: "text", value: "  Türkçe 😀 <&> _x000D_\r\n  " };
    }
  }
  return { kind: "number", value: row * options.columns + column };
}

async function measure(): Promise<void> {
  await mkdir(join(options.out, "out"));
  const root = await createWorkbookRoot(options.out);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({ name: "write-bench", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const calls: {
    name: string;
    ms: number;
    inputBytes: number;
    responseBytes: number;
  }[] = [];
  async function call(name: string, args: Record<string, unknown>) {
    const inputBytes = Buffer.byteLength(JSON.stringify(args));
    const started = performance.now();
    const result = await client.callTool({ name, arguments: args });
    const text = result.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    assert.notEqual(result.isError, true, text);
    calls.push({
      name,
      ms: performance.now() - started,
      inputBytes,
      responseBytes: Buffer.byteLength(text),
    });
    return receiptSchema.parse(JSON.parse(text));
  }
  try {
    const create = await call("create_workbook", {
      sheets: [
        {
          name: "Sequence",
          blocks: [
            {
              startCell: "A1",
              values: Array.from({ length: options.rows }, (_, row) =>
                Array.from({ length: options.columns }, (_, column) =>
                  valueAt(row, column),
                ),
              ),
            },
          ],
        },
      ],
    });
    assert.equal(create.changes.cellsWritten, options.rows * options.columns);
    const original = await readFile(join(options.out, create.version.filePath));
    const digest = createHash("sha256").update(original).digest("hex");
    assert.equal(digest, create.version.versionId);
    const changes = [
      {
        kind: "write_cells",
        sheetName: "Sequence",
        startCell: "A1",
        overwrite: true,
        values: [[{ kind: "number", value: -1 }]],
      },
    ];
    const edit = await call("edit_workbook", {
      source: create.version,
      changes,
    });
    const retry = await call("edit_workbook", {
      source: create.version,
      changes,
    });
    assert.deepEqual(retry.version, edit.version);
    assert.notEqual(edit.version.versionId, create.version.versionId);
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(options.out, create.version.filePath)))
        .digest("hex"),
      digest,
    );
    const implementation = createHash("sha256");
    for (const name of [
      "format/authoring.js",
      "authoring/workbook.js",
      "authoring/values.js",
      "tools/writing.js",
      "platform/versions.js",
    ])
      implementation
        .update(name)
        .update(
          await readFile(
            new URL(`../../../servers/excel-mcp/dist/${name}`, import.meta.url),
          ),
        );
    const report = {
      status: "passed",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      rows: options.rows,
      columns: options.columns,
      cells: options.rows * options.columns,
      dataset: options.dataset,
      generatorSha256: createHash("sha256")
        .update(await readFile(entry))
        .digest("hex"),
      zipWriterSha256: createHash("sha256")
        .update(
          await readFile(
            new URL(
              "../../../cores/ooxml-core/dist/writer.js",
              import.meta.url,
            ),
          ),
        )
        .digest("hex"),
      heapMiB: options.heapMiB,
      maxRssKiB: process.resourceUsage().maxRSS,
      implementationSha256: implementation.digest("hex"),
      calls,
      create,
      edit,
    };
    await writeFile(
      join(options.out, "write-results.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    process.stdout.write(JSON.stringify(report) + "\n");
  } finally {
    await client.close();
    await server.close();
  }
}

if (options.worker) {
  await measure();
} else {
  const out = await mkdtemp(join(await prepareOutRoot(options.out), "write-"));
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
      "--heap-mib",
      String(options.heapMiB),
      "--dataset",
      options.dataset,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  process.stdout.write(stdout);
  process.stdout.write(`Evidence: ${out}\n`);
}
