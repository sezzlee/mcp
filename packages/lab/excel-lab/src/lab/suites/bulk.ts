import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bulkBatchReceiptSchema,
  bulkGroupReceiptSchema,
  bulkJobSchema,
} from "@sezzlee/excel-mcp";
import { z } from "zod";
import { assertAdditionClaims } from "../../agent/answer-claims.ts";
import { defineScenario, type LabScenario } from "../trial.ts";

type Kind =
  | "update"
  | "join"
  | "replace"
  | "retry"
  | "blocked"
  | "report"
  | "independent_report";

const oracle = fileURLToPath(
  new URL("../../../scripts/bulk-agent-oracle.py", import.meta.url),
);

const system =
  "Complete the requested spreadsheet task through real tools. Nested tool arguments are JSON objects, never JSON-encoded strings. Read-only preparation is not a completed output. Reuse exact supplied source versions. Do not recalculate formulas, invent success, alter originals or replace errors with a different task. If formulas were authored, report that the server did not calculate them and a spreadsheet application must recalculate. Never report a computed formula result, even as a prediction or a value calculated by you. In the final answer state the selected output path, each job's complete/refused status and whether recalculation is required. Report only facts from tool results. Report independent partial success explicitly. On a tool error correct the descriptor and retry within the call budget. Use the bulk job contracts for complete selections and explicit output modes.";

const prompts: Readonly<Record<Kind, { en: string; tr: string }>> = {
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

const reminder =
  "The requested task has no verified completed result yet. Use one available tool now to execute or inspect the actual result. Preparation and reasoning alone do not complete the task. Follow the supplied argument schema and exact source versions; do not repeat analysis or claim success without an output. If preservation is blocked, obtain and report the actual tool refusal.";

const recalculation =
  /not (?:re)?calculated|not calculate|requires? (?:re)?calculation|(?:re)?calculation (?:is )?required|(?:Excel|spreadsheet)[\s\S]*(?:calculat|evaluat)|(?:calculat|evaluat)[\s\S]*(?:Excel|spreadsheet)|hesaplanmad|yeniden hesap|henüz hesap|Excel[\s\S]*hesap|hesap[\s\S]*Excel/i;

interface Context {
  readonly hashes: Readonly<Record<string, string>>;
}

interface State {
  last: z.infer<typeof bulkGroupReceiptSchema> | undefined;
  blocked: boolean;
  runIds: string[];
  statusRead: boolean;
  partial: boolean;
  artifactComplete: boolean;
  reminders: number;
}

function verifyOutput(directory: string, kind: Kind, outputPath?: string) {
  return spawnSync(
    "python3",
    [
      "-I",
      oracle,
      "verify",
      directory,
      kind,
      ...(outputPath === undefined ? [] : [outputPath]),
    ],
    { encoding: "utf8", timeout: 30000 },
  );
}

function job(kind: Kind, hashes: Readonly<Record<string, string>>) {
  const source = { filePath: "source.xlsx", versionId: hashes["source.xlsx"] };
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
  const group =
    kind === "join"
      ? {
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
                  columns: [{ column: "Price", type: "number", decimal: "." }],
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
        }
      : kind === "replace"
        ? {
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
          }
        : {
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
  const parsed = bulkJobSchema.parse(group);
  if (kind !== "report" && kind !== "independent_report") return parsed;
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
  return bulkJobSchema.parse(
    kind === "report"
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

function scenario(kind: Kind): LabScenario {
  const needsFinishedAnswer =
    kind === "report" || kind === "independent_report";
  return defineScenario<Context, State>({
    id: `bulk/${kind}`,
    scriptedLanguages: ["en"],
    policy: {
      catalog: [
        "prepare_bulk_job",
        "run_bulk_job",
        "get_bulk_job",
        "read_sheet",
        "describe_workbook",
      ],
      requests: 16,
      calls: 16,
      window: 65536,
      numPredict: 12288,
      timeoutMs: 360000,
      thinking: "product",
    },
    async setup(session) {
      const fixture = spawnSync(
        "python3",
        [
          "-I",
          oracle,
          "prepare",
          session.directory,
          ...(kind === "blocked" ? ["blocked"] : []),
        ],
        { encoding: "utf8", timeout: 15000 },
      );
      assert.equal(fixture.status, 0, fixture.stderr);
      return {
        hashes: z
          .record(z.string(), z.string())
          .parse(JSON.parse(fixture.stdout)),
      };
    },
    brief({ hashes }, language) {
      return {
        system,
        user:
          prompts[kind][language] +
          "\nExact input versions: " +
          JSON.stringify(hashes) +
          "\nsource.xlsx headers: Id, Status, Amount; right.csv: Id, Price; replacement.csv: Id, Status, Amount. First row is the header.",
      };
    },
    start: () => ({
      last: undefined,
      blocked: false,
      runIds: [],
      statusRead: false,
      partial: false,
      artifactComplete: false,
      reminders: 0,
    }),
    observe(state, outcome) {
      const receipt = bulkGroupReceiptSchema.safeParse(outcome.body);
      if (receipt.success) {
        state.last = receipt.data;
        if (outcome.name === "run_bulk_job")
          state.runIds.push(receipt.data.jobId);
        if (outcome.name === "get_bulk_job") state.statusRead = true;
      }
      const batch = bulkBatchReceiptSchema.safeParse(outcome.body);
      if (batch.success) {
        state.partial =
          batch.data.kind === "partial" &&
          batch.data.jobs.filter((entry) => entry.kind === "complete")
            .length === 1 &&
          /dynamic|array|spilling|Phase 5/i.test(
            JSON.stringify(
              batch.data.jobs.filter((entry) => entry.kind === "failed"),
            ),
          );
        for (const child of batch.data.jobs)
          if (child.kind === "complete" && child.details === "full") {
            state.last = child.result;
            if (outcome.name === "run_bulk_job")
              state.runIds.push(child.result.jobId);
          }
      }
      if (/protected_sheet|protected_workbook/.test(outcome.text))
        state.blocked = true;
    },
    async scripted(call, { hashes }, state) {
      const parsed = job(kind, hashes);
      await call("prepare_bulk_job", { job: parsed });
      if (kind !== "blocked") {
        await call("run_bulk_job", { job: parsed });
        if (kind === "retry") {
          await call("run_bulk_job", { job: parsed });
          if (state.last !== undefined)
            await call("get_bulk_job", { jobId: state.last.jobId });
        }
      }
      return "";
    },
    async afterTurn(state, _context, session) {
      if (needsFinishedAnswer && state.last !== undefined) {
        const output = state.last.outputs[0];
        if (output !== undefined)
          state.artifactComplete =
            verifyOutput(session.directory, kind, output.version.filePath)
              .status === 0 &&
            (kind !== "independent_report" || state.partial);
        return "continue";
      }
      return (
        kind === "blocked"
          ? state.blocked
          : kind === "retry"
            ? state.runIds.length >= 2 && state.statusRead
            : kind === "independent_report"
              ? state.partial
              : state.last !== undefined
      )
        ? "stop"
        : "continue";
    },
    remind(state) {
      if (needsFinishedAnswer && state.artifactComplete) return undefined;
      if (state.reminders++ >= 2) return undefined;
      return reminder;
    },
    async grade({ session, state, mode, final }) {
      if (kind === "blocked")
        assert.ok(state.blocked, "No real policy refusal was encountered.");
      else
        assert.ok(
          state.last !== undefined,
          "No completed bulk output was produced.",
        );
      if (kind === "retry") {
        assert.ok(
          state.runIds.length >= 2 && state.statusRead,
          "Retry and durable status were not exercised.",
        );
        assert.equal(
          new Set(state.runIds).size,
          1,
          "Retry changed the request identity.",
        );
      }
      if (kind === "independent_report")
        assert(
          state.partial,
          "Expected exactly one finished group and a genuine dynamic-array failure",
        );
      if (needsFinishedAnswer)
        assert.equal(
          new Set(state.runIds).size,
          1,
          "An atomic report must not publish a preliminary data-only group",
        );
      const output = state.last?.outputs[0];
      const verified = verifyOutput(
        session.directory,
        kind,
        output?.version.filePath,
      );
      await writeFile(
        join(session.directory, "oracle.log"),
        verified.stdout + verified.stderr,
      );
      assert.equal(verified.status, 0, verified.stdout + verified.stderr);
      if (mode === "model" && needsFinishedAnswer) {
        assertAdditionClaims(final);
        assert.match(
          final,
          recalculation,
          "Final answer must disclose pending formula calculation.",
        );
        if (kind === "independent_report")
          assert.match(
            final,
            /partial|k[ıiİ]sm/iu,
            "Final answer must disclose independent partial success.",
          );
      }
      return output === undefined ? {} : { output: output.version };
    },
  });
}

export const bulkScenarios: readonly LabScenario[] = [
  scenario("update"),
  scenario("join"),
  scenario("replace"),
  scenario("retry"),
  scenario("blocked"),
  scenario("report"),
  scenario("independent_report"),
];
