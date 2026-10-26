import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createExcelMcpServer,
  createWorkbookRoot,
  createWorkbookOutput,
  bulkJobSchema,
  bulkGroupReceiptSchema,
  bulkBatchReceiptSchema,
} from "@sezzlee/excel-mcp";
import { z } from "zod";
import { prepareOutRoot } from "./run.ts";
import { OllamaHost } from "./agent/ollama.ts";
import { assistantMessage, type ChatMessage } from "./agent/host.ts";
import { toolSpecsOf } from "./agent/agent-run.ts";
import { assertAdditionClaims } from "./agent/answer-claims.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    languages: { type: "string" },
    only: { type: "string" },
    think: { type: "string" },
  },
});
const options = z
  .object({
    out: z.string().min(1),
    model: z.string().optional(),
    languages: z.string().default("tr,en"),
    only: z.string().optional(),
    think: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .transform((value) =>
        value === "true" ? true : value === "false" ? false : value,
      ),
    baseUrl: z.url().optional(),
  })
  .parse({ ...values, baseUrl: process.env["SEZZLEE_AGENT_LAB_OLLAMA_URL"] });
const scenarioSchema = z.enum([
  "update",
  "join",
  "replace",
  "retry",
  "blocked",
  "report",
  "independent_report",
]);
const scenarios =
  options.only === undefined
    ? scenarioSchema.options
    : options.only.split(",").map((value) => scenarioSchema.parse(value));
const root = await prepareOutRoot(options.out),
  oracle = fileURLToPath(
    new URL("../scripts/bulk-agent-oracle.py", import.meta.url),
  );
const catalog = [
  "prepare_bulk_job",
  "run_bulk_job",
  "get_bulk_job",
  "read_sheet",
  "describe_workbook",
];
const system =
  "Complete the requested spreadsheet task through real tools. Nested tool arguments are JSON objects, never JSON-encoded strings. Read-only preparation is not a completed output. Reuse exact supplied source versions. Do not recalculate formulas, invent success, alter originals or replace errors with a different task. If formulas were authored, report that the server did not calculate them and a spreadsheet application must recalculate. Never report a computed formula result, even as a prediction or a value calculated by you. In the final answer state the selected output path, each job's complete/refused status and whether recalculation is required. Report only facts from tool results. Report independent partial success explicitly. On a tool error correct the descriptor and retry within the call budget. Use the bulk job contracts for complete selections and explicit output modes.";
const prompts = {
  report: {
    en: "In source.xlsx S!A1:C4 update numeric Amount to 99 only where Status is pending. In the SAME atomic bulk job finish the edited report with bold white headers on dark blue, Amount C2:C4 formatted 0.00 and E1 containing real formula SUM(C2:C4). Publish only the finished report, never an intermediate data-only version. Preserve originals and unrelated package content. Do not invent formula results.",
    tr: "source.xlsx S!A1:C4 içinde yalnız Status pending olan Amount sayılarını 99 yap. AYNI atomik bulk işinde son işlemlerle başlıkları koyu mavi üzerine beyaz kalın yap, C2:C4 tutarlarını 0.00 biçimlendir ve E1'e gerçek SUM(C2:C4) formülü yaz. Yalnız tamamlanmış raporu yayınla; ara veri sürümü üretme. Kaynakları ve ilgisiz paket içeriğini koru. Formül sonucu uydurma.",
  },
  independent_report: {
    en: "Run two INDEPENDENT bulk reports from source.xlsx S!A1:C4. Each report must edit a preserved copy of the source workbook, retaining unrelated package content. Both update Amount to 99 only where Status is pending. Finish good with bold white headers on dark blue, C2:C4 number format 0.00 and E1 real formula SUM(C2:C4). Finish bad with E1 dynamic spilling formula FILTER(C2:C4,C2:C4>0), deliberately unsupported. Expect partial batch success: retain good fully finished, refuse bad without publishing it. Do not replace the bad formula or silently turn this into overall success. Preserve originals; no fabricated formula results.",
    tr: "source.xlsx S!A1:C4 kaynağından iki BAĞIMSIZ bulk raporu çalıştır. Her rapor, kaynak çalışma kitabının ilgisiz paket içeriğini de koruyan bir kopyasını düzenlesin. İkisi de yalnız Status pending olan Amount sayılarını 99 yapsın. good raporunu koyu mavi üzerine beyaz kalın başlık, C2:C4 için 0.00 biçimi ve E1'de gerçek SUM(C2:C4) formülüyle tamamla. bad raporunun son işleminde E1'e bilerek desteklenmeyen dinamik taşan FILTER(C2:C4,C2:C4>0) formülü iste. Beklenen kısmi başarı: good tamamlanmış kalsın, bad yayınlanmadan reddedilsin. Hatalı formülü değiştirme veya tüm işlem başarılı deme. Kaynaklar korunsun; hesap sonucu uydurma.",
  },
  update: {
    en: "In source.xlsx S!A1:C4, change numeric Amount to 99 only where Status is exactly pending. Preserve every other value and unrelated package content. Produce a new immutable edited workbook.",
    tr: "source.xlsx S!A1:C4 içinde yalnız Status değeri tam olarak pending olan kayıtların sayısal Amount değerini 99 yap. Diğer değerleri ve dosyanın ilgisiz içeriğini koru. Yeni ve değişmez bir düzenlenmiş dosya üret.",
  },
  join: {
    en: "Left join source.xlsx S!A1:C4 with right.csv A1:B4 using the exact Id key. Produce a new workbook sheet S with columns Id, Status, Price in that order. Price must be numeric; unmatched left prices are blank. Preserve all three left records and all source files.",
    tr: "source.xlsx S!A1:C4 ile right.csv A1:B4 verilerini tam Id anahtarıyla sol birleştir. Yeni çalışma kitabında S sayfasının kolonları sırasıyla Id, Status, Price olsun. Price sayısal olsun; eşleşmeyen sol kaydın fiyatı boş kalsın. Üç sol kaydı ve tüm kaynak dosyaları koru.",
  },
  replace: {
    en: "Replace the entire source.xlsx S!A1:C4 list with replacement.csv A1:C3. Preserve headers Id, Status, Amount, keep Amount numeric, clear the old extra third record and retain formatting and unrelated package parts. Produce a new immutable workbook.",
    tr: "source.xlsx S!A1:C4 listesinin tamamını replacement.csv A1:C3 ile yenile. Id, Status, Amount başlıklarını koru, Amount sayısal kalsın, artan eski üçüncü kaydı temizle; biçimi ve ilgisiz paket içeriğini koru. Yeni ve değişmez dosya üret.",
  },
  retry: {
    en: "Apply the pending-order Amount=99 update in source.xlsx S!A1:C4 as a preserved workbook edit, retaining all unrelated package content. Then retry exactly the same run_bulk_job request and read get_bulk_job status. Reuse the same completed output, without a duplicate application or changing the source.",
    tr: "source.xlsx S!A1:C4 dosyasında pending siparişlerin Amount değerini 99 yap; dosyayı düzenlerken ilgisiz paket içeriğinin tamamını koru. Ardından aynı run_bulk_job isteğini aynen yeniden dene ve get_bulk_job durumunu oku. Aynı tamamlanmış çıktıyı kullan; işlemi mükerrer uygulama ve kaynağı değiştirme.",
  },
  blocked: {
    en: "Try the pending-order Amount=99 edit in source.xlsx S!A1:C4. If workbook policy prevents preservation, stop and explicitly report the blocked job. Do not remove protection or publish a completed report.",
    tr: "source.xlsx S!A1:C4 içindeki pending siparişlerin Amount değerini 99 yapmayı dene. Dosya politikası korumayı engelliyorsa dur ve işin engellendiğini açıkça bildir. Korumayı kaldırma ve tamamlanmış rapor yayımlama.",
  },
};
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
let host: OllamaHost | undefined;
if (options.model !== undefined) {
  if (options.baseUrl === undefined)
    throw new Error("SEZZLEE_AGENT_LAB_OLLAMA_URL is required.");
  host = new OllamaHost({
    baseUrl: options.baseUrl,
    model: options.model,
    keepAlive: "10m",
    think: options.think,
    apiKey: process.env["SEZZLEE_AGENT_LAB_OLLAMA_KEY"],
  });
}
const implementation = createHash("sha256");
for (const name of [
  "bulk-dataset",
  "bulk-jobs",
  "bulk-output",
  "bulk-job-schemas",
  "writing",
  "transfer",
])
  implementation.update(
    await readFile(
      new URL(
        `../../../servers/excel-mcp/dist/tools/${name}.js`,
        import.meta.url,
      ),
    ),
  );
for (const path of [
  "servers/excel-mcp/dist/authoring/bulk-key.js",
  "servers/excel-mcp/dist/platform/versions.js",
  "servers/excel-mcp/dist/format/bulk-table.js",
  "servers/excel-mcp/dist/authoring/presentation.js",
  "servers/excel-mcp/dist/format/presentation-workbook.js",
  "servers/excel-mcp/dist/format/presentation-xml.js",
  "servers/excel-mcp/dist/format/style-authoring.js",
  "servers/excel-mcp/dist/format/layout-authoring.js",
  "servers/excel-mcp/dist/format/formula-authoring.js",
  "servers/excel-mcp/dist/format/structured-reference.js",
  "servers/excel-mcp/dist/format/table-authoring.js",
  "servers/excel-mcp/dist/format/table-model.js",
  "servers/excel-mcp/dist/format/iso-write.js",
  "servers/excel-mcp/dist/format/preserved-workbook.js",
  "cores/file-core-native/index.js",
  "cores/file-core-native/src/secure.cc",
  "cores/file-core-native/build.mjs",
])
  implementation.update(
    await readFile(new URL(`../../../${path}`, import.meta.url)),
  );
await writeFile(
  join(root, "manifest.json"),
  JSON.stringify(
    {
      fixture: "public deterministic synthetic data only",
      catalog,
      system,
      host: host === undefined ? null : await host.identity(),
      endpoint: options.baseUrl ?? null,
      implementationSha256: implementation.digest("hex"),
      scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))),
      hostClientSha256: digest(
        await readFile(new URL("./agent/ollama.ts", import.meta.url)),
      ),
      answerClaimsSha256: digest(
        await readFile(new URL("./agent/answer-claims.ts", import.meta.url)),
      ),
      oracleSha256: digest(await readFile(oracle)),
      scenarios,
      generation: {
        requestedThink: options.think ?? "model-default",
        window: 65536,
        temperature: 0,
        numPredict: 12288,
        timeoutMs: 360000,
        callBudget: 16,
        incompleteReplyReminders: 2,
      },
    },
    null,
    2,
  ) + "\n",
);
const records: {
  mode: string;
  scenario: string;
  language: string;
  directory: string;
  passed: boolean;
  failure: string | null;
  calls: number;
}[] = [];
for (const mode of host === undefined ? ["scripted"] : ["scripted", "model"])
  for (const scenario of scenarios)
    for (const language of mode === "scripted"
      ? ["en"]
      : options.languages
          .split(",")
          .map((value) => z.enum(["tr", "en"]).parse(value))) {
      const directory = await mkdtemp(
        join(root, `${mode}-${scenario}-${language}-`),
      );
      const fixture = spawnSync(
        "python3",
        [
          "-I",
          oracle,
          "prepare",
          directory,
          ...(scenario === "blocked" ? ["blocked"] : []),
        ],
        { encoding: "utf8", timeout: 15000 },
      );
      assert.equal(fixture.status, 0, fixture.stderr);
      const hashes = z
        .record(z.string(), z.string())
        .parse(JSON.parse(fixture.stdout));
      await mkdir(join(directory, "out"));
      const sandbox = await createWorkbookRoot(directory),
        server = createExcelMcpServer(sandbox, {
          mode: "write",
          output: await createWorkbookOutput(sandbox, "out"),
        });
      const client = new Client({
          name: "bulk-agent-acceptance",
          version: "1",
        }),
        [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), server.connect(b)]);
      const trace: unknown[] = [];
      async function traceEvent(event: unknown) {
        trace.push(event);
        await appendFile(
          join(directory, "trace.jsonl"),
          JSON.stringify(event) + "\n",
        );
      }
      let calls = 0,
        blocked = false,
        last: ReturnType<typeof bulkGroupReceiptSchema.parse> | undefined;
      const runIds: string[] = [];
      let statusRead = false,
        failure: string | null = null;
      let partial = false;
      const needsFinishedAnswer =
        scenario === "report" || scenario === "independent_report";
      let artifactComplete = false,
        finalAnswer = "";
      function verifyOutput(outputPath?: string) {
        return spawnSync(
          "python3",
          [
            "-I",
            oracle,
            "verify",
            directory,
            scenario,
            ...(outputPath === undefined ? [] : [outputPath]),
          ],
          { encoding: "utf8", timeout: 30000 },
        );
      }
      async function call(
        name: string,
        args: Record<string, unknown>,
      ): Promise<string> {
        if (!catalog.includes(name))
          throw new Error("Model requested a tool outside its catalog.");
        if (++calls > 16) throw new Error("Model tool budget exhausted.");
        const response = await client.callTool({ name, arguments: args });
        const text = response.content
          .flatMap((item) => (item.type === "text" ? [item.text] : []))
          .join("\n");
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        const receipt = bulkGroupReceiptSchema.safeParse(body);
        if (receipt.success) {
          last = receipt.data;
          if (name === "run_bulk_job") runIds.push(last.jobId);
          if (name === "get_bulk_job") statusRead = true;
        }
        const batch = bulkBatchReceiptSchema.safeParse(body);
        if (batch.success) {
          partial =
            batch.data.kind === "partial" &&
            batch.data.jobs.filter((job) => job.kind === "complete").length ===
              1 &&
            /dynamic|array|spilling|Phase 5/i.test(
              JSON.stringify(
                batch.data.jobs.filter((job) => job.kind === "failed"),
              ),
            );
          for (const child of batch.data.jobs)
            if (child.kind === "complete" && child.details === "full") {
              last = child.result;
              if (name === "run_bulk_job") runIds.push(last.jobId);
            }
        }
        if (/protected_sheet|protected_workbook/.test(text)) blocked = true;
        await traceEvent({
          tool: name,
          args,
          result: body,
          isError: response.isError === true,
        });
        return text;
      }
      try {
        const source = {
          filePath: "source.xlsx",
          versionId: hashes["source.xlsx"],
        };
        if (mode === "scripted") {
          const read = {
            kind: "read",
            id: "orders",
            source,
            selection: {
              kind: "records",
              sheetName: "S",
              range: "A1:C4",
              headerRow: 1,
            },
          };
          let job: unknown;
          if (scenario === "join")
            job = {
              kind: "dependent",
              group: {
                steps: [
                  read,
                  {
                    kind: "read",
                    id: "prices",
                    source: {
                      filePath: "right.csv",
                      versionId: hashes["right.csv"],
                    },
                    selection: {
                      kind: "records",
                      range: "A1:B4",
                      headerRow: 1,
                      columns: [
                        { column: "Price", type: "number", decimal: "." },
                      ],
                    },
                  },
                  {
                    kind: "join",
                    id: "joined",
                    left: "orders",
                    right: "prices",
                    join: "left",
                    keys: [{ sourceColumn: "Id", targetColumn: "Id" }],
                    columns: [
                      { side: "left", column: "Id", as: "Id" },
                      { side: "left", column: "Status", as: "Status" },
                      { side: "right", column: "Price", as: "Price" },
                    ],
                  },
                ],
                outputs: [
                  {
                    kind: "new",
                    id: "report",
                    sheets: [{ name: "S", input: "joined" }],
                  },
                ],
              },
            };
          else if (scenario === "replace")
            job = {
              kind: "dependent",
              group: {
                steps: [
                  read,
                  {
                    kind: "read",
                    id: "replacement",
                    source: {
                      filePath: "replacement.csv",
                      versionId: hashes["replacement.csv"],
                    },
                    selection: {
                      kind: "records",
                      range: "A1:C3",
                      headerRow: 1,
                      columns: [
                        { column: "Amount", type: "number", decimal: "." },
                      ],
                    },
                  },
                  {
                    kind: "replace",
                    id: "replaced",
                    target: "orders",
                    source: "replacement",
                  },
                ],
                outputs: [
                  {
                    kind: "edit",
                    id: "report",
                    target: "orders",
                    input: "replaced",
                    mode: "replace_values",
                    overwrite: true,
                  },
                ],
              },
            };
          else
            job = {
              kind: "dependent",
              group: {
                steps: [
                  read,
                  {
                    kind: "update",
                    id: "updated",
                    input: "orders",
                    where: [{ column: "Status", op: "eq", value: "pending" }],
                    set: [
                      {
                        column: "Amount",
                        value: { kind: "number", value: 99 },
                      },
                    ],
                  },
                ],
                outputs: [
                  {
                    kind: "edit",
                    id: "report",
                    target: "orders",
                    input: "updated",
                    mode: "changed_values",
                    overwrite: true,
                  },
                ],
              },
            };
          let parsed = bulkJobSchema.parse(job);
          if (scenario === "report" || scenario === "independent_report") {
            assert(parsed.kind === "dependent");
            const finish = [
              {
                kind: "format_cells",
                sheetName: "S",
                range: "A1:C1",
                style: {
                  font: { bold: true, color: "FFFFFF" },
                  fill: "1F4E78",
                },
              },
              {
                kind: "format_cells",
                sheetName: "S",
                range: "C2:C4",
                style: { numberFormat: "0.00" },
              },
              {
                kind: "write_formula",
                sheetName: "S",
                cell: "E1",
                formula: "SUM(C2:C4)",
              },
            ];
            parsed = bulkJobSchema.parse(
              scenario === "report"
                ? { ...parsed, finish: [{ output: "report", changes: finish }] }
                : {
                    kind: "independent",
                    jobs: [
                      { id: "good", group: parsed.group },
                      { id: "bad", group: parsed.group },
                    ],
                    finish: [
                      { job: "good", output: "report", changes: finish },
                      {
                        job: "bad",
                        output: "report",
                        changes: [
                          {
                            kind: "write_formula",
                            sheetName: "S",
                            cell: "E1",
                            formula: "FILTER(C2:C4,C2:C4>0)",
                          },
                        ],
                      },
                    ],
                  },
            );
          }
          await call("prepare_bulk_job", { job: parsed });
          if (scenario !== "blocked") {
            await call("run_bulk_job", { job: parsed });
            if (scenario === "retry") {
              await call("run_bulk_job", { job: parsed });
              if (last !== undefined)
                await call("get_bulk_job", { jobId: last.jobId });
            }
          }
        } else {
          if (host === undefined) throw new Error("Missing model host.");
          const tools = (await toolSpecsOf(client)).filter((tool) =>
            catalog.includes(tool.function.name),
          );
          await writeFile(
            join(directory, "tools.json"),
            JSON.stringify(tools, null, 2) + "\n",
          );
          const messages: ChatMessage[] = [
            { role: "system", content: system },
            {
              role: "user",
              content:
                prompts[scenario][z.enum(["tr", "en"]).parse(language)] +
                "\nExact input versions: " +
                JSON.stringify(hashes) +
                "\nsource.xlsx headers: Id, Status, Amount; right.csv: Id, Price; replacement.csv: Id, Status, Amount. First row is the header.",
            },
          ];
          let reminders = 0;
          for (let turn = 0; turn < 16; turn++) {
            const reply = await host.chat({
              messages,
              tools,
              window: 65536,
              temperature: 0,
              timeoutMs: 360000,
              numPredict: 12288,
            });
            await traceEvent({ turn, reply });
            if (reply.kind !== "reply")
              throw new Error("Model preflight refused.");
            messages.push(
              assistantMessage({
                content: reply.content,
                thinking: reply.thinking,
                toolCalls: reply.toolCalls,
                policy: "product",
              }),
            );
            if (!reply.toolCalls?.length) {
              finalAnswer = reply.content ?? "";
              if (needsFinishedAnswer && artifactComplete) break;
              if (reminders++ >= 2) break;
              messages.push({
                role: "user",
                content:
                  "The requested task has no verified completed result yet. Use one available tool now to execute or inspect the actual result. Preparation and reasoning alone do not complete the task. Follow the supplied argument schema and exact source versions; do not repeat analysis or claim success without an output. If preservation is blocked, obtain and report the actual tool refusal.",
              });
              continue;
            }
            for (const tool of reply.toolCalls)
              messages.push({
                role: "tool",
                tool_name: tool.function.name,
                content: await call(
                  tool.function.name,
                  tool.function.arguments,
                ),
              });
            if (needsFinishedAnswer && last !== undefined) {
              const output = last.outputs[0];
              if (output !== undefined)
                artifactComplete =
                  verifyOutput(output.version.filePath).status === 0 &&
                  (scenario !== "independent_report" || partial);
              continue;
            }
            if (
              scenario === "blocked"
                ? blocked
                : scenario === "retry"
                  ? runIds.length >= 2 && statusRead
                  : scenario === "independent_report"
                    ? partial
                    : last !== undefined
            )
              break;
          }
        }
        if (scenario === "blocked")
          assert.ok(blocked, "No real policy refusal was encountered.");
        else
          assert.ok(
            last !== undefined,
            "No completed bulk output was produced.",
          );
        if (scenario === "retry") {
          assert.ok(
            runIds.length >= 2 && statusRead,
            "Retry and durable status were not exercised.",
          );
          assert.equal(
            new Set(runIds).size,
            1,
            "Retry changed the request identity.",
          );
        }
        if (scenario === "independent_report")
          assert(
            partial,
            "Expected exactly one finished group and a genuine dynamic-array failure",
          );
        if (scenario === "report" || scenario === "independent_report")
          assert.equal(
            new Set(runIds).size,
            1,
            "An atomic report must not publish a preliminary data-only group",
          );
        const output = last?.outputs[0];
        const verified = verifyOutput(output?.version.filePath);
        await writeFile(
          join(directory, "oracle.log"),
          verified.stdout + verified.stderr,
        );
        assert.equal(verified.status, 0, verified.stdout + verified.stderr);
        if (mode === "model" && needsFinishedAnswer) {
          assertAdditionClaims(finalAnswer);
          assert.match(
            finalAnswer,
            /not (?:re)?calculated|not calculate|requires? (?:re)?calculation|(?:re)?calculation (?:is )?required|(?:Excel|spreadsheet)[\s\S]*(?:calculat|evaluat)|(?:calculat|evaluat)[\s\S]*(?:Excel|spreadsheet)|hesaplanmad|yeniden hesap|henüz hesap|Excel[\s\S]*hesap|hesap[\s\S]*Excel/i,
            "Final answer must disclose pending formula calculation.",
          );
          if (scenario === "independent_report")
            assert.match(
              finalAnswer,
              /partial|k[ıiİ]sm/iu,
              "Final answer must disclose independent partial success.",
            );
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        await client.close();
        await server.close();
      }
      await writeFile(
        join(directory, "trace.json"),
        JSON.stringify(trace, null, 2) + "\n",
      );
      const result = {
        mode,
        scenario,
        language,
        directory,
        passed: failure === null,
        failure,
        calls,
        selectedVersion: last?.outputs[0]?.version,
        finalAnswer: mode === "model" ? finalAnswer : undefined,
      };
      records.push(result);
      await appendFile(
        join(root, "results.jsonl"),
        JSON.stringify(result) + "\n",
      );
      process.stdout.write(JSON.stringify(result) + "\n");
    }
await writeFile(
  join(root, "summary.json"),
  JSON.stringify(
    {
      records,
      passed: records.filter((item) => item.passed).length,
      total: records.length,
    },
    null,
    2,
  ) + "\n",
);
if (records.some((item) => !item.passed)) process.exitCode = 1;
