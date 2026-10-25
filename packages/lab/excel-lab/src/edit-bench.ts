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
  createWorkbookRoot,
  createWorkbookOutput,
} from "@sezzlee/excel-mcp";
import { zipSync, strToU8, type Zippable } from "fflate";
import { z } from "zod";
import { prepareOutRoot } from "./run.ts";

const entry = fileURLToPath(import.meta.url);
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    rows: { type: "string" },
    columns: { type: "string" },
    operation: { type: "string" },
    "heap-mib": { type: "string" },
    worker: { type: "boolean" },
  },
});
const options = z
  .object({
    out: z.string().min(1),
    rows: z.coerce.number().int().min(50).max(50000).default(50000),
    columns: z.coerce.number().int().min(2).max(20).default(20),
    operation: z.enum(["write", "rows", "columns", "copy"]).default("write"),
    heapMiB: z.coerce.number().int().min(512).max(2048).default(1024),
    worker: z.boolean().default(false),
  })
  .refine((value) => value.operation !== "copy" || value.rows >= 1024, {
    message: "The copy benchmark requires at least 1024 rows.",
  })
  .parse({ ...values, heapMiB: values["heap-mib"] });
const receipt = z.object({
  kind: z.literal("complete"),
  version: z.object({
    filePath: z.string(),
    versionId: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  editing: z.object({
    operations: z.number(),
    partsChanged: z.number(),
    recalculated: z.literal(false),
    recalculationRequired: z.boolean(),
  }),
});
const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const office =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rel = "http://schemas.openxmlformats.org/package/2006/relationships";

function letters(number: number): string {
  let result = "";
  while (number > 0) {
    number -= 1;
    result = String.fromCharCode(65 + (number % 26)) + result;
    number = Math.floor(number / 26);
  }
  return result;
}

async function fixture(): Promise<Buffer> {
  const rows: string[] = [];
  for (let row = 1; row <= options.rows; row += 1) {
    const cells: string[] = [];
    for (let column = 1; column <= options.columns; column += 1)
      cells.push(
        `<c r="${letters(column)}${row}" t="n"><v>${(row - 1) * options.columns + column - 1}</v></c>`,
      );
    rows.push(`<row r="${row}">${cells.join("")}</row>`);
  }
  const parts: Record<string, string> = {
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels": `<Relationships xmlns="${rel}"><Relationship Id="book" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="${main}" xmlns:r="${office}"><sheets><sheet name="Sequence" sheetId="1" r:id="sheet"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${rel}"><Relationship Id="sheet" Type="${office}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${main}"><dimension ref="A1:${letters(options.columns)}${options.rows}"/><sheetData>${rows.join("")}</sheetData></worksheet>`,
    "customXml/retained.xml":
      '<retained xmlns="urn:edit-bench">Keep these exact bytes.</retained>',
  };
  const archive: Zippable = {};
  for (const [name, xml] of Object.entries(parts))
    archive[name] = [strToU8(xml), { mtime: new Date("1980-01-01T00:00:00Z") }];
  return Buffer.from(zipSync(archive, { level: 1 }));
}

async function measure(): Promise<void> {
  await mkdir(join(options.out, "out"));
  const bytes = await fixture();
  await writeFile(join(options.out, "source.xlsx"), bytes);
  const source = {
    filePath: "source.xlsx",
    versionId: createHash("sha256").update(bytes).digest("hex"),
  };
  const root = await createWorkbookRoot(options.out);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({ name: "edit-bench", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const at = options.operation === "columns" ? 2 : Math.floor(options.rows / 2);
  const changes =
    options.operation === "write"
      ? [
          {
            kind: "write_cells",
            sheetName: "Sequence",
            startCell: "A1",
            overwrite: true,
            values: [[{ kind: "number", value: -1 }]],
          },
        ]
      : options.operation === "copy"
        ? [
            {
              kind: "copy_range",
              sheetName: "Sequence",
              range: `A1:${letters(options.columns)}25`,
              targetSheet: "Sequence",
              startCell: "A1000",
              mode: "all",
              overwrite: true,
            },
          ]
        : [
            {
              kind:
                options.operation === "rows" ? "insert_rows" : "insert_columns",
              sheetName: "Sequence",
              at,
              count: 1,
            },
          ];
  const calls: { ms: number; requestBytes: number; receiptBytes: number }[] =
    [];
  async function call() {
    const args = { source, changes };
    const started = performance.now();
    const result = await client.callTool({
      name: "edit_workbook",
      arguments: args,
    });
    const text = result.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n");
    assert.notEqual(result.isError, true, text);
    calls.push({
      ms: performance.now() - started,
      requestBytes: Buffer.byteLength(JSON.stringify(args)),
      receiptBytes: Buffer.byteLength(text),
    });
    return receipt.parse(JSON.parse(text));
  }
  try {
    const edit = await call();
    const retry = await call();
    assert.deepEqual(edit.version, retry.version);
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(options.out, "source.xlsx")))
        .digest("hex"),
      source.versionId,
    );
    const implementation = createHash("sha256");
    for (const file of [
      "format/preserved-workbook.js",
      "format/xml-edit.js",
      "format/formula-edit.js",
      "format/edit-workbook.js",
      "tools/writing.js",
    ])
      implementation
        .update(file)
        .update(
          await readFile(
            new URL(`../../../servers/excel-mcp/dist/${file}`, import.meta.url),
          ),
        );
    const report = {
      status: "passed",
      dataset: "sequence",
      rows: options.rows,
      columns: options.columns,
      operation: options.operation,
      at,
      source,
      edit,
      retry,
      calls,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      heapMiB: options.heapMiB,
      maxRssKiB: process.resourceUsage().maxRSS,
      generatorSha256: createHash("sha256")
        .update(await readFile(entry))
        .digest("hex"),
      implementationSha256: implementation.digest("hex"),
    };
    await writeFile(
      join(options.out, "edit-results.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    process.stdout.write(
      JSON.stringify({
        out: options.out,
        status: "passed",
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
  const root = await prepareOutRoot(options.out);
  const out = await mkdtemp(join(root, "edit-"));
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
  let log = "";
  child.stdout.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 180000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  clearTimeout(watchdog);
  await writeFile(join(out, "worker.log"), log);
  process.stdout.write(log);
  if (code !== 0)
    throw new Error(`Edit benchmark failed (${code}); evidence: ${out}`);
}
