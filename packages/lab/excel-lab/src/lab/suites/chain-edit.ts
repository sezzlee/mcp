import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Session } from "../session.ts";
import type { LabScenario } from "../trial.ts";
import {
  chainScenario,
  readTools,
  receiptOf,
  sha256Of,
  versionSchema,
  type ChainContext,
  type Version,
} from "./chain.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const text = (value: string) => ({ kind: "text", value });
const number = (value: number) => ({ kind: "number", value });

const months = [
  ["Jan", 1100],
  ["Feb", 1180],
  ["Mar", 1520],
  ["Apr", 1340],
  ["May", 1210],
  ["Jun", 1290],
] as const;

function salesBlock(rows: readonly (readonly [string, number])[]) {
  return {
    startCell: "A1",
    values: [
      [text("Month"), text("Amount")],
      ...rows.map(([month, amount]) => [text(month), number(amount)]),
      [text("Total"), { kind: "blank" }],
    ],
  };
}

function totalFormula(rows: number) {
  return {
    kind: "write_formula",
    sheetName: "Sales",
    cell: `B${rows + 2}`,
    formula: `SUM(B2:B${rows + 1})`,
  };
}

async function create(
  session: Session,
  args: Readonly<Record<string, unknown>>,
): Promise<Version> {
  return receiptOf(await session.call("create_workbook", args));
}

async function context(
  session: Session,
  source: Version,
  prompt: ChainContext["prompt"],
  extra?: unknown,
): Promise<ChainContext> {
  return {
    source: source.filePath,
    sourceHash: await sha256Of(join(session.directory, source.filePath)),
    prompt,
    ...(extra === undefined ? {} : { extra }),
  };
}

const read = z.object({ version: versionSchema });

function setAmount(cell: string, value: number) {
  return {
    kind: "write_cells",
    sheetName: "Sales",
    startCell: cell,
    values: [[number(value)]],
    overwrite: true,
  };
}

const versionEdit = chainScenario({
  id: "chain/version-edit",
  catalog: [...readTools, "edit_workbook"],
  async setup(session) {
    const source = await create(session, {
      sheets: [{ name: "Sales", blocks: [salesBlock(months)] }],
      changes: [totalFormula(months.length)],
    });
    return context(session, source, {
      tr: `${source.filePath} satış dosyamda Sales sayfasındaki Mart tutarı yanlış: 1520 değil 1250 olmalı. Düzeltip yeni sürüm olarak kaydet.`,
      en: `In my sales workbook ${source.filePath}, the March amount on the Sales sheet is wrong: it should be 1250, not 1520. Fix it and save it as a new version.`,
    });
  },
  async scripted(call, { source }) {
    const described = read.parse(
      (await call("describe_workbook", { filePath: source })).body,
    );
    const rows = await call("read_sheet", {
      filePath: source,
      sheetName: "Sales",
    });
    assert(!rows.isError, rows.text);
    receiptOf(
      await call("edit_workbook", {
        source: described.version,
        changes: [setAmount("B4", 1250)],
      }),
    );
  },
});

const staleRecovery = chainScenario({
  id: "chain/stale-recovery",
  catalog: [...readTools, "edit_workbook"],
  async setup(session) {
    const earlier = await create(session, {
      sheets: [{ name: "Sales", blocks: [salesBlock(months)] }],
      changes: [totalFormula(months.length)],
    });
    const later = [...months, ["Jul", 1400] as const];
    const current = await create(session, {
      sheets: [{ name: "Sales", blocks: [salesBlock(later)] }],
      changes: [totalFormula(later.length)],
    });
    await copyFile(
      join(session.directory, current.filePath),
      join(session.directory, earlier.filePath),
    );
    return context(
      session,
      earlier,
      {
        tr: `${earlier.filePath} dosyasını daha önce okumuştun; okuduğun sürüm ${JSON.stringify(earlier)} idi. Sales sayfasındaki Mart tutarını 1250 olarak düzelt ve yeni sürüm olarak kaydet.`,
        en: `You read ${earlier.filePath} earlier; the version you read was ${JSON.stringify(earlier)}. Correct the March amount on the Sales sheet to 1250 and save it as a new version.`,
      },
      { stale: earlier },
    );
  },
  async scripted(call, { source, extra }) {
    const stale = z.object({ stale: versionSchema }).parse(extra).stale;
    const refused = await call("edit_workbook", {
      source: stale,
      changes: [setAmount("B4", 1250)],
    });
    assert(refused.isError, "The stale edit was not refused.");
    assert.equal(
      z.object({ error: z.string() }).parse(refused.body).error,
      "file_changed",
    );
    const described = read.parse(
      (await call("describe_workbook", { filePath: source })).body,
    );
    receiptOf(
      await call("edit_workbook", {
        source: described.version,
        changes: [setAmount("B4", 1250)],
      }),
    );
  },
});

const validationRemove = chainScenario({
  id: "chain/validation-remove",
  catalog: [...readTools, "get_data_validations", "edit_workbook"],
  async setup(session) {
    const source = await create(session, {
      sheets: [
        {
          name: "Tasks",
          blocks: [
            {
              startCell: "A1",
              values: [
                [text("Task"), text("Status"), text("Hours")],
                [text("Draft brief"), text("Open"), number(3)],
                [text("Review"), text("Done"), number(5)],
                [text("Publish"), text("Open"), number(2)],
              ],
            },
          ],
        },
      ],
      changes: [
        {
          kind: "set_validation",
          sheetName: "Tasks",
          range: "B2:B20",
          rule: { type: "list", items: ["Open", "Done"] },
        },
        {
          kind: "set_validation",
          sheetName: "Tasks",
          range: "C2:C20",
          rule: { type: "whole", operator: "between", bounds: [0, 40] },
        },
      ],
    });
    return context(session, source, {
      tr: `${source.filePath} dosyasında Tasks sayfasındaki Status sütunundan açılır liste kısıtını kaldır, herkes istediği durumu yazabilsin. Geri kalan her şey aynı kalsın.`,
      en: `In ${source.filePath}, remove the dropdown restriction from the Status column on the Tasks sheet so people can type any status. Keep everything else as it is.`,
    });
  },
  async scripted(call, { source }) {
    const listed = z
      .object({
        version: versionSchema,
        rules: z.array(
          z.object({ type: z.string(), ranges: z.array(z.string()) }),
        ),
      })
      .parse(
        (
          await call("get_data_validations", {
            filePath: source,
            sheetName: "Tasks",
          })
        ).body,
      );
    const list = listed.rules.find((rule) => rule.type === "list");
    assert(list !== undefined);
    receiptOf(
      await call("edit_workbook", {
        source: listed.version,
        changes: [
          {
            kind: "remove_validation",
            sheetName: "Tasks",
            ranges: list.ranges,
          },
        ],
      }),
    );
  },
});

const nameScope = chainScenario({
  id: "chain/name-scope",
  catalog: [...readTools, "edit_workbook"],
  async setup(session) {
    const quarter = (rate: number, alternative: number) => ({
      startCell: "A1",
      values: [
        [text("Rate"), number(rate)],
        [text("Revised rate"), number(alternative)],
      ],
    });
    const source = await create(session, {
      sheets: [
        { name: "Q1", blocks: [quarter(0.1, 0.12)] },
        { name: "Q2", blocks: [quarter(0.2, 0.25)] },
      ],
      changes: [
        {
          kind: "define_name",
          sheetName: "Q1",
          name: "Rate",
          scope: "sheet",
          range: "B1",
        },
        {
          kind: "define_name",
          sheetName: "Q2",
          name: "Rate",
          scope: "sheet",
          range: "B1",
        },
        { kind: "define_name", sheetName: "Q1", name: "Target", range: "B2" },
      ],
    });
    return context(session, source, {
      tr: `${source.filePath} dosyasında Q2 sayfasına ait Rate adı B1 yerine o sayfadaki B2 hücresini (Revised rate) göstersin. Diğer adlara dokunma.`,
      en: `In ${source.filePath}, make the Rate name that belongs to the Q2 sheet point to cell B2 on that sheet (the revised rate) instead of B1. Leave the other names alone.`,
    });
  },
  async scripted(call, { source }) {
    const described = z
      .object({
        version: versionSchema,
        definedNames: z.array(
          z.object({
            name: z.string(),
            scope: z.enum(["workbook", "sheet"]),
            sheetName: z.string().optional(),
          }),
        ),
      })
      .parse(
        (
          await call("describe_workbook", {
            filePath: source,
            includeDefinedNames: true,
          })
        ).body,
      );
    const rate = described.definedNames.find(
      (entry) =>
        entry.name === "Rate" &&
        entry.scope === "sheet" &&
        entry.sheetName === "Q2",
    );
    assert(rate?.sheetName !== undefined);
    receiptOf(
      await call("edit_workbook", {
        source: described.version,
        changes: [
          {
            kind: "define_name",
            sheetName: rate.sheetName,
            name: rate.name,
            scope: rate.scope,
            range: "B2",
            overwrite: true,
          },
        ],
      }),
    );
  },
});

const imageRemove = chainScenario({
  id: "chain/image-remove",
  catalog: [...readTools, "get_images", "edit_workbook"],
  async setup(session) {
    const source = await create(session, {
      sheets: [
        {
          name: "Cover",
          blocks: [
            {
              startCell: "A1",
              values: [
                [text("Quarterly report")],
                [text("Prepared by Finance")],
              ],
            },
          ],
        },
      ],
      changes: [
        {
          kind: "set_image",
          sheetName: "Cover",
          name: "Logo",
          cell: "D1",
          mime: "image/png",
          data: png,
          width: 48,
          height: 48,
        },
        {
          kind: "set_image",
          sheetName: "Cover",
          name: "Signature",
          cell: "D12",
          mime: "image/png",
          data: png,
          width: 96,
          height: 24,
        },
      ],
    });
    return context(session, source, {
      tr: `${source.filePath} dosyasında Cover sayfasındaki imza görselini kaldır; logo kalsın.`,
      en: `In ${source.filePath}, remove the signature image from the Cover sheet; keep the logo.`,
    });
  },
  async scripted(call, { source }) {
    const listed = z
      .object({
        version: versionSchema,
        images: z.array(z.object({ name: z.string().optional() })),
      })
      .parse(
        (await call("get_images", { filePath: source, sheetName: "Cover" }))
          .body,
      );
    const signature = listed.images.find((image) =>
      /signature/i.test(image.name ?? ""),
    );
    assert(signature?.name !== undefined);
    receiptOf(
      await call("edit_workbook", {
        source: listed.version,
        changes: [
          { kind: "remove_image", sheetName: "Cover", name: signature.name },
        ],
      }),
    );
  },
});

const cfPriority = chainScenario({
  id: "chain/cf-priority",
  catalog: [...readTools, "get_conditional_formats", "edit_workbook"],
  async setup(session) {
    const source = await create(session, {
      sheets: [
        {
          name: "Balance",
          blocks: [
            {
              startCell: "A1",
              values: [
                [text("Account"), text("Balance")],
                [text("Cash"), number(1250)],
                [text("Receivables"), number(-80)],
                [text("Inventory"), number(430)],
                [text("Payables"), number(-310)],
              ],
            },
          ],
        },
      ],
      changes: [
        {
          kind: "set_conditional_format",
          sheetName: "Balance",
          range: "B2:B5",
          priority: 1,
          rule: { type: "cellIs", operator: "greaterThan", formulas: ["1000"] },
          appearance: { fill: "00B050" },
        },
        {
          kind: "set_conditional_format",
          sheetName: "Balance",
          range: "B2:B5",
          priority: 2,
          rule: { type: "cellIs", operator: "lessThan", formulas: ["0"] },
          appearance: { fill: "FF0000" },
        },
      ],
    });
    return context(session, source, {
      tr: `${source.filePath} dosyasında Balance sayfasında negatif bakiyeleri vurgulayan koşullu biçimlendirmeyi sil; diğer vurgulama kalsın.`,
      en: `In ${source.filePath}, delete the conditional formatting that highlights negative balances on the Balance sheet; keep the other highlight.`,
    });
  },
  async scripted(call, { source }) {
    const listed = z
      .object({
        version: versionSchema,
        rules: z.array(
          z.object({
            priority: z.number(),
            operator: z.string().optional(),
            formulae: z.array(z.unknown()).optional(),
          }),
        ),
      })
      .parse(
        (
          await call("get_conditional_formats", {
            filePath: source,
            sheetName: "Balance",
          })
        ).body,
      );
    const negative = listed.rules.find(
      (rule) => rule.operator === "lessThan" && rule.formulae?.[0] === "0",
    );
    assert(negative !== undefined);
    receiptOf(
      await call("edit_workbook", {
        source: listed.version,
        changes: [
          {
            kind: "remove_conditional_format",
            sheetName: "Balance",
            priority: negative.priority,
          },
        ],
      }),
    );
  },
});

const expectedVersion = chainScenario({
  id: "chain/expected-version",
  catalog: [...readTools, "prepare_edit", "edit_workbook"],
  async setup(session) {
    const source = await create(session, {
      sheets: [{ name: "Sales", blocks: [salesBlock(months)] }],
      changes: [totalFormula(months.length)],
    });
    return context(
      session,
      source,
      {
        tr: `${source.filePath} dosyasını şu sürüm olarak okudum: ${JSON.stringify(source)}. Sales sayfasındaki Nisan tutarını 980 yap; değişiklik yalnızca tam olarak bu sürüme uygulansın, kaydetmeden önce de kontrol et.`,
        en: `I read ${source.filePath} as this version: ${JSON.stringify(source)}. Change the April amount on the Sales sheet to 980, make sure the change applies only to exactly that version, and check it before saving.`,
      },
      { read: source },
    );
  },
  async scripted(call, { source, extra }) {
    const version = z.object({ read: versionSchema }).parse(extra).read;
    const changes = [setAmount("B5", 980)];
    const prepared = await call("prepare_edit", {
      filePath: source,
      expectedVersion: version.versionId,
      changes,
    });
    assert(!prepared.isError, prepared.text);
    assert.equal(
      z.object({ kind: z.string() }).parse(prepared.body).kind,
      "ready",
    );
    receiptOf(await call("edit_workbook", { source: version, changes }));
  },
});

export const chainEditScenarios: readonly LabScenario[] = [
  versionEdit,
  staleRecovery,
  validationRemove,
  nameScope,
  imageRemove,
  cfPriority,
  expectedVersion,
];
