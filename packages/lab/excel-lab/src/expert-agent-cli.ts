import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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
import { OllamaHost } from "./agent/ollama.ts";
import { toolSpecsOf } from "./agent/agent-run.ts";
import { assistantMessage, type ChatMessage } from "./agent/host.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    url: { type: "string" },
    model: { type: "string" },
    languages: { type: "string", default: "tr,en" },
    application: { type: "boolean", default: false },
  },
});
const options = z
  .object({
    out: z.string().min(1),
    url: z.url().optional(),
    model: z.string().optional(),
    languages: z.string(),
    application: z.boolean(),
  })
  .parse(values);
const directory = await prepareOutRoot(options.out);
const host =
  options.model === undefined
    ? undefined
    : new OllamaHost({
        baseUrl:
          options.url ??
          process.env.SEZZLEE_AGENT_LAB_OLLAMA_URL ??
          "http://127.0.0.1:11434",
        model: options.model,
        think: false,
      });
const versionSchema = z.object({
  version: z.object({ filePath: z.string(), versionId: z.string() }),
});
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const text = (value: string) => ({ kind: "text", value });
const number = (value: number) => ({ kind: "number", value });
const exec = promisify(execFile);
const python = "python3";
const oracle = fileURLToPath(
  new URL("../scripts/expert-oracle.py", import.meta.url),
);
const runtimeDirectory = dirname(
  fileURLToPath(import.meta.resolve("@sezzlee/excel-mcp")),
);
async function runtimeIdentity() {
  const hash = createHash("sha256");
  let modules = 0;
  async function walk(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".js")) {
        hash
          .update(relative(runtimeDirectory, file))
          .update("\0")
          .update(await readFile(file))
          .update("\0");
        modules++;
      }
    }
  }
  await walk(runtimeDirectory);
  return { modules, sha256: hash.digest("hex") };
}
const runtime = await runtimeIdentity();
await writeFile(
  join(directory, "manifest.json"),
  JSON.stringify(
    {
      runtime,
      host: (await host?.identity()) ?? null,
      endpoint: host?.endpoint ?? null,
      think: false,
      window: 65536,
      numPredict: 8192,
      callBudget: 16,
    },
    null,
    2,
  ),
);
function textOf(result: { content: readonly unknown[] }): string {
  return result.content
    .flatMap((item) =>
      item !== null &&
      typeof item === "object" &&
      "text" in item &&
      typeof item.text === "string"
        ? [item.text]
        : [],
    )
    .join("\n");
}
const results: {
  scenario: string;
  language: string;
  passed: boolean;
  output?: string;
  error?: string;
}[] = [];

for (const language of [
  "scripted",
  ...(host ? options.languages.split(",") : []),
]) {
  const workspace = join(directory, language);
  await mkdir(join(workspace, "out"), { recursive: true });
  const root = await createWorkbookRoot(workspace);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({ name: "expert-acceptance", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await writeFile(
      join(workspace, "catalog-sizes.json"),
      JSON.stringify(
        (await client.listTools()).tools.map((tool) => ({
          name: tool.name,
          bytes: Buffer.byteLength(JSON.stringify(tool)),
        })),
        null,
        2,
      ),
    );
    async function call(name: string, args: Record<string, unknown>) {
      const response = await client.callTool({ name, arguments: args });
      await appendFile(
        join(workspace, "trace.jsonl"),
        JSON.stringify({ tool: name, arguments: args, response }) + "\n",
      );
      assert(!response.isError, textOf(response));
      return JSON.parse(textOf(response));
    }
    const initial = versionSchema.parse(
      await call("create_workbook", {
        sheets: [
          {
            name: "Data",
            blocks: [
              {
                startCell: "A1",
                values: [
                  [text("Region"), text("Amount"), text("Status")],
                  [text("North"), number(10), text("Open")],
                  [text("South"), number(20), text("Closed")],
                  [text("North"), number(5), text("Open")],
                ],
              },
            ],
          },
          { name: "Report", blocks: [] },
        ],
        changes: [
          {
            kind: "set_columns",
            sheetName: "Data",
            first: 1,
            last: 3,
            width: 16,
          },
          {
            kind: "set_columns",
            sheetName: "Report",
            first: 1,
            last: 3,
            width: 20,
          },
          {
            kind: "set_columns",
            sheetName: "Report",
            first: 4,
            last: 4,
            width: 40,
          },
        ],
      }),
    ).version;
    const sourceHash = createHash("sha256")
      .update(await readFile(join(workspace, initial.filePath)))
      .digest("hex");
    let selected = initial;
    if (language === "scripted") {
      const changes = [
        {
          kind: "define_name",
          sheetName: "Report",
          name: "Period",
          range: "B1",
        },
        {
          kind: "write_named_range",
          sheetName: "Report",
          name: "Period",
          values: [[text("2026-10")]],
        },
        {
          kind: "write_formula",
          sheetName: "Report",
          cell: "B3",
          formula: "SUM(Data!B2:B4)",
        },
        {
          kind: "set_validation",
          sheetName: "Data",
          range: "C2:C4",
          rule: { type: "list", items: ["Open", "Closed"] },
        },
        {
          kind: "set_conditional_format",
          sheetName: "Data",
          range: "B2:B4",
          priority: 2,
          rule: { type: "cellIs", operator: "greaterThan", formulas: ["0"] },
          appearance: { fill: "00FF00" },
        },
        {
          kind: "set_conditional_format",
          sheetName: "Data",
          range: "B2:B4",
          priority: 1,
          rule: { type: "cellIs", operator: "greaterThan", formulas: ["15"] },
          appearance: { fill: "FF0000" },
          stopIfTrue: true,
        },
        {
          kind: "set_hyperlink",
          sheetName: "Report",
          cell: "D1",
          target: { kind: "external", url: "https://example.com/report" },
        },
        {
          kind: "set_note",
          sheetName: "Report",
          cell: "B1",
          text: "Reviewed",
          author: "Finance",
        },
        {
          kind: "set_image",
          sheetName: "Report",
          name: "Logo",
          cell: "E1",
          mime: "image/png",
          data: png,
          width: 48,
          height: 48,
        },
        {
          kind: "set_pivot",
          sheetName: "Report",
          name: "Regional",
          cell: "A5",
          sourceSheet: "Data",
          sourceRange: "A1:C4",
          rowColumn: "Region",
          measures: [
            { column: "Amount", function: "sum", name: "Total" },
            { column: "Amount", function: "count", name: "Entries" },
          ],
        },
        {
          kind: "set_chart",
          sheetName: "Report",
          name: "Sales",
          chartType: "column",
          cell: "E5",
          title: "Monthly sales",
          series: [
            {
              name: "Revenue",
              sheetName: "Data",
              categories: "A2:A4",
              values: "B2:B4",
            },
          ],
        },
        {
          kind: "format_cells",
          sheetName: "Report",
          range: "B1",
          style: { protection: { locked: false } },
        },
      ];
      for (const [index, chartType] of ["bar", "line", "pie"].entries())
        changes.push({
          kind: "set_chart",
          sheetName: "Report",
          name: `Sales_${chartType}`,
          chartType,
          cell: `E${25 + index * 20}`,
          title: `${chartType} sales`,
          series: [
            {
              name: "Revenue",
              sheetName: "Data",
              categories: "A2:A4",
              values: "B2:B4",
            },
          ],
        });
      selected = versionSchema.parse(
        await call("edit_workbook", { source: selected, changes }),
      ).version;
      selected = versionSchema.parse(
        await call("calculate_workbook", { source: selected }),
      ).version;
      selected = versionSchema.parse(
        await call("edit_workbook", {
          source: selected,
          changes: [
            { kind: "protect_sheet", sheetName: "Report" },
            { kind: "protect_workbook", sheetName: "Report" },
          ],
        }),
      ).version;
    } else {
      assert(host !== undefined);
      const allowed = new Set([
        "edit_workbook",
        "calculate_workbook",
        "prepare_edit",
      ]);
      const tools = (await toolSpecsOf(client)).filter((tool) =>
        allowed.has(tool.function.name),
      );
      const task =
        language === "tr"
          ? "Verilen Data sayfasındaki Region,Amount,Status sütunlarında North/10/Open, South/20/Closed, North/5/Open kayıtları var. Report sayfasında B1 hücresine metin türünde tam 2026-10 yaz ve bu hücre için kitap kapsamlı Period adlı alanı oluştur. B3 hücresine Data tutarlarını toplayan formülü yaz ve sunucuda hesapla. Data C2:C4 için Open/Closed açılır listesi, B2:B4 için 15'ten büyük değerlerde kırmızı dolgu kuralı ekle. Report D1'e https://example.com/report bağlantısı ve B1'e Finance yazarlı Reviewed notu ekle. Logo adlı PNG resmini E1'e 48x48 piksel koy. Report A5'ten başlayan Regional adlı gerçek pivot oluştur: Data A1:C4 kaynağı, Region satır grubu, Amount toplamı Total ve dolu kayıt sayısı Entries. E5'e Sales adlı sütun grafiği ekle: başlık Monthly sales, seri adı Revenue, kategoriler Data A2:A4 ve değerler Data B2:B4. B1'i kilitsiz yap. En son Report sayfasını ve kitap yapısını parolasız koru. Kaynak değişmesin; yeni son dosyanın filePath değerini içeren JSON ile bitir."
          : "Data has Region,Amount,Status headers and North/10/Open, South/20/Closed, North/5/Open rows. On Report write the literal text string 2026-10 to B1 and define the workbook-scoped name Period for B1. Write a formula in B3 summing the Data amounts and calculate it on the server. Add an Open/Closed dropdown to Data C2:C4 and red-fill conditional formatting for Data B2:B4 values greater than 15. Link Report D1 to https://example.com/report and add a note at B1 with the exact text Reviewed and author Finance. Place the PNG named Logo at E1, 48x48 pixels. Create a real Regional pivot at Report A5 from Data A1:C4, row group Region, Amount sum caption Total and nonblank count caption Entries. Add a column chart named Sales at E5, title Monthly sales, series Revenue, categories Data A2:A4 and values Data B2:B4. Unlock B1. Finally protect the Report sheet and workbook structure without a password. Preserve the source. Finish with JSON containing the final filePath.";
      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "Use the available Excel MCP tools to deliver the requested workbook. Read tool descriptions carefully. All operations use kind and typed cells. Keep track of each new exact source version. Calculation must occur after value/formula edits and before protection. Do not claim completion until all requested features exist in the last version.",
        },
        {
          role: "user",
          content: `${task}\nSource: ${JSON.stringify(initial)}\nPNG base64: ${png}`,
        },
      ];
      let final = "",
        calls = 0;
      for (let turn = 0; turn < 16; turn++) {
        const reply = await host.chat({
          messages,
          tools,
          window: 65536,
          temperature: 0,
          timeoutMs: 180000,
          numPredict: 8192,
        });
        assert(reply.kind === "reply", "Model preflight refused");
        await appendFile(
          join(workspace, "trace.jsonl"),
          JSON.stringify(reply) + "\n",
        );
        messages.push(assistantMessage({ ...reply, policy: "drop" }));
        if (!reply.toolCalls.length) {
          final = reply.content;
          break;
        }
        for (const tool of reply.toolCalls) {
          assert(
            allowed.has(tool.function.name) && calls++ < 16,
            "Tool budget/catalog exceeded",
          );
          const response = await client.callTool({
            name: tool.function.name,
            arguments: tool.function.arguments,
          });
          const content = textOf(response);
          await appendFile(
            join(workspace, "trace.jsonl"),
            JSON.stringify({
              tool: tool.function.name,
              arguments: tool.function.arguments,
              response,
            }) + "\n",
          );
          messages.push({
            role: "tool",
            tool_name: tool.function.name,
            content,
          });
          if (!response.isError && tool.function.name !== "prepare_edit")
            selected = versionSchema.parse(JSON.parse(content)).version;
        }
      }
      assert(
        final.includes(selected.filePath),
        "Model did not identify its final output",
      );
    }
    const path = join(workspace, selected.filePath);
    const checked = await exec(python, ["-I", oracle, path], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const result = z
      .object({
        sheets: z.record(
          z.string(),
          z.record(
            z.string(),
            z.object({ value: z.unknown(), formula: z.string().nullable() }),
          ),
        ),
        names: z.array(
          z.object({
            name: z.string(),
            ref: z.string(),
            localSheetId: z.string().optional(),
          }),
        ),
        pivots: z.array(
          z.object({ name: z.string(), result: z.array(z.array(z.unknown())) }),
        ),
        charts: z.array(
          z.object({
            name: z.string(),
            title: z.string(),
            chartType: z.string(),
            series: z.array(
              z.object({
                name: z.string(),
                categories: z.string(),
                values: z.string(),
                numericValues: z.array(z.unknown()),
              }),
            ),
          }),
        ),
        images: z.array(z.object({ name: z.string(), sha256: z.string() })),
        links: z.array(
          z.object({ sheet: z.string(), cell: z.string(), target: z.string() }),
        ),
        notes: z.array(
          z.object({
            sheet: z.string(),
            cell: z.string(),
            author: z.string(),
            text: z.string(),
          }),
        ),
        validations: z.array(
          z.object({
            sheet: z.string(),
            sqref: z.string(),
            type: z.string(),
            formula1: z.string(),
          }),
        ),
        conditions: z.array(
          z.object({
            sheet: z.string(),
            range: z.string(),
            type: z.string(),
            formulas: z.array(z.string()),
            fill: z.string().nullable(),
            operator: z.string().optional(),
          }),
        ),
        protectedSheets: z.array(z.string()),
        workbookProtected: z.boolean(),
        unlocked: z.array(z.object({ sheet: z.string(), cell: z.string() })),
      })
      .parse(JSON.parse(checked.stdout));
    assert.equal(result.sheets.Report?.["1,2"]?.value, "2026-10");
    assert.equal(result.sheets.Report?.["3,2"]?.value, 35);
    assert(result.sheets.Report?.["3,2"]?.formula);
    assert(
      result.names.some(
        (name) =>
          name.name === "Period" &&
          name.localSheetId === undefined &&
          /^'?Report'?!.?B.?1(?::.?B.?1)?$/.test(name.ref),
      ),
    );
    assert.deepEqual(
      result.pivots.find((pivot) => pivot.name === "Regional")?.result,
      [
        ["Region", "Total", "Entries"],
        ["North", 15, 2],
        ["South", 20, 1],
        ["Grand Total", 35, 3],
      ],
    );
    assert(
      result.charts.some(
        (chart) =>
          chart.name === "Sales" &&
          chart.title === "Monthly sales" &&
          chart.chartType === "column",
      ),
    );
    assert.deepEqual(
      result.charts.find((chart) => chart.name === "Sales")?.series,
      [
        {
          name: "Revenue",
          categories: "Data!A2:A4",
          values: "Data!B2:B4",
          numericValues: [10, 20, 5],
        },
      ],
    );
    assert(
      result.images.some(
        (image) =>
          image.name === "Logo" &&
          image.sha256 ===
            createHash("sha256")
              .update(Buffer.from(png, "base64"))
              .digest("hex"),
      ),
    );
    assert(
      result.links.some(
        (link) =>
          link.sheet === "Report" &&
          link.cell === "D1" &&
          link.target === "https://example.com/report",
      ),
    );
    assert(
      result.notes.some(
        (note) =>
          note.sheet === "Report" &&
          note.cell === "B1" &&
          note.author === "Finance" &&
          note.text === "Reviewed",
      ),
    );
    assert(
      result.validations.some(
        (rule) =>
          rule.sheet === "Data" &&
          rule.sqref === "C2:C4" &&
          rule.type === "list" &&
          rule.formula1 === '"Open,Closed"',
      ),
    );
    assert(
      result.conditions.some(
        (rule) =>
          rule.sheet === "Data" &&
          rule.range === "B2:B4" &&
          ((rule.type === "cellIs" &&
            rule.operator === "greaterThan" &&
            rule.formulas[0] === "15") ||
            (rule.type === "expression" &&
              ["B2>15", "(B2>15)"].includes(
                rule.formulas[0]?.replace(/[\s$]/g, "") ?? "",
              ))) &&
          rule.fill === "FFFF0000",
      ),
    );
    assert(
      result.protectedSheets.includes("Report") && result.workbookProtected,
    );
    assert(
      result.unlocked.some(
        (cell) => cell.sheet === "Report" && cell.cell === "B1",
      ),
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(workspace, initial.filePath)))
        .digest("hex"),
      sourceHash,
    );
    await writeFile(
      join(workspace, "oracle.json"),
      JSON.stringify(JSON.parse(checked.stdout), null, 2),
    );
    await writeFile(
      join(workspace, "final.json"),
      JSON.stringify(selected, null, 2),
    );
    if (options.application) {
      const application = await exec(
        python,
        [
          "-I",
          fileURLToPath(
            new URL("../scripts/expert-application-oracle.py", import.meta.url),
          ),
          path,
          "--out",
          join(workspace, "application"),
        ],
        { timeout: 180000, maxBuffer: 1024 * 1024 },
      );
      await writeFile(join(workspace, "application.json"), application.stdout);
      const visual = await exec(
        python,
        [
          "-I",
          fileURLToPath(
            new URL("../scripts/expert-visual-oracle.py", import.meta.url),
          ),
          path,
          "--out",
          join(workspace, "visual"),
          "--charts",
          String(result.charts.length),
        ],
        { timeout: 180000, maxBuffer: 1024 * 1024 },
      );
      await writeFile(join(workspace, "visual.json"), visual.stdout);
    }
    results.push({
      scenario: "expert_report",
      language,
      passed: true,
      output: path,
    });
  } catch (error) {
    results.push({
      scenario: "expert_report",
      language,
      passed: false,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  } finally {
    await client.close();
    await server.close();
  }
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify(results, null, 2),
  );
}
assert.deepEqual(
  await runtimeIdentity(),
  runtime,
  "Runtime changed during acceptance",
);
console.log(JSON.stringify(results));
if (results.some((result) => !result.passed)) process.exitCode = 1;
