import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../public/samples/excel-mcp");
const ExcelJS = createRequire(
  path.resolve(here, "../../../packages/servers/excel-mcp/package.json"),
)("exceljs");

const stamp = new Date(Date.UTC(2026, 0, 1));
const regions = ["North", "South", "East", "West"];
const orders = [
  [1001, "2026-01-05", "North", "Ada", "Desk", 4, 250],
  [1002, "2026-01-06", "South", "Emre", "Chair", 10, 85],
  [1003, "2026-01-08", "East", "Lena", "Lamp", 12, 30],
  [1004, "2026-01-09", "North", "Ada", "Chair", 6, 85],
  [1005, "2026-01-12", "West", "Omar", "Desk", 2, 250],
  [1006, "2026-01-13", "South", "Emre", "Desk", 3, 250],
  [1007, "2026-01-15", "East", "Lena", "Chair", 8, 85],
  [1008, "2026-01-16", "West", "Omar", "Lamp", 20, 30],
  [1009, "2026-01-19", "North", "Ada", "Lamp", 5, 30],
  [1010, "2026-01-20", "South", "Emre", "Lamp", 7, 30],
  [1011, "2026-01-22", "East", "Lena", "Desk", 1, 250],
  [1012, "2026-01-23", "West", "Omar", "Chair", 9, 85],
];
const header = [
  "Order",
  "Date",
  "Region",
  "Rep",
  "Product",
  "Units",
  "Unit price",
  "Total",
];

function workbook() {
  const book = new ExcelJS.Workbook();
  book.creator = "sezzlee docs";
  book.created = stamp;
  book.modified = stamp;
  return book;
}

function orderRows() {
  return orders.map(([order, date, region, rep, product, units, price], i) => {
    const row = i + 2;
    return [
      order,
      new Date(`${date}T00:00:00Z`),
      region,
      rep,
      product,
      units,
      price,
      { formula: `F${row}*G${row}`, result: units * price },
    ];
  });
}

async function sales() {
  const book = workbook();
  const sheet = book.addWorksheet("Orders");
  sheet.addTable({
    name: "Orders",
    ref: "A1",
    headerRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: header.map((name) => ({ name, filterButton: true })),
    rows: orderRows(),
  });
  sheet.getColumn(2).numFmt = "yyyy-mm-dd";
  const last = orders.length + 1;
  sheet.dataValidations.add(`C2:C${last}`, {
    type: "list",
    allowBlank: false,
    formulae: [`"${regions.join(",")}"`],
  });
  sheet.addConditionalFormatting({
    ref: `H2:H${last}`,
    rules: [
      {
        type: "cellIs",
        operator: "greaterThan",
        formulae: ["800"],
        priority: 1,
        style: { font: { bold: true } },
      },
    ],
  });
  const targets = book.addWorksheet("Targets");
  targets.addRow(["Region", "Target"]);
  for (const [region, target] of [
    ["North", 2000],
    ["South", 1800],
    ["East", 1500],
    ["West", 1700],
  ]) {
    targets.addRow([region, target]);
  }
  book.definedNames.add("Targets!$A$1:$B$5", "RegionTargets");
  await book.xlsx.writeFile(path.join(out, "sales.xlsx"));
}

async function report() {
  const book = workbook();
  const sheet = book.addWorksheet("Report");
  sheet.addRow(["January sales report"]);
  sheet.mergeCells("A1:H1");
  sheet.addRow([]);
  sheet.addRow(header);
  for (const row of orderRows()) {
    const index = sheet.rowCount + 1;
    row[7] = { formula: `F${index}*G${index}`, result: row[7].result };
    sheet.addRow(row);
  }
  sheet.getColumn(2).numFmt = "yyyy-mm-dd";
  await book.xlsx.writeFile(path.join(out, "report.xlsx"));
}

function pictures() {
  const fixture = path.resolve(
    here,
    "../../../packages/servers/excel-mcp/test/fixtures/rich-values.xlsx.base64",
  );
  writeFileSync(
    path.join(out, "pictures.xlsx"),
    Buffer.from(readFileSync(fixture, "utf8"), "base64"),
  );
}

mkdirSync(out, { recursive: true });
await sales();
await report();
pictures();
process.stdout.write(`wrote ${path.relative(process.cwd(), out)}\n`);
