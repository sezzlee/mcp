import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createOoxmlWriter } from "@sezzlee/ooxml-core";
import { read } from "@e965/xlsx";

const directory = process.argv[2];
assert.ok(directory);
await mkdir(join(directory, "out"));
const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const office =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const relationships =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const parts = {
  "[Content_Types].xml":
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sheet.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  "_rels/.rels": `<Relationships xmlns="${relationships}"><Relationship Id="book" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/workbook.xml": `<workbook xmlns="${main}" xmlns:r="${office}"><sheets><sheet name="Data" sheetId="1" r:id="data"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${relationships}"><Relationship Id="data" Type="${office}/worksheet" Target="sheet.xml"/><Relationship Id="styles" Type="${office}/styles" Target="styles.xml"/></Relationships>`,
  "xl/styles.xml": `<styleSheet xmlns="${main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  "xl/sheet.xml": `<worksheet xmlns="${main}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" s="1"><v>10</v></c><c r="B2"><f>A2*2</f><v>20</v></c></row><row r="3"><c r="A3"><v>20</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>Keep this note</t></is></c></row></sheetData></worksheet>`,
};
const bytes = Buffer.from(
  createOoxmlWriter({
    fail: (code, message) => new Error(`${code}: ${message}`),
  }).zip(
    new Map(
      Object.entries(parts).map(([name, xml]) => [name, Buffer.from(xml)]),
    ),
    1_000_000,
  ),
);
await writeFile(join(directory, "external.xlsx"), bytes);
const source = {
  filePath: "external.xlsx",
  versionId: createHash("sha256").update(bytes).digest("hex"),
};
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@sezzlee/excel-mcp")), "cli.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, directory, "--write", "out"],
});
const client = new Client({ name: "packed-excel-writing", version: "1.0.0" });
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
async function sheet(version) {
  return read(await readFile(join(directory, version.filePath)), {
    type: "buffer",
    cellNF: true,
    sheetStubs: true,
  }).Sheets.Data;
}
try {
  await client.connect(transport);
  const changes = [
    { kind: "insert_rows", sheetName: "Data", at: 2, count: 1 },
    {
      kind: "copy_range",
      sheetName: "Data",
      range: "A3:B3",
      targetSheet: "Data",
      startCell: "D3",
      mode: "all",
    },
    {
      kind: "write_cells",
      sheetName: "Data",
      startCell: "A3",
      overwrite: true,
      values: [[{ kind: "number", value: 12 }]],
    },
  ];
  const prepared = await call("prepare_edit", {
    filePath: source.filePath,
    expectedVersion: source.versionId,
    changes,
  });
  assert.equal(prepared.kind, "ready");
  const edited = await call("edit_workbook", { source, changes });
  assert.equal(edited.editing.recalculated, false);
  assert.equal(edited.editing.recalculationRequired, true);
  const actual = await sheet(edited.version);
  assert.equal(actual.A3.v, 12);
  assert.equal(actual.A3.z, "0.00");
  assert.equal(actual.B3.f, "A3*2");
  const cached = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import sys, zipfile, xml.etree.ElementTree as E; p=zipfile.ZipFile(sys.argv[1]); s=zipfile.ZipFile(sys.argv[2]); ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}; cells=E.fromstring(p.read('xl/sheet.xml')).findall('.//s:c',ns); formulas=[c for c in cells if c.find('s:f',ns) is not None]; assert len(formulas)==2; assert all(c.find('s:v',ns) is None for c in formulas); assert p.read('xl/styles.xml')==s.read('xl/styles.xml')",
      join(directory, edited.version.filePath),
      join(directory, source.filePath),
    ],
    { encoding: "utf8" },
  );
  assert.equal(cached.status, 0, cached.stderr);
  assert.equal(actual.D3.v, 10);
  assert.equal(actual.D3.z, "0.00");
  assert.equal(actual.E3.f, "D3*2");
  assert.equal(actual.A6.v, "Keep this note");
  const retried = await call("edit_workbook", { source, changes });
  assert.deepEqual(retried.version, edited.version);
  const beforeFailure = await readdir(join(directory, "out"));
  const failed = await client.callTool({
    name: "edit_workbook",
    arguments: {
      source: edited.version,
      changes: [
        { kind: "clear_contents", sheetName: "Data", range: "A3" },
        { kind: "delete_sheet", sheetName: "Data" },
      ],
    },
  });
  assert.equal(failed.isError, true);
  assert.deepEqual(await readdir(join(directory, "out")), beforeFailure);
  const branch = await call("edit_workbook", {
    source,
    changes: [
      {
        kind: "write_cells",
        sheetName: "Data",
        startCell: "A2",
        overwrite: true,
        values: [[{ kind: "number", value: 77 }]],
      },
    ],
  });
  assert.equal((await sheet(branch.version)).A2.v, 77);
  assert.equal((await sheet(edited.version)).A3.v, 12);
  const restored = await call("create_workbook_version", {
    filePath: source.filePath,
    expectedVersion: source.versionId,
  });
  assert.deepEqual(
    await readFile(join(directory, restored.version.filePath)),
    bytes,
  );
  const transfer = await call("prepare_transfer", {
    filePath: "smoke.csv",
    selection: {
      kind: "records",
      headerRow: 1,
      columns: [{ column: "value", type: "number", decimal: "." }],
    },
  });
  const exported = await call("transfer_data", {
    transfer: transfer.transfer,
    target: { kind: "new", sheetName: "Export" },
  });
  const output = read(
    await readFile(join(directory, exported.version.filePath)),
    { type: "buffer" },
  ).Sheets.Export;
  assert.equal(output.A1.v, "name");
  assert.equal(output.B1.v, "value");
  assert.equal(output.A2.v, "a");
  assert.equal(output.B2.v, 1);
  assert.equal(output.A3.v, "b");
  assert.equal(output.B3.v, 2);
  const authored = await call("create_workbook", {
    sheets: [
      {
        name: "Report",
        blocks: [
          {
            startCell: "A1",
            values: [
              [
                { kind: "text", value: "Item" },
                { kind: "text", value: "Qty" },
                { kind: "text", value: "Price" },
                { kind: "text", value: "Amount" },
              ],
              [
                { kind: "text", value: "A" },
                { kind: "number", value: 2 },
                { kind: "number", value: 10 },
                { kind: "blank" },
              ],
            ],
          },
        ],
      },
    ],
    changes: [
      {
        kind: "create_table",
        sheetName: "Report",
        range: "A1:D3",
        name: "Orders",
        calculatedColumns: [{ column: "Amount", formula: "[@Qty]*[@Price]" }],
        totals: [
          { kind: "label", column: "Item", text: "Total" },
          { kind: "function", column: "Amount", function: "sum" },
        ],
      },
      {
        kind: "format_cells",
        sheetName: "Report",
        range: "C2:D3",
        style: { numberFormat: "0.00" },
      },
      { kind: "freeze_panes", sheetName: "Report", rows: 1, columns: 0 },
      {
        kind: "set_print_layout",
        sheetName: "Report",
        orientation: "landscape",
        fitWidth: 1,
        printArea: "A1:F3",
      },
      {
        kind: "write_formula",
        sheetName: "Report",
        cell: "F1",
        formula: "SUM(Orders[Amount])",
      },
      {
        kind: "write_formula",
        sheetName: "Report",
        cell: "F2",
        formula: "INDEX(A2:C2,2)",
      },
      {
        kind: "write_formula",
        sheetName: "Report",
        cell: "F3",
        formula: "INDEX(A1:D2,2)",
      },
      {
        kind: "write_formula",
        sheetName: "Report",
        cell: "F4",
        formula: "VLOOKUP(2,B2:C2,2.9,0)",
      },
      { kind: "merge_cells", sheetName: "Report", range: "G1:H1" },
    ],
  });
  assert.equal(authored.editing.recalculated, false);
  assert.equal(authored.editing.recalculationRequired, true);
  const authoringCheck = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      [
        "import sys,zipfile,xml.etree.ElementTree as E",
        "p=zipfile.ZipFile(sys.argv[1]); n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}",
        "s=E.fromstring(p.read('xl/worksheets/sheet1.xml')); cells={c.attrib['r']:c for c in s.findall('.//s:c',n)}",
        "assert cells['D2'].find('s:f',n).text=='Orders[[#This Row],[Qty]]*Orders[[#This Row],[Price]]'",
        "assert cells['F1'].find('s:f',n).text=='SUM(Orders[Amount])'",
        "assert all(c.find('s:v',n) is None for c in cells.values() if c.find('s:f',n) is not None)",
        "assert s.find('s:sheetViews/s:sheetView/s:pane',n).attrib['ySplit']=='1'",
        "assert s.find('s:pageSetup',n).attrib['orientation']=='landscape'",
        "assert s.find('s:mergeCells/s:mergeCell',n).attrib['ref']=='G1:H1'",
        "table=E.fromstring(p.read('xl/tables/table1.xml'))",
        "assert table.attrib['ref']=='A1:D3'",
        "assert table.findall('s:tableColumns/s:tableColumn',n)[3].find('s:calculatedColumnFormula',n).text=='Orders[[#This Row],[Qty]]*Orders[[#This Row],[Price]]'",
      ].join(";"),
      join(directory, authored.version.filePath),
    ],
    { encoding: "utf8" },
  );
  assert.equal(authoringCheck.status, 0, authoringCheck.stderr);
  const authoredBytes = await readFile(
    join(directory, authored.version.filePath),
  );
  const calculated = await call("calculate_workbook", {
    source: authored.version,
  });
  assert.equal(calculated.calculation.complete, false);
  assert.equal(calculated.calculation.calculatedCells, 4);
  assert.equal(calculated.calculation.unavailableCells, 2);
  const calculationCheck = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      [
        "import sys,zipfile,xml.etree.ElementTree as E",
        "p=zipfile.ZipFile(sys.argv[1]); n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}",
        "s=E.fromstring(p.read('xl/worksheets/sheet1.xml')); cells={c.attrib['r']:c for c in s.findall('.//s:c',n)}",
        "assert float(cells['D2'].find('s:v',n).text)==20",
        "assert float(cells['F1'].find('s:v',n).text)==20",
        "assert float(cells['F2'].find('s:v',n).text)==2",
        "assert cells['F3'].find('s:v',n) is None",
        "assert cells['F3'].find('s:f',n).text=='INDEX(A1:D2,2)'",
        "assert float(cells['F4'].find('s:v',n).text)==10",
        "assert cells['D3'].find('s:v',n) is None",
        "assert cells['D3'].find('s:f',n).text.startswith('SUBTOTAL(')",
        "assert cells['F1'].find('s:f',n).text=='SUM(Orders[Amount])'",
      ].join(";"),
      join(directory, calculated.version.filePath),
    ],
    { encoding: "utf8" },
  );
  assert.equal(calculationCheck.status, 0, calculationCheck.stderr);
  assert.deepEqual(
    await readFile(join(directory, authored.version.filePath)),
    authoredBytes,
  );
  assert.deepEqual(await readFile(join(directory, "external.xlsx")), bytes);
  const expertSource = await call("create_workbook", {
    sheets: [
      {
        name: "Data",
        blocks: [
          {
            startCell: "A1",
            values: [
              [
                { kind: "text", value: "Region" },
                { kind: "text", value: "Amount" },
              ],
              [
                { kind: "text", value: "North" },
                { kind: "number", value: 10 },
              ],
              [
                { kind: "text", value: "South" },
                { kind: "number", value: 20 },
              ],
              [
                { kind: "text", value: "North" },
                { kind: "number", value: 5 },
              ],
            ],
          },
        ],
      },
      { name: "Report", blocks: [] },
    ],
  });
  const expertBytes = await readFile(
    join(directory, expertSource.version.filePath),
  );
  const expert = await call("edit_workbook", {
    source: expertSource.version,
    changes: [
      { kind: "define_name", sheetName: "Report", name: "Period", range: "B1" },
      {
        kind: "write_named_range",
        sheetName: "Report",
        name: "Period",
        values: [[{ kind: "text", value: "2026-10" }]],
      },
      {
        kind: "set_validation",
        sheetName: "Data",
        range: "A2:A4",
        rule: { type: "list", items: ["North", "South"] },
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
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        width: 48,
        height: 48,
      },
      {
        kind: "set_pivot",
        sheetName: "Report",
        name: "Regional",
        cell: "A5",
        sourceSheet: "Data",
        sourceRange: "A1:B4",
        rowColumn: "Region",
        measures: [{ column: "Amount", function: "sum", name: "Total" }],
      },
      {
        kind: "set_chart",
        sheetName: "Report",
        name: "Sales",
        chartType: "column",
        cell: "E5",
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
      { kind: "protect_sheet", sheetName: "Report" },
      { kind: "protect_workbook", sheetName: "Report" },
    ],
  });
  const expertCheck = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      [
        "import sys,zipfile,xml.etree.ElementTree as E",
        "p=zipfile.ZipFile(sys.argv[1]); n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','c':'http://schemas.openxmlformats.org/drawingml/2006/chart','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}",
        "book=E.fromstring(p.read('xl/workbook.xml')); assert book.find('s:definedNames/s:definedName',n).text in [\"'Report'!$B$1\",\"'Report'!$B$1:$B$1\"]",
        "assert book.find('s:workbookProtection',n).attrib['lockStructure']=='1'",
        "data=E.fromstring(p.read('xl/worksheets/sheet1.xml')); report=E.fromstring(p.read('xl/worksheets/sheet2.xml'))",
        "assert data.find('s:dataValidations/s:dataValidation',n).attrib['sqref']=='A2:A4'",
        "assert data.find('s:conditionalFormatting/s:cfRule',n).attrib['stopIfTrue']=='1'",
        "cells={c.attrib['r']:c for c in report.findall('s:sheetData/s:row/s:c',n)}; assert cells['B1'].find('s:is/s:t',n).text=='2026-10'",
        "assert [float(cells[a].find('s:v',n).text) for a in ['B6','B7','B8']]==[15,20,35]",
        "assert report.find('s:sheetProtection',n) is not None; assert report.find('s:hyperlinks/s:hyperlink',n).attrib['ref']=='D1'",
        "names=p.namelist(); pivot=E.fromstring(p.read(next(a for a in names if a.startswith('xl/pivotTables/') and a.endswith('.xml')))); assert pivot.attrib['name']=='Regional'",
        "chart=E.fromstring(p.read(next(a for a in names if a.startswith('xl/charts/') and a.endswith('.xml')))); assert chart.find('.//c:ser/c:spPr/a:solidFill/a:srgbClr',n).attrib['val']=='4472C4'",
        "assert [float(v.text) for v in chart.findall('.//c:numCache/c:pt/c:v',n)]==[10,20,5]",
        "note=E.fromstring(p.read(next(a for a in names if a.startswith('xl/comments') and a.endswith('.xml')))); assert note.find('s:authors/s:author',n).text=='Finance'; assert ''.join(note.find('s:commentList/s:comment/s:text',n).itertext())=='Reviewed'",
        "assert any(a.startswith('xl/media/') and p.read(a).startswith(bytes.fromhex('89504e47')) for a in names)",
      ].join("\n"),
      join(directory, expert.version.filePath),
    ],
    { encoding: "utf8" },
  );
  assert.equal(expertCheck.status, 0, expertCheck.stderr);
  assert.deepEqual(
    await readFile(join(directory, expertSource.version.filePath)),
    expertBytes,
  );
  process.stdout.write(
    "Installed Excel editing, transfer, authoring, table formulas, bounded calculation, expert report features, layout, retry, atomic refusal and previous-version restore passed.\n",
  );
} finally {
  await client.close();
  await transport.close();
}
