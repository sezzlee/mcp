import assert from "node:assert/strict";
import { join } from "node:path";
import { z } from "zod";
import type { Session } from "../session.ts";
import type { LabScenario } from "../trial.ts";
import {
  chainScenario,
  readTools,
  receiptOf,
  sha256Of,
  type ChainContext,
  type Version,
} from "./chain.ts";

type Scalar = string | number;

interface Sheet {
  readonly name: string;
  readonly rows: readonly (readonly Scalar[])[];
  readonly formulas?: Readonly<Record<string, string>>;
}

function cellOf(value: Scalar): Readonly<Record<string, unknown>> {
  return typeof value === "number"
    ? { kind: "number", value }
    : { kind: "text", value };
}

async function fixture(
  session: Session,
  sheets: readonly Sheet[],
): Promise<{ readonly version: Version; readonly hash: string }> {
  const created = await session.call("create_workbook", {
    sheets: sheets.map((sheet) => ({
      name: sheet.name,
      blocks: [
        {
          startCell: "A1",
          values: sheet.rows.map((row) =>
            Array.from(
              { length: Math.max(...sheet.rows.map((entry) => entry.length)) },
              (_, column) => {
                const value = row[column];
                return value === undefined ? { kind: "blank" } : cellOf(value);
              },
            ),
          ),
        },
      ],
    })),
    changes: sheets.flatMap((sheet) =>
      Object.entries(sheet.formulas ?? {}).map(([cell, formula]) => ({
        kind: "write_formula",
        sheetName: sheet.name,
        cell,
        formula,
      })),
    ),
  });
  const version = receiptOf(created);
  return {
    version,
    hash: await sha256Of(join(session.directory, version.filePath)),
  };
}

async function single(
  session: Session,
  sheets: readonly Sheet[],
  prompt: (path: string) => ChainContext["prompt"],
): Promise<ChainContext> {
  const { version, hash } = await fixture(session, sheets);
  return {
    source: version.filePath,
    sourceHash: hash,
    prompt: prompt(version.filePath),
  };
}

const versionOf = (context: ChainContext): Version => {
  const parsed = z
    .object({
      version: z.object({ filePath: z.string(), versionId: z.string() }),
    })
    .parse(context.extra);
  return parsed.version;
};

const restructure = chainScenario({
  id: "chain/restructure",
  catalog: [...readTools, "edit_workbook"],
  async setup(session) {
    const { version, hash } = await fixture(session, [
      {
        name: "Draft",
        rows: [
          ["Item", "Amount"],
          ["Pens", 10],
          ["Paper", 20],
          ["Fax toner", 5],
          ["Ink", 15],
          ["Tape", 8],
          ["Total"],
        ],
        formulas: { B7: "SUM(B2:B6)" },
      },
    ]);
    return {
      source: version.filePath,
      sourceHash: hash,
      extra: { version },
      prompt: {
        tr: `${version.filePath} dosyasındaki listede artık "Fax toner" satırına gerek yok, onu sil. Ink ile Tape arasına 12 tutarında "Staples" satırı ekle. Sayfanın adını da "Supplies" yap. Toplam satırı tüm kalemleri kapsamaya devam etsin.`,
        en: `In ${version.filePath}, the "Fax toner" row is obsolete; delete it. Add a "Staples" row with amount 12 between Ink and Tape, and rename the sheet to "Supplies". The total must keep covering every item.`,
      },
    };
  },
  async scripted(call, context) {
    receiptOf(
      await call("edit_workbook", {
        source: versionOf(context),
        changes: [
          { kind: "delete_rows", sheetName: "Draft", at: 4, count: 1 },
          {
            kind: "insert_rows",
            sheetName: "Draft",
            at: 6,
            values: [
              [
                { kind: "text", value: "Staples" },
                { kind: "number", value: 12 },
              ],
            ],
          },
          { kind: "rename_sheet", sheetName: "Draft", name: "Supplies" },
        ],
      }),
    );
  },
});

const insertFormulas = chainScenario({
  id: "chain/insert-formulas",
  catalog: [...readTools, "edit_workbook"],
  async setup(session) {
    const { version, hash } = await fixture(session, [
      {
        name: "Orders",
        rows: [
          ["Item", "Qty", "Price", "Amount"],
          ["Desk", 2, 150],
          ["Chair", 4, 80],
          ["Total"],
        ],
        formulas: { D2: "B2*C2", D3: "B3*C3", D4: "SUM(D2:D3)" },
      },
    ]);
    return {
      source: version.filePath,
      sourceHash: hash,
      extra: { version },
      prompt: {
        tr: `${version.filePath} dosyasındaki sipariş listesine toplam satırının üstüne üç kalem ekle: Lamp 3 adet 40, Shelf 1 adet 120, Rug 2 adet 60. Diğer satırlar gibi tutarları adet çarpı fiyat olarak hesaplansın ve toplam yeni kalemleri de içersin.`,
        en: `Add three items above the total row of the order list in ${version.filePath}: Lamp, quantity 3 at 40; Shelf, quantity 1 at 120; Rug, quantity 2 at 60. Their amounts should be quantity times price like the other rows, and the total must include them.`,
      },
    };
  },
  async scripted(call, context) {
    const inserted = receiptOf(
      await call("edit_workbook", {
        source: versionOf(context),
        changes: [
          {
            kind: "insert_rows",
            sheetName: "Orders",
            at: 4,
            values: [
              ["Lamp", 3, 40],
              ["Shelf", 1, 120],
              ["Rug", 2, 60],
            ].map(([item, quantity, price]) => [
              { kind: "text", value: item },
              { kind: "number", value: quantity },
              { kind: "number", value: price },
              { kind: "formula", formula: "B{row}*C{row}" },
            ]),
          },
        ],
      }),
    );
    receiptOf(
      await call("edit_workbook", {
        source: inserted,
        changes: [
          {
            kind: "write_formula",
            sheetName: "Orders",
            cell: "D7",
            formula: "SUM(D2:D6)",
            overwrite: true,
          },
        ],
      }),
    );
  },
});

const salesRows: readonly (readonly Scalar[])[] = [
  ["Category", "Amount"],
  ["Food", 10],
  ["Toys", 20],
  ["Food", 5],
  ["Books", 7],
  ["Toys", 3],
  ["Food", 2],
];

const summaryFormulas = chainScenario({
  id: "chain/summary-formulas",
  catalog: [...readTools, "edit_workbook"],
  async setup(session) {
    const { version, hash } = await fixture(session, [
      { name: "Sales", rows: salesRows },
    ]);
    return {
      source: version.filePath,
      sourceHash: hash,
      extra: { version },
      prompt: {
        tr: `${version.filePath} dosyasına bir "Summary" sayfası ekle: her kategori (Food, Toys, Books) için toplam tutar ve genel toplam olsun. Satış verisi değişince özet de kendiliğinden güncellensin.`,
        en: `Add a "Summary" sheet to ${version.filePath} with the total amount for each category (Food, Toys, Books) and a grand total. The summary must update by itself when the sales data changes.`,
      },
    };
  },
  async scripted(call, context) {
    const categories = ["Food", "Toys", "Books"];
    receiptOf(
      await call("edit_workbook", {
        source: versionOf(context),
        changes: [
          { kind: "add_sheet", name: "Summary" },
          {
            kind: "write_cells",
            sheetName: "Summary",
            startCell: "A1",
            values: [
              [
                { kind: "text", value: "Category" },
                { kind: "text", value: "Amount" },
              ],
              ...[...categories, "Total"].map((label) => [
                { kind: "text", value: label },
              ]),
            ].map((row) =>
              row.length === 2 ? row : [...row, { kind: "blank" }],
            ),
          },
          ...categories.map((_label, index) => ({
            kind: "write_formula",
            sheetName: "Summary",
            cell: `B${index + 2}`,
            formula: `SUMIF(Sales!A2:A7,A${index + 2},Sales!B2:B7)`,
          })),
          {
            kind: "write_formula",
            sheetName: "Summary",
            cell: "B5",
            formula: "SUM(Sales!B2:B7)",
          },
        ],
      }),
    );
  },
});

const regionRows: readonly (readonly Scalar[])[] = [
  ["Region", "Item", "Amount"],
  ["North", "Pens", 10],
  ["South", "Paper", 12],
  ["North", "Ink", 5],
  ["East", "Tape", 3],
  ["South", "Desk", 8],
  ["West", "Lamp", 7],
];

const groupedReport = chainScenario({
  id: "chain/grouped-report",
  catalog: [...readTools, "create_workbook"],
  setup: (session) =>
    single(session, [{ name: "Sales", rows: regionRows }], (path) => ({
      tr: `${path} dosyasındaki satışlardan her bölgenin (Region) toplam tutarını (Amount) gösteren yeni bir çalışma kitabı oluştur.`,
      en: `Create a new workbook that shows the total Amount per Region from the sales in ${path}.`,
    })),
  async scripted(call, context) {
    const retained = await call("aggregate_sheet", {
      filePath: context.source,
      groupBy: ["Region"],
      metrics: [{ fn: "sum", column: "Amount" }],
      resultMode: "retained",
    });
    assert(!retained.isError, retained.text);
    const resultId = z
      .object({ resultId: z.string() })
      .parse(retained.body).resultId;
    receiptOf(
      await call("create_workbook", {
        sheets: [
          {
            name: "Totals",
            blocks: [
              {
                startCell: "A1",
                source: { kind: "result", resultId },
                header: ["Region", "Amount"],
              },
            ],
          },
        ],
      }),
    );
  },
});

const recordsSource = chainScenario({
  id: "chain/records-source",
  catalog: [...readTools, "create_workbook"],
  setup: (session) =>
    single(session, [{ name: "Sales", rows: regionRows }], (path) => ({
      tr: `${path} dosyasındaki satışlardan yalnız North bölgesine ait satırları, tüm sütunlarıyla, yeni bir çalışma kitabına koy.`,
      en: `Put only the North region's rows from the sales in ${path}, with all their columns, into a new workbook.`,
    })),
  async scripted(call, context) {
    receiptOf(
      await call("create_workbook", {
        sheets: [
          {
            name: "North",
            blocks: [
              {
                startCell: "A1",
                source: {
                  kind: "records",
                  filePath: context.source,
                  sheetName: "Sales",
                  headerRow: 1,
                  where: [{ column: "Region", op: "eq", value: "North" }],
                },
              },
            ],
          },
        ],
      }),
    );
  },
});

const products = (extra: readonly (readonly Scalar[])[]): Sheet => ({
  name: "Products",
  rows: [
    ["Item", "Price"],
    ["Keyboard", 45],
    ["Mouse", 25],
    ["Cable", 5],
    ...extra,
  ],
});

const twoFiles = chainScenario({
  id: "chain/two-files",
  catalog: [...readTools, "edit_workbook"],
  async setup(session) {
    const first = await fixture(session, [products([])]);
    const second = await fixture(session, [products([["Stand", 30]])]);
    return {
      source: first.version.filePath,
      sourceHash: first.hash,
      extra: {
        versions: [first.version, second.version],
        second: join(session.directory, second.version.filePath),
        secondHash: second.hash,
      },
      prompt: {
        tr: `${first.version.filePath} ve ${second.version.filePath} dosyalarında Mouse fiyatı yanlış girilmiş: 25 değil 20 olmalı. İki dosyada da düzelt.`,
        en: `The Mouse price is wrong in both ${first.version.filePath} and ${second.version.filePath}: it should be 20, not 25. Fix it in both files.`,
      },
    };
  },
  async scripted(call, context) {
    const versions = z
      .object({
        versions: z.array(
          z.object({ filePath: z.string(), versionId: z.string() }),
        ),
      })
      .parse(context.extra).versions;
    for (const source of versions)
      receiptOf(
        await call("edit_workbook", {
          source,
          changes: [
            {
              kind: "write_cells",
              sheetName: "Products",
              startCell: "B3",
              values: [[{ kind: "number", value: 20 }]],
              overwrite: true,
            },
          ],
        }),
      );
  },
});

export const chainSourceScenarios: readonly LabScenario[] = [
  restructure,
  insertFormulas,
  summaryFormulas,
  groupedReport,
  recordsSource,
  twoFiles,
];
