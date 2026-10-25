import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { read as independentRead } from "@e965/xlsx";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  createWorkbookOutput,
  mutationReceiptSchema,
} from "../src/platform/versions.js";
import { transferReceiptSchema } from "../src/tools/transfer-schemas.js";
import { createExcelMcpServer } from "../src/server.js";
import { preservationWorkbook } from "./fixtures/preservation.js";

function payload(result: { readonly content: readonly unknown[] }): unknown {
  const block = result.content[0];
  if (
    typeof block !== "object" ||
    block === null ||
    !("text" in block) ||
    typeof block.text !== "string"
  )
    throw new Error("Expected JSON output");
  return JSON.parse(block.text);
}
async function workspace(
  run: (
    directory: string,
    client: Client,
    source: { filePath: string; versionId: string },
  ) => Promise<void>,
  dependencies = false,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "preserved-edit-"));
  await mkdir(join(directory, "out"));
  const bytes = await preservationWorkbook(dependencies);
  await writeFile(join(directory, "source.xlsx"), bytes);
  const root = await createWorkbookRoot(directory);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({
    name: "preservation-acceptance",
    version: "1.0.0",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await run(directory, client, {
      filePath: "source.xlsx",
      versionId: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function edit(
  client: Client,
  source: { filePath: string; versionId: string },
  changes: readonly unknown[],
) {
  const response = await client.callTool({
    name: "edit_workbook",
    arguments: { source, changes },
  });
  expect(response.isError, JSON.stringify(payload(response))).not.toBe(true);
  return mutationReceiptSchema.parse(payload(response));
}
async function xml(
  directory: string,
  file: string,
  part: string,
): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(join(directory, file)));
  const value = await zip.file(part)?.async("string");
  if (value === undefined) throw new Error(`Missing ${part}`);
  return value;
}

it("edits an external cell while retaining styles, metadata, unrelated parts and original bytes", async () => {
  await workspace(async (directory, client, source) => {
    const original = await readFile(join(directory, source.filePath));
    const receipt = await edit(client, source, [
      {
        kind: "write_cells",
        sheetName: "Data",
        startCell: "B2",
        values: [[{ kind: "number", value: 99 }]],
        overwrite: true,
      },
    ]);
    const actual = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer", cellNF: true, sheetStubs: true },
    );
    expect(actual.Sheets.Data?.B2).toMatchObject({ v: 99, z: "0.00" });
    expect(actual.Sheets.Data?.C2?.f).toBe("B2*$E$1+Other!A1");
    expect(actual.Sheets.Data?.C2?.v).not.toBe(25);
    for (const part of [
      "xl/styles.xml",
      "xl/tables/table1.xml",
      "xl/charts/chart1.xml",
      "xl/drawings/drawing1.xml",
      "xl/worksheets/sheet3.xml",
      "customXml/item1.xml",
    ])
      expect(await xml(directory, receipt.version.filePath, part)).toBe(
        await xml(directory, source.filePath, part),
      );
    expect(await readFile(join(directory, source.filePath))).toEqual(original);
    expect(receipt.editing).toMatchObject({
      operations: 1,
      recalculated: false,
      recalculationRequired: true,
    });
  }, true);
});

it("clears content without shifting data or dropping the cell style", async () => {
  await workspace(async (directory, client, source) => {
    const receipt = await edit(client, source, [
      { kind: "clear_contents", sheetName: "Data", range: "B2:C2" },
    ]);
    const sheet = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer", sheetStubs: true, cellNF: true },
    ).Sheets.Data;
    expect(sheet?.B2?.v).toBeUndefined();
    expect(sheet?.B2?.z).toBe("0.00");
    expect(sheet?.B3?.v).toBe(20);
    expect(sheet?.A5?.v).toBe("Unrelated note");
    expect(receipt.editing?.cellsCleared).toBe(2);
  });
});

it.each(["all", "formulas", "values", "formatting"] as const)(
  "copies a formula range in explicit %s mode",
  async (mode) => {
    await workspace(async (directory, client, source) => {
      const receipt = await edit(client, source, [
        {
          kind: "copy_range",
          sheetName: "Data",
          range: "B2:C2",
          targetSheet: "Data",
          startCell: "B7",
          mode,
        },
      ]);
      const sheet = independentRead(
        await readFile(join(directory, receipt.version.filePath)),
        { type: "buffer", cellNF: true, sheetStubs: true },
      ).Sheets.Data;
      if (mode === "formatting") {
        expect(sheet?.B7?.v).toBeUndefined();
        expect(sheet?.B7?.z).toBe("0.00");
      } else {
        expect(sheet?.B7?.v).toBe(10);
        if (mode === "values") {
          expect(sheet?.C7?.f).toBeUndefined();
          expect(sheet?.C7?.v).toBe(25);
        } else expect(sheet?.C7?.f).toBe("B7*$E$1+Other!A6");
      }
      expect(sheet?.B2?.v).toBe(10);
    });
  },
);

it("inserts a row and updates formulas, table/name/rule ranges and drawing anchors together", async () => {
  await workspace(async (directory, client, source) => {
    const receipt = await edit(client, source, [
      { kind: "insert_rows", sheetName: "Data", at: 2, count: 1 },
    ]);
    const sheet = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer", sheetStubs: true },
    ).Sheets.Data;
    expect(sheet?.B3?.v).toBe(10);
    expect(sheet?.C3?.f).toBe("B3*$E$1+Other!A1");
    expect(sheet?.A6?.v).toBe("Unrelated note");
    expect(
      await xml(directory, receipt.version.filePath, "xl/tables/table1.xml"),
    ).toContain('ref="A1:C4"');
    expect(
      await xml(directory, receipt.version.filePath, "xl/charts/chart1.xml"),
    ).toContain("Data!$B$3:$B$4");
    expect(
      await xml(
        directory,
        receipt.version.filePath,
        "xl/drawings/drawing1.xml",
      ),
    ).toContain("<xdr:row>2</xdr:row>");
    expect(
      await xml(directory, receipt.version.filePath, "xl/workbook.xml"),
    ).toContain("Data!$B$3:$B$4");
  }, true);
});

it("deletes rows and shifts data while making a deleted scalar reference explicit", async () => {
  await workspace(async (directory, client, source) => {
    const receipt = await edit(client, source, [
      { kind: "delete_rows", sheetName: "Data", at: 2, count: 1 },
    ]);
    const workbook = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer", sheetStubs: true },
    );
    expect(workbook.Sheets.Data?.B2?.v).toBe(20);
    expect(workbook.Sheets.Data?.A4?.v).toBe("Unrelated note");
    expect(workbook.Sheets.Other?.B1?.f).toContain("#REF!");
  });
});

it("inserts and deletes table columns with matching headers, column inventory and references", async () => {
  await workspace(async (directory, client, source) => {
    const inserted = await edit(client, source, [
      { kind: "insert_columns", sheetName: "Data", at: 2, count: 1 },
    ]);
    const sheet = independentRead(
      await readFile(join(directory, inserted.version.filePath)),
      { type: "buffer", sheetStubs: true },
    ).Sheets.Data;
    expect(sheet?.B1?.v).toBe("Column4");
    expect(sheet?.C2?.v).toBe(10);
    expect(sheet?.D2?.f).toBe("C2*$F$1+Other!A1");
    expect(
      await xml(directory, inserted.version.filePath, "xl/tables/table1.xml"),
    ).toContain('tableColumns count="4"');
    const deleted = await edit(client, inserted.version, [
      { kind: "delete_columns", sheetName: "Data", at: 2, count: 1 },
    ]);
    const result = independentRead(
      await readFile(join(directory, deleted.version.filePath)),
      { type: "buffer", sheetStubs: true },
    ).Sheets.Data;
    expect(result?.B2?.v).toBe(10);
    expect(result?.C2?.f).toBe("B2*$E$1+Other!A1");
    expect(
      await xml(directory, deleted.version.filePath, "xl/tables/table1.xml"),
    ).toContain('tableColumns count="3"');
  }, true);
});

it("transfers complete Phase 2 values into an external workbook with header mapping", async () => {
  await workspace(async (directory, client, source) => {
    await writeFile(
      join(directory, "input.csv"),
      "Amount,Item,Total\n7,New,9\n",
    );
    const prepared = payload(
      await client.callTool({
        name: "prepare_transfer",
        arguments: {
          filePath: "input.csv",
          selection: { kind: "records", includeHeaders: false, headerRow: 1 },
        },
      }),
    );
    if (
      typeof prepared !== "object" ||
      prepared === null ||
      !("transfer" in prepared)
    )
      throw new Error("Missing transfer reference");
    const result = await client.callTool({
      name: "transfer_data",
      arguments: {
        transfer: prepared.transfer,
        target: {
          kind: "sheet",
          source,
          sheetName: "Data",
          startCell: "A7",
          mapping: { kind: "headers", headerRow: 1 },
        },
      },
    });
    expect(result.isError, JSON.stringify(payload(result))).not.toBe(true);
    const output = payload(result);
    if (typeof output !== "object" || output === null || !("version" in output))
      throw new Error("Missing output version");
    const receipt = transferReceiptSchema.parse(output);
    const sheet = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer", sheetStubs: true },
    ).Sheets.Data;
    expect(sheet?.A7?.v).toBe("New");
    expect(sheet?.B7?.v).toBe("7");
    expect(sheet?.C7?.v).toBe("9");
    expect(
      await xml(directory, receipt.version.filePath, "customXml/item1.xml"),
    ).toBe(await xml(directory, source.filePath, "customXml/item1.xml"));
  });
});

it("renames, reorders and copies sheets while preserving scoped names and independent parts", async () => {
  await workspace(async (directory, client, source) => {
    const receipt = await edit(client, source, [
      { kind: "rename_sheet", sheetName: "Data", name: "Yıl '26" },
      { kind: "reorder_sheet", sheetName: "Yıl '26", position: 2 },
      { kind: "copy_sheet", sheetName: "Yıl '26", name: "Copy", mode: "all" },
    ]);
    const result = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer", cellNF: true, sheetStubs: true },
    );
    expect(result.SheetNames).toEqual(["Other", "Yıl '26", "Notes", "Copy"]);
    expect(result.Sheets.Copy?.B2).toMatchObject({ v: 10, z: "0.00" });
    expect(result.Sheets.Other?.B1?.f).toBe("'Yıl ''26'!B2+'Yıl ''26'!$C$3");
    expect(
      await xml(directory, receipt.version.filePath, "customXml/item1.xml"),
    ).toBe(await xml(directory, source.filePath, "customXml/item1.xml"));
  });
});

it("copies a sheet with its table, drawing and chart relationship graph", async () => {
  await workspace(async (directory, client, source) => {
    const receipt = await edit(client, source, [
      { kind: "copy_sheet", sheetName: "Data", name: "Clone", mode: "all" },
    ]);
    const zip = await JSZip.loadAsync(
      await readFile(join(directory, receipt.version.filePath)),
    );
    const workbook = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer", sheetStubs: true },
    );
    expect(workbook.Sheets.Clone?.B2?.v).toBe(10);
    const copied = await Promise.all(
      Object.values(zip.files)
        .filter((entry) => entry.name.includes("sezzlee-copy-") && !entry.dir)
        .map((entry) => entry.async("string")),
    );
    expect(
      copied.some((text) => text.includes('displayName="CopiedTable2"')),
    ).toBe(true);
    expect(
      copied.some((text) => text.includes("&apos;Clone&apos;!$B$2:$B$3")),
    ).toBe(true);
  }, true);
});

it("moves a range and retargets incoming cross-sheet references", async () => {
  await workspace(async (directory, client, source) => {
    const receipt = await edit(client, source, [
      {
        kind: "move_range",
        sheetName: "Data",
        range: "B2:C3",
        targetSheet: "Data",
        startCell: "B7",
      },
    ]);
    const result = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer", sheetStubs: true },
    );
    expect(result.Sheets.Data?.B2?.v).toBeUndefined();
    expect(result.Sheets.Data?.B7?.v).toBe(10);
    expect(result.Sheets.Other?.B1?.f).toContain("Data!B7");
  });
});

it("keeps a transaction atomic, replays retries and branches from retained versions", async () => {
  await workspace(async (directory, client, source) => {
    const changes = [
      { kind: "clear_contents", sheetName: "Data", range: "B2" },
    ];
    const first = await edit(client, source, changes);
    const repeated = await edit(client, source, changes);
    expect(repeated.version).toEqual(first.version);
    const branch = await edit(client, source, [
      {
        kind: "write_cells",
        sheetName: "Data",
        startCell: "B2",
        overwrite: true,
        values: [[{ kind: "number", value: 77 }]],
      },
    ]);
    expect(
      independentRead(
        await readFile(join(directory, branch.version.filePath)),
        { type: "buffer", sheetStubs: true },
      ).Sheets.Data?.B2?.v,
    ).toBe(77);
    const before = await readdir(join(directory, "out"));
    const failure = await client.callTool({
      name: "edit_workbook",
      arguments: {
        source,
        changes: [
          { kind: "clear_contents", sheetName: "Data", range: "B2" },
          { kind: "delete_sheet", sheetName: "Missing" },
        ],
      },
    });
    expect(failure.isError).toBe(true);
    expect(payload(failure)).toMatchObject({ error: "unknown_sheet" });
    expect(await readdir(join(directory, "out"))).toEqual(before);
  });
});

it("deletes a sheet, updates its references and refuses deletion of the last visible sheet", async () => {
  await workspace(async (directory, client, source) => {
    const first = await edit(client, source, [
      { kind: "delete_sheet", sheetName: "Other" },
    ]);
    const book = independentRead(
      await readFile(join(directory, first.version.filePath)),
      { type: "buffer", sheetStubs: true },
    );
    expect(book.SheetNames).toEqual(["Data", "Notes"]);
    expect(book.Sheets.Data?.C2?.f).toContain("#REF!");
    const next = await edit(client, first.version, [
      { kind: "delete_sheet", sheetName: "Notes" },
    ]);
    const result = await client.callTool({
      name: "edit_workbook",
      arguments: {
        source: next.version,
        changes: [{ kind: "delete_sheet", sheetName: "Data" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "invalid_argument" });
  });
});

it("preserves ISO calendar meaning and cell formatting through date copy and explicit number replacement", async () => {
  await workspace(async (directory, client, source) => {
    const dated = await edit(client, source, [
      {
        kind: "write_cells",
        sheetName: "Data",
        startCell: "B2",
        overwrite: true,
        values: [[{ kind: "date", value: "2026-10-25" }]],
      },
      {
        kind: "copy_range",
        sheetName: "Data",
        range: "B2",
        targetSheet: "Data",
        startCell: "F7",
        mode: "all",
      },
    ]);
    const first = independentRead(
      await readFile(join(directory, dated.version.filePath)),
      { type: "buffer", cellDates: true, cellNF: true, sheetStubs: true },
    ).Sheets.Data;
    expect(first?.B2?.t).toBe("d");
    expect(first?.B2?.v).toEqual(new Date("2026-10-25T00:00:00Z"));
    expect(first?.F7?.v).toEqual(first?.B2?.v);
    const numbered = await edit(client, dated.version, [
      {
        kind: "write_cells",
        sheetName: "Data",
        startCell: "B2",
        overwrite: true,
        values: [[{ kind: "number", value: 7 }]],
      },
    ]);
    const last = independentRead(
      await readFile(join(directory, numbered.version.filePath)),
      { type: "buffer", cellDates: true, sheetStubs: true },
    ).Sheets.Data;
    expect(last?.B2).toMatchObject({ t: "n", v: 7 });
    expect(last?.F7?.v).toEqual(new Date("2026-10-25T00:00:00Z"));
  });
});

it("copies a complete merged range without losing its anchor, style or unrelated content", async () => {
  await workspace(async (directory, client, source) => {
    const zip = await JSZip.loadAsync(
      await readFile(join(directory, source.filePath)),
    );
    const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
    if (sheet === undefined) throw new Error("Missing sheet");
    zip.file(
      "xl/worksheets/sheet1.xml",
      sheet
        .replace('<c r="C2" s="1"><f>B2*$E$1+Other!A1</f><v>25</v></c>', "")
        .replace(
          "</sheetData>",
          '</sheetData><mergeCells count="1"><mergeCell ref="B2:C2"/></mergeCells>',
        ),
    );
    const bytes = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    await writeFile(join(directory, source.filePath), bytes);
    const selected = {
      ...source,
      versionId: createHash("sha256").update(bytes).digest("hex"),
    };
    const copied = await edit(client, selected, [
      {
        kind: "copy_range",
        sheetName: "Data",
        range: "B2:C2",
        targetSheet: "Data",
        startCell: "F7",
        mode: "all",
      },
    ]);
    const output = independentRead(
      await readFile(join(directory, copied.version.filePath)),
      { type: "buffer", cellNF: true, sheetStubs: true },
    ).Sheets.Data;
    expect(output?.F7).toMatchObject({ v: 10, z: "0.00" });
    expect(output?.["!merges"]).toContainEqual({
      s: { r: 6, c: 5 },
      e: { r: 6, c: 6 },
    });
    expect(output?.["!merges"]).toContainEqual({
      s: { r: 1, c: 1 },
      e: { r: 1, c: 2 },
    });
  });
});

it("copies existing formulas and formatting across exact pinned workbooks with compatible styles", async () => {
  await workspace(async (directory, client, source) => {
    const zip = await JSZip.loadAsync(await preservationWorkbook());
    const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
    if (sheet === undefined) throw new Error("Missing sheet");
    zip.file(
      "xl/worksheets/sheet1.xml",
      sheet.replace("B2*$E$1+Other!A1", "B2*$E$1"),
    );
    const original = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    await writeFile(join(directory, "copy-source.xlsx"), original);
    const from = {
      filePath: "copy-source.xlsx",
      versionId: createHash("sha256").update(original).digest("hex"),
    };
    const copied = await edit(client, source, [
      {
        kind: "copy_range",
        from,
        sheetName: "Data",
        range: "B2:C2",
        targetSheet: "Data",
        startCell: "F7",
        mode: "all",
      },
      {
        kind: "copy_sheet",
        from,
        sheetName: "Data",
        name: "Imported",
        mode: "all",
      },
    ]);
    const result = independentRead(
      await readFile(join(directory, copied.version.filePath)),
      { type: "buffer", cellNF: true, sheetStubs: true },
    );
    expect(result.Sheets.Data?.F7).toMatchObject({ v: 10, z: "0.00" });
    expect(result.Sheets.Data?.G7?.f).toBe("F7*$E$1");
    expect(result.Sheets.Imported?.C2?.f).toBe("B2*$E$1");
    expect(result.SheetNames).toEqual(["Data", "Other", "Notes", "Imported"]);
    expect(result.SheetNames.some((name) => name.startsWith("_Sezzlee"))).toBe(
      false,
    );
    expect(await readFile(join(directory, "copy-source.xlsx"))).toEqual(
      original,
    );
    expect(await xml(directory, copied.version.filePath, "xl/styles.xml")).toBe(
      await xml(directory, source.filePath, "xl/styles.xml"),
    );
  });
});

it("refuses stale or incompatible cross-workbook copies atomically without falling back to values", async () => {
  await workspace(async (directory, client, source) => {
    const zip = await JSZip.loadAsync(await preservationWorkbook());
    const styles = await zip.file("xl/styles.xml")?.async("string");
    if (styles === undefined) throw new Error("Missing styles");
    zip.file("xl/styles.xml", styles.replace("FFFF0000", "FF0000FF"));
    const bytes = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    await writeFile(join(directory, "copy-source.xlsx"), bytes);
    for (const [versionId, error] of [
      ["0".repeat(64), "file_changed"],
      [createHash("sha256").update(bytes).digest("hex"), "invalid_argument"],
    ] as const) {
      const result = await client.callTool({
        name: "edit_workbook",
        arguments: {
          source,
          changes: [
            { kind: "clear_contents", sheetName: "Data", range: "B2" },
            {
              kind: "copy_range",
              from: { filePath: "copy-source.xlsx", versionId },
              sheetName: "Data",
              range: "B2:C2",
              targetSheet: "Data",
              startCell: "F7",
              mode: "all",
            },
          ],
        },
      });
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ error });
      expect(await readdir(join(directory, "out"))).toEqual([]);
    }
  });
});

it("refuses overlapping copies and partially affected incoming ranges instead of corrupting references", async () => {
  await workspace(async (directory, client, source) => {
    for (const change of [
      {
        kind: "copy_range",
        sheetName: "Data",
        range: "B2:C3",
        targetSheet: "Data",
        startCell: "C3",
        mode: "all",
        overwrite: true,
      },
      {
        kind: "move_range",
        sheetName: "Data",
        range: "B2:C2",
        targetSheet: "Data",
        startCell: "B7",
      },
    ]) {
      const result = await client.callTool({
        name: "edit_workbook",
        arguments: { source, changes: [change] },
      });
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ error: "invalid_argument" });
      expect(await readdir(join(directory, "out"))).toEqual([]);
    }
  });
});

it("preserves a quoted sheet name containing attribute-like text when copying hidden state", async () => {
  await workspace(async (directory, client, source) => {
    const zip = await JSZip.loadAsync(
      await readFile(join(directory, source.filePath)),
    );
    const book = await zip.file("xl/workbook.xml")?.async("string");
    if (book === undefined) throw new Error("Missing workbook");
    zip.file(
      "xl/workbook.xml",
      book.replace(
        'name="Data" sheetId="1"',
        'name="Data" state="hidden" sheetId="1"',
      ),
    );
    const bytes = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    await writeFile(join(directory, source.filePath), bytes);
    const selected = {
      ...source,
      versionId: createHash("sha256").update(bytes).digest("hex"),
    };
    const result = await edit(client, selected, [
      {
        kind: "copy_sheet",
        sheetName: "Data",
        name: "X state='visible' sheet",
        mode: "all",
      },
    ]);
    const actual = independentRead(
      await readFile(join(directory, result.version.filePath)),
      { type: "buffer", sheetStubs: true },
    );
    expect(actual.SheetNames).toContain("X state='visible' sheet");
    expect(
      actual.Workbook?.Sheets?.find(
        (sheet) => sheet.name === "X state='visible' sheet",
      )?.Hidden,
    ).toBe(1);
  });
});

it.each([
  { formula: "B$2+$B2+$B$2+Other!A1", expected: "E$2+$B7+$B$2+Other!D6" },
  { formula: 'IF(B2>1,"A1","Other!B2")', expected: 'IF(E7>1,"A1","Other!B2")' },
])(
  "transforms existing references while preserving literals: $formula",
  async ({ formula, expected }) => {
    await workspace(async (directory, client, source) => {
      const zip = await JSZip.loadAsync(
        await readFile(join(directory, source.filePath)),
      );
      const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
      if (sheet === undefined) throw new Error("Missing sheet");
      zip.file(
        "xl/worksheets/sheet1.xml",
        sheet.replace("B2*$E$1+Other!A1", formula.replace(/>/g, "&gt;")),
      );
      const bytes = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
      });
      await writeFile(join(directory, source.filePath), bytes);
      const copied = await edit(
        client,
        {
          ...source,
          versionId: createHash("sha256").update(bytes).digest("hex"),
        },
        [
          {
            kind: "copy_range",
            sheetName: "Data",
            range: "C2",
            targetSheet: "Data",
            startCell: "F7",
            mode: "all",
          },
        ],
      );
      const actual = independentRead(
        await readFile(join(directory, copied.version.filePath)),
        { type: "buffer", sheetStubs: true },
      );
      expect(actual.Sheets.Data?.F7?.f).toBe(expected);
    });
  },
);

it.each(["values", "formulas", "formatting", "all"] as const)(
  "copies a whole sheet with explicit %s semantics",
  async (mode) => {
    await workspace(async (directory, client, source) => {
      const copied = await edit(client, source, [
        { kind: "copy_sheet", sheetName: "Data", name: "Template", mode },
      ]);
      const result = independentRead(
        await readFile(join(directory, copied.version.filePath)),
        { type: "buffer", cellNF: true, sheetStubs: true },
      ).Sheets.Template;
      if (mode === "formatting") {
        expect(result?.B2?.v).toBeUndefined();
        expect(result?.B2?.z).toBe("0.00");
        expect(result?.C2?.f).toBeUndefined();
      } else {
        expect(result?.B2?.v).toBe(10);
        expect(result?.B2?.z).toBe(mode === "all" ? "0.00" : "General");
        if (mode === "values") {
          expect(result?.C2?.f).toBeUndefined();
          expect(result?.C2?.v).toBe(25);
          expect(copied.editing?.cachedFormulaValues).toBe(2);
        } else expect(result?.C2?.f).toBe("B2*$E$1+Other!A1");
      }
    });
  },
);

it.each([
  { date1904: false, serial: 46320 },
  { date1904: true, serial: 44858 },
])(
  "copies numeric calendar meaning in values mode for date1904=$date1904",
  async ({ date1904, serial }) => {
    await workspace(async (directory, client, source) => {
      const zip = await JSZip.loadAsync(
        await readFile(join(directory, source.filePath)),
      );
      const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
      const styles = await zip.file("xl/styles.xml")?.async("string");
      const book = await zip.file("xl/workbook.xml")?.async("string");
      if (sheet === undefined || styles === undefined || book === undefined)
        throw new Error("Missing source parts");
      zip.file(
        "xl/worksheets/sheet1.xml",
        sheet.replace(
          '<c r="B2" s="1"><v>10</v>',
          `<c r="B2" s="1"><v>${serial}</v>`,
        ),
      );
      zip.file(
        "xl/styles.xml",
        styles.replace('xf numFmtId="2"', 'xf numFmtId="14"'),
      );
      zip.file(
        "xl/workbook.xml",
        book.replace('date1904="0"', `date1904="${date1904 ? 1 : 0}"`),
      );
      const bytes = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
      });
      await writeFile(join(directory, source.filePath), bytes);
      const copied = await edit(
        client,
        {
          ...source,
          versionId: createHash("sha256").update(bytes).digest("hex"),
        },
        [
          {
            kind: "copy_range",
            sheetName: "Data",
            range: "B2",
            targetSheet: "Data",
            startCell: "F7",
            mode: "values",
          },
        ],
      );
      const result = independentRead(
        await readFile(join(directory, copied.version.filePath)),
        { type: "buffer", cellDates: true, sheetStubs: true },
      ).Sheets.Data;
      expect(result?.F7).toMatchObject({
        t: "d",
        v: new Date("2026-10-25T00:00:00Z"),
      });
    });
  },
);
