import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { defineScenario, type LabScenario } from "../trial.ts";

const versionSchema = z.object({
  version: z.object({ filePath: z.string(), versionId: z.string() }),
});
type Version = z.infer<typeof versionSchema>["version"];

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const text = (value: string) => ({ kind: "text", value });
const number = (value: number) => ({ kind: "number", value });
const exec = promisify(execFile);
const oracle = fileURLToPath(
  new URL("../../../scripts/expert-oracle.py", import.meta.url),
);

const system =
  "Use the available Excel MCP tools to deliver the requested workbook. Read tool descriptions carefully. All operations use kind and typed cells. Keep track of each new exact source version. Calculation must occur after value/formula edits and before protection. Do not claim completion until all requested features exist in the last version.";
const tasks = {
  tr: "Verilen Data sayfasındaki Region,Amount,Status sütunlarında North/10/Open, South/20/Closed, North/5/Open kayıtları var. Report sayfasında B1 hücresine metin türünde tam 2026-10 yaz ve bu hücre için kitap kapsamlı Period adlı alanı oluştur. B3 hücresine Data tutarlarını toplayan formülü yaz ve sunucuda hesapla. Data C2:C4 için Open/Closed açılır listesi, B2:B4 için 15'ten büyük değerlerde kırmızı dolgu kuralı ekle. Report D1'e https://example.com/report bağlantısı ve B1'e Finance yazarlı Reviewed notu ekle. Logo adlı PNG resmini E1'e 48x48 piksel koy. Report A5'ten başlayan Regional adlı gerçek pivot oluştur: Data A1:C4 kaynağı, Region satır grubu, Amount toplamı Total ve dolu kayıt sayısı Entries. E5'e Sales adlı sütun grafiği ekle: başlık Monthly sales, seri adı Revenue, kategoriler Data A2:A4 ve değerler Data B2:B4. B1'i kilitsiz yap. En son Report sayfasını ve kitap yapısını parolasız koru. Kaynak değişmesin; yeni son dosyanın filePath değerini içeren JSON ile bitir.",
  en: "Data has Region,Amount,Status headers and North/10/Open, South/20/Closed, North/5/Open rows. On Report write the literal text string 2026-10 to B1 and define the workbook-scoped name Period for B1. Write a formula in B3 summing the Data amounts and calculate it on the server. Add an Open/Closed dropdown to Data C2:C4 and red-fill conditional formatting for Data B2:B4 values greater than 15. Link Report D1 to https://example.com/report and add a note at B1 with the exact text Reviewed and author Finance. Place the PNG named Logo at E1, 48x48 pixels. Create a real Regional pivot at Report A5 from Data A1:C4, row group Region, Amount sum caption Total and nonblank count caption Entries. Add a column chart named Sales at E5, title Monthly sales, series Revenue, categories Data A2:A4 and values Data B2:B4. Unlock B1. Finally protect the Report sheet and workbook structure without a password. Preserve the source. Finish with JSON containing the final filePath.",
} as const;

const oracleSchema = z.object({
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
});

interface Context {
  readonly initial: Version;
  readonly sourceHash: string;
}

interface State {
  selected: Version;
}

function reportChanges(): Record<string, unknown>[] {
  const changes: Record<string, unknown>[] = [
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
  return changes;
}

const report = defineScenario<Context, State>({
  id: "expert/report",
  scriptedLanguages: ["en"],
  policy: {
    catalog: ["edit_workbook", "calculate_workbook", "prepare_edit"],
    requests: 16,
    calls: 16,
    window: 65536,
    numPredict: 8192,
    timeoutMs: 180000,
    thinking: "drop",
    think: false,
  },
  async setup(session) {
    const created = await session.call("create_workbook", {
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
    });
    assert(!created.isError, created.text);
    const initial = versionSchema.parse(created.body).version;
    return {
      initial,
      sourceHash: createHash("sha256")
        .update(await readFile(join(session.directory, initial.filePath)))
        .digest("hex"),
    };
  },
  brief({ initial }, language) {
    return {
      system,
      user: `${tasks[language]}\nSource: ${JSON.stringify(initial)}\nPNG base64: ${png}`,
    };
  },
  start: ({ initial }) => ({ selected: initial }),
  observe(state, outcome) {
    if (!outcome.isError && outcome.name !== "prepare_edit")
      state.selected = versionSchema.parse(outcome.body).version;
  },
  async scripted(call, _context, state) {
    const step = async (
      name: string,
      args: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      const outcome = await call(name, args);
      assert(!outcome.isError, outcome.text);
    };
    await step("edit_workbook", {
      source: state.selected,
      changes: reportChanges(),
    });
    await step("calculate_workbook", { source: state.selected });
    await step("edit_workbook", {
      source: state.selected,
      changes: [
        { kind: "protect_sheet", sheetName: "Report" },
        { kind: "protect_workbook", sheetName: "Report" },
      ],
    });
    return "";
  },
  async grade({ session, context, state, mode, final }) {
    const selected = state.selected;
    if (mode === "model")
      assert(
        final.includes(selected.filePath),
        "Model did not identify its final output",
      );
    const checked = await exec(
      "python3",
      ["-I", oracle, join(session.directory, selected.filePath)],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const result = oracleSchema.parse(JSON.parse(checked.stdout));
    assert.equal(result.sheets["Report"]?.["1,2"]?.value, "2026-10");
    assert.equal(result.sheets["Report"]?.["3,2"]?.value, 35);
    assert(result.sheets["Report"]?.["3,2"]?.formula);
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
        .update(
          await readFile(join(session.directory, context.initial.filePath)),
        )
        .digest("hex"),
      context.sourceHash,
    );
    await writeFile(
      join(session.directory, "oracle.json"),
      JSON.stringify(JSON.parse(checked.stdout), null, 2),
    );
    return { output: selected };
  },
});

export const expertScenarios: readonly LabScenario[] = [report];
