import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createExcelMcpServer, createWorkbookRoot } from "@sezzlee/excel-mcp";
import { z } from "zod";
import { prepareOutRoot } from "./run.ts";

const filename = "aggregate-2000000-cells.csv";
const fixtureBytes = 16_000_000;
const dataRows = 199_999;
const entry = fileURLToPath(import.meta.url);
const optionsSchema = z.object({
  out: z.string().min(1),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  runs: z.coerce.number().int().min(1).max(10).default(1),
  heapMiB: z.coerce.number().int().min(256).max(2048).default(512),
  legacyCoerceText: z.boolean().default(false),
  worker: z.boolean().default(false),
});
const answerSchema = z.object({
  rows: z.array(z.tuple([z.string(), z.string()]).rest(z.number())),
  matchedRows: z.number(),
  scannedRows: z.number(),
  groupCount: z.number(),
  truncated: z.boolean(),
  columns: z.array(
    z.object({
      role: z.string(),
      counted: z.number().optional(),
      skipped: z.number().optional(),
    }),
  ),
});
const reportSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  firstCallMs: z.number().positive(),
  cachedCallMs: z.number().positive(),
  maxRssKiB: z.number().positive(),
  responseDigests: z.array(z.string()).length(2),
});

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    revision: { type: "string" },
    runs: { type: "string" },
    "heap-mib": { type: "string" },
    "legacy-coerce-text": { type: "boolean" },
    worker: { type: "boolean" },
  },
  strict: true,
});
const options = optionsSchema.parse({
  out: values.out,
  revision: values.revision,
  runs: values.runs,
  heapMiB: values["heap-mib"],
  legacyCoerceText: values["legacy-coerce-text"],
  worker: values.worker,
});

function verify(text: string): void {
  const answer = answerSchema.parse(JSON.parse(text));
  const full = [
    30_862_500, 58_631_250, 86_418_750, 114_175_000, 141_962_500, 169_731_250,
    197_268_750, 222_525_000,
  ];
  const short = [
    30_861_265.5, 58_628_904.75, 86_415_293.25, 114_170_433, 141_956_821.5,
    169_724_460.75, 197_260_859.25, 222_516_099,
  ];
  assert.deepEqual(answer.rows, [
    ["REGION0", "CHAN000", ...full],
    ["REGION0", "CHAN001", ...full],
    ["REGION1", "CHAN000", ...full],
    ["REGION1", "CHAN001", ...full],
    ["REGION2", "CHAN000", ...full],
    ["REGION2", "CHAN001", ...full],
    ["REGION3", "CHAN000", ...full],
    ["REGION3", "CHAN001", ...short],
  ]);
  assert.equal(answer.matchedRows, dataRows);
  assert.equal(answer.scannedRows, dataRows);
  assert.equal(answer.groupCount, 8);
  assert.equal(answer.truncated, false);
  const metrics = answer.columns.filter((column) => column.role === "metric");
  assert.equal(metrics.length, 8);
  for (const metric of metrics) {
    assert.equal(metric.counted, dataRows);
    assert.equal(metric.skipped, 0);
  }
}

async function measure(): Promise<void> {
  assert.equal((await stat(join(options.out, filename))).size, fixtureBytes);
  const implementation = createHash("sha256");
  for (const name of [
    "aggregate.js",
    "column-reading.js",
    "number-text.js",
    "date-text.js",
    "predicate.js",
  ]) {
    const source = await readFile(
      new URL(`../../../servers/excel-mcp/dist/grid/${name}`, import.meta.url),
    ).catch(() => undefined);
    implementation.update(name).update(source ?? "absent");
  }
  const server = createExcelMcpServer(await createWorkbookRoot(options.out));
  const client = new Client({
    name: "excel-aggregate-bench",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const times: number[] = [];
  const peaks: number[] = [];
  const bytes: number[] = [];
  const digests: string[] = [];
  try {
    for (let call = 0; call < 2; call += 1) {
      const started = performance.now();
      const answer = await client.callTool({
        name: "aggregate_sheet",
        arguments: {
          filePath: filename,
          delimiter: "comma",
          headerRow: 1,
          groupBy: ["Region1", "Channel"],
          metrics: Array.from({ length: 8 }, (_, at) => ({
            fn: "sum",
            column: `Value0${at + 1}`,
          })),
          ...(options.legacyCoerceText ? { coerceText: true } : {}),
        },
      });
      times.push(performance.now() - started);
      peaks.push(process.resourceUsage().maxRSS);
      const text = answer.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      assert.notEqual(answer.isError, true, text);
      verify(text);
      bytes.push(Buffer.byteLength(text));
      digests.push(createHash("sha256").update(text).digest("hex"));
    }
  } finally {
    await client.close();
    await server.close();
  }
  assert.equal(digests[0], digests[1]);
  const record = {
    revision: options.revision,
    implementationSha256: implementation.digest("hex"),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    heapMiB: options.heapMiB,
    legacyCoerceText: options.legacyCoerceText,
    cells: 2_000_000,
    fixtureBytes,
    firstCallMs: times[0],
    cachedCallMs: times[1],
    firstCallMaxRssKiB: peaks[0],
    maxRssKiB: process.resourceUsage().maxRSS,
    responseBytes: bytes,
    responseDigests: digests,
  };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function generate(out: string): Promise<void> {
  const header = [
    "Region1",
    "Channel",
    "Value01",
    "Value02",
    "Value03",
    "Value04",
    "Value05",
    "Value06",
    "Value07",
    "Value08",
  ].join(",");
  const amounts =
    "1234.50,2345.25,3456.75,4567.00,5678.50,6789.25,7890.75,8901.00";
  const cycle = Array.from(
    { length: 8 },
    (_, at) => `REGION${at % 4},CHAN00${Math.floor(at / 4)},${amounts}\n`,
  );
  const text = `${header}\n${cycle.join("").repeat(24_999)}${cycle.slice(0, 7).join("")}`;
  assert.equal(Buffer.byteLength(text), fixtureBytes);
  await writeFile(join(out, filename), text);
  await writeFile(
    join(out, "aggregate-fixture.json"),
    `${JSON.stringify(
      {
        file: filename,
        sha256: createHash("sha256").update(text).digest("hex"),
        bytes: fixtureBytes,
        rows: 200_000,
        columns: 10,
        cells: 2_000_000,
        license: "MIT",
        expectedSource:
          "Hand-calculated sums of exact quarter-unit amounts in eight groups; seven groups have 25000 rows and the last has 24999.",
      },
      null,
      2,
    )}\n`,
  );
}

function trial(out: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${options.heapMiB}`,
        entry,
        "--worker",
        "--out",
        out,
        "--heap-mib",
        String(options.heapMiB),
        "--revision",
        options.revision,
        ...(options.legacyCoerceText ? ["--legacy-coerce-text"] : []),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error(`Benchmark failed (${code}, ${signal}): ${stderr}`));
      else resolve(stdout);
    });
  });
}

if (options.worker) {
  await measure();
} else {
  const out = await prepareOutRoot(options.out);
  const existing = await readFile(join(out, filename)).catch(() => undefined);
  if (existing === undefined) await generate(out);
  else assert.equal(existing.length, fixtureBytes);
  for (let run = 0; run < options.runs; run += 1) {
    const result = await trial(out);
    reportSchema.parse(JSON.parse(result));
    await appendFile(join(out, "aggregate-results.jsonl"), result);
    process.stdout.write(result);
  }
}
