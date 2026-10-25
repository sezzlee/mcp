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
  assert.deepEqual(await readFile(join(directory, "external.xlsx")), bytes);
  process.stdout.write(
    "Installed Excel editing, transfer, retry, atomic refusal and previous-version restore passed.\n",
  );
} finally {
  await client.close();
  await transport.close();
}
