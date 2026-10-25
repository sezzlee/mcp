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
  columnToLetters,
  createExcelMcpServer,
  createWorkbookOutput,
  createWorkbookRoot,
  writingToolDefinitions,
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
  },
});
const options = z
  .object({
    out: z.string().min(1),
    rows: z.coerce.number().int().min(1).max(50_000).default(50_000),
    columns: z.coerce.number().int().min(1).max(20).default(20),
    worker: z.boolean().default(false),
    heapMiB: z.coerce.number().int().min(512).max(2048).default(1024),
  })
  .parse({ ...values, heapMiB: values["heap-mib"] });
const version = z.object({ filePath: z.string(), versionId: z.string() });
const receipt = z.object({
  kind: z.literal("complete"),
  version,
  changes: z.object({ cellsWritten: z.number() }),
});
const ready = z.object({
  transfer: writingToolDefinitions.transfer_data.inputSchema.shape.transfer,
});

async function measure(): Promise<void> {
  await mkdir(join(options.out, "out"));
  const original =
    Array.from({ length: options.rows }, (_, row) =>
      Array.from({ length: options.columns }, (_, column) =>
        String(row * options.columns + column),
      ).join(","),
    ).join("\n") + "\n";
  await writeFile(join(options.out, "sequence.csv"), original);
  await writeFile(join(options.out, "patch.csv"), "-1\n");
  const sourceSha256 = createHash("sha256").update(original).digest("hex");
  const root = await createWorkbookRoot(options.out);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({ name: "transfer-bench", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const calls: {
    name: string;
    ms: number;
    inputBytes: number;
    responseBytes: number;
  }[] = [];
  await Promise.all([client.connect(a), server.connect(b)]);
  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const started = performance.now();
    const result = await client.callTool({ name, arguments: args });
    const text = result.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    assert.notEqual(result.isError, true, text);
    calls.push({
      name,
      ms: performance.now() - started,
      inputBytes: Buffer.byteLength(JSON.stringify(args)),
      responseBytes: Buffer.byteLength(text),
    });
    return JSON.parse(text);
  }
  try {
    const transfer = ready.parse(
      await call("prepare_transfer", {
        filePath: "sequence.csv",
        selection: {
          kind: "range",
          headerRow: 0,
          range: `A1:${columnToLetters(options.columns)}${options.rows}`,
          columns: Array.from({ length: options.columns }, (_, offset) => ({
            column: columnToLetters(offset + 1),
            type: "number",
            decimal: ".",
          })),
        },
      }),
    ).transfer;
    const create = receipt.parse(
      await call("transfer_data", {
        transfer,
        target: { kind: "new", sheetName: "Sequence" },
      }),
    );
    assert.equal(create.changes.cellsWritten, options.rows * options.columns);
    const patch = ready.parse(
      await call("prepare_transfer", {
        filePath: "patch.csv",
        selection: {
          kind: "range",
          range: "A1",
          headerRow: 0,
          columns: [{ column: "A", type: "number", decimal: "." }],
        },
      }),
    ).transfer;
    const target = {
      kind: "sheet",
      source: create.version,
      sheetName: "Sequence",
      startCell: "A1",
      overwrite: true,
    };
    const edit = receipt.parse(
      await call("transfer_data", { transfer: patch, target }),
    );
    const retry = receipt.parse(
      await call("transfer_data", { transfer: patch, target }),
    );
    assert.deepEqual(retry.version, edit.version);
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(options.out, "sequence.csv")))
        .digest("hex"),
      sourceSha256,
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(options.out, create.version.filePath)))
        .digest("hex"),
      create.version.versionId,
    );
    const implementation = createHash("sha256");
    for (const name of [
      "tools/transfer.js",
      "tools/transfer-schemas.js",
      "tools/writing.js",
      "platform/versions.js",
      "format/ooxml-cell.js",
      "format/authoring.js",
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
      heapMiB: options.heapMiB,
      maxRssKiB: process.resourceUsage().maxRSS,
      generatorSha256: createHash("sha256")
        .update(await readFile(entry))
        .digest("hex"),
      implementationSha256: implementation.digest("hex"),
      sourceSha256,
      calls,
      create,
      edit,
    };
    await writeFile(
      join(options.out, "transfer-results.json"),
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
  const out = await mkdtemp(
    join(await prepareOutRoot(options.out), "transfer-"),
  );
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
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-32_000);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8_000);
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, stderr);
    process.stdout.write(
      JSON.stringify({
        out,
        ...z
          .object({
            cells: z.number(),
            maxRssKiB: z.number(),
            calls: z.array(z.unknown()),
          })
          .parse(JSON.parse(stdout)),
      }) + "\n",
    );
  } finally {
    clearTimeout(timer);
  }
}
