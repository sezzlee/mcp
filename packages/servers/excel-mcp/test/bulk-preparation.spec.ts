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
import JSZip from "jszip";
import { expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createWorkbookOutput } from "../src/platform/versions.js";
import { createExcelMcpServer } from "../src/server.js";
import { rawWorkbook } from "./fixtures/raw-workbook.js";
import { bulkPreparationSchema } from "../src/tools/bulk-schemas.js";

const header =
  '<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>';
const originalSource =
  header +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2"><v>10</v></c></row>' +
  '<row r="3"><c r="A3" t="inlineStr"><is><t>b</t></is></c><c r="B3"><v>20</v></c></row>' +
  '<row r="4"><c r="A4" t="inlineStr"><is><t>c</t></is></c><c r="B4"><v>30</v></c></row>';
const originalTarget =
  header +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2"><v>10</v></c></row>' +
  '<row r="3"><c r="A3" t="inlineStr"><is><t>b</t></is></c><c r="B3"><v>9</v></c></row>' +
  '<row r="4"><c r="A4" t="inlineStr"><is><t>d</t></is></c><c r="B4"><v>40</v></c></row>';

async function workbook(
  sheetData: string,
  afterSheetData = "",
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(
    await rawWorkbook({ sheetData, afterSheetData }),
  );
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  return zip.generateAsync({ type: "uint8array" });
}

async function workspace(
  run: (directory: string, client: Client) => Promise<void>,
  mode: "read" | "write" = "write",
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "excel-bulk-preparation-"));
  const root = await createWorkbookRoot(directory);
  await mkdir(join(directory, "out"));
  await writeFile(
    join(directory, "source.xlsx"),
    await workbook(originalSource),
  );
  await writeFile(
    join(directory, "target.xlsx"),
    await workbook(originalTarget),
  );
  const server =
    mode === "read"
      ? createExcelMcpServer(root)
      : createExcelMcpServer(root, {
          mode: "write",
          output: await createWorkbookOutput(root, "out"),
        });
  const client = new Client({
    name: "bulk-preparation-acceptance",
    version: "1.0.0",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await run(directory, client);
    expect(await readdir(join(directory, "out"))).toEqual([]);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function payload(result: { readonly content: readonly unknown[] }): unknown {
  const first = result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("text" in first) ||
    typeof first.text !== "string"
  )
    throw new Error("Expected a JSON tool response");
  return JSON.parse(first.text);
}

async function request(directory: string) {
  async function input(filePath: string) {
    const bytes = await readFile(join(directory, filePath));
    return {
      filePath,
      versionId: createHash("sha256").update(bytes).digest("hex"),
      selection: {
        kind: "records",
        sheetName: "S",
        range: "A1:B4",
        headerRow: 1,
      },
    };
  }
  return {
    source: await input("source.xlsx"),
    target: await input("target.xlsx"),
    operation: {
      kind: "keyed_update",
      keys: [{ sourceColumn: "Id", targetColumn: "Id" }],
      set: [{ sourceColumn: "Value", targetColumn: "Value" }],
      overwrite: true,
    },
  };
}

it("analyzes complete records through MCP without writing and binds normalized requests to exact versions", async () => {
  await workspace(async (directory, client) => {
    const args = await request(directory);
    const beforeSource = await readFile(join(directory, "source.xlsx"));
    const beforeTarget = await readFile(join(directory, "target.xlsx"));
    const first = bulkPreparationSchema.parse(
      payload(await client.callTool({ name: "prepare_bulk", arguments: args })),
    );
    expect(first).toMatchObject({
      kind: "ready",
      validation: "keys_and_target_policy",
      executionAvailable: false,
      source: { filePath: "source.xlsx", versionId: args.source.versionId },
      target: { filePath: "target.xlsx", versionId: args.target.versionId },
      sourceSelection: { rows: 3, headerRows: 0, matchedRows: 3 },
      analysis: {
        matchedRecords: 2,
        sourceUnmatchedRecords: 1,
        targetUnmatchedRecords: 1,
        wouldUpdateRecords: 1,
        unchangedRecords: 1,
        wouldInsertRecords: 0,
      },
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      recalculated: false,
    });
    expect(
      payload(
        await client.callTool({
          name: "prepare_bulk",
          arguments: {
            ...args,
            operation: { ...args.operation, conflictPolicy: "error" },
          },
        }),
      ),
    ).toEqual(first);
    const changed = bulkPreparationSchema.parse(
      payload(
        await client.callTool({
          name: "prepare_bulk",
          arguments: {
            ...args,
            operation: { ...args.operation, kind: "upsert" },
          },
        }),
      ),
    );
    expect(changed).toMatchObject({
      kind: "ready",
      analysis: { wouldInsertRecords: 1 },
    });
    expect(changed.requestFingerprint).not.toEqual(first.requestFingerprint);
    expect(await readFile(join(directory, "source.xlsx"))).toEqual(
      beforeSource,
    );
    expect(await readFile(join(directory, "target.xlsx"))).toEqual(
      beforeTarget,
    );
    const tool = (await client.listTools()).tools.find(
      (item) => item.name === "prepare_bulk",
    );
    expect(tool).toMatchObject({
      annotations: { readOnlyHint: true },
      inputSchema: {
        properties: {
          operation: { type: "object" },
          source: { type: "object" },
          target: { type: "object" },
        },
      },
    });
  });
});

it("keeps bulk preparation unavailable in the default read server", async () => {
  await workspace(async (directory, client) => {
    expect(
      (await client.listTools()).tools.find(
        (item) => item.name === "prepare_bulk",
      ),
    ).toBeUndefined();
    await expect(
      client.callTool({
        name: "prepare_bulk",
        arguments: await request(directory),
      }),
    ).rejects.toMatchObject({ code: -32602 });
  }, "read");
});

it("preserves text/number/boolean, zero, whitespace and letter case in key identity", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.xlsx"),
      await workbook(
        header +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>0012</t></is></c><c r="B2"><v>1</v></c></row>' +
          '<row r="3"><c r="A3"><v>12</v></c><c r="B3"><v>2</v></c></row>' +
          '<row r="4"><c r="A4" t="inlineStr"><is><t>12</t></is></c><c r="B4"><v>3</v></c></row>' +
          '<row r="5"><c r="A5" t="inlineStr"><is><t>abc</t></is></c><c r="B5"><v>4</v></c></row>' +
          '<row r="6"><c r="A6" t="inlineStr"><is><t>ABC</t></is></c><c r="B6"><v>5</v></c></row>' +
          '<row r="7"><c r="A7" t="b"><v>0</v></c><c r="B7"><v>6</v></c></row>' +
          '<row r="8"><c r="A8"><v>0</v></c><c r="B8"><v>7</v></c></row>' +
          '<row r="9"><c r="A9" t="inlineStr"><is><t xml:space="preserve"> </t></is></c><c r="B9"><v>8</v></c></row>',
      ),
    );
    await writeFile(
      join(directory, "target.xlsx"),
      await workbook(
        header +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>0012</t></is></c><c r="B2"><v>1</v></c></row>' +
          '<row r="3"><c r="A3"><v>12</v></c><c r="B3"><v>9</v></c></row>' +
          '<row r="4"><c r="A4" t="inlineStr"><is><t>ABC</t></is></c><c r="B4"><v>5</v></c></row>' +
          '<row r="5"><c r="A5" t="b"><v>0</v></c><c r="B5"><v>6</v></c></row>' +
          '<row r="6"><c r="A6"><v>0</v></c><c r="B6"><v>7</v></c></row>' +
          '<row r="7"><c r="A7" t="inlineStr"><is><t xml:space="preserve"> </t></is></c><c r="B7"><v>8</v></c></row>',
      ),
    );
    const args = await request(directory);
    args.source.selection.range = "A1:B9";
    args.target.selection.range = "A1:B7";
    expect(
      payload(await client.callTool({ name: "prepare_bulk", arguments: args })),
    ).toMatchObject({
      kind: "ready",
      analysis: {
        matchedRecords: 6,
        sourceUnmatchedRecords: 2,
        targetUnmatchedRecords: 0,
        wouldUpdateRecords: 1,
        unchangedRecords: 5,
      },
    });
  });
});

it("keeps composite component boundaries distinct instead of concatenating keys", async () => {
  await workspace(async (directory, client) => {
    const composite =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c><c r="B1" t="inlineStr"><is><t>Part</t></is></c><c r="C1" t="inlineStr"><is><t>Value</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>a|b</t></is></c><c r="B2" t="inlineStr"><is><t>c</t></is></c><c r="C2"><v>1</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>a</t></is></c><c r="B3" t="inlineStr"><is><t>b|c</t></is></c><c r="C3"><v>2</v></c></row>';
    await writeFile(join(directory, "source.xlsx"), await workbook(composite));
    await writeFile(join(directory, "target.xlsx"), await workbook(composite));
    const args = await request(directory);
    args.source.selection.range = "A1:C3";
    args.target.selection.range = "A1:C3";
    args.operation.keys.push({ sourceColumn: "Part", targetColumn: "Part" });
    expect(
      payload(await client.callTool({ name: "prepare_bulk", arguments: args })),
    ).toMatchObject({
      kind: "ready",
      analysis: {
        matchedRecords: 2,
        unchangedRecords: 2,
        wouldUpdateRecords: 0,
      },
    });
  });
});

it.each(["source", "target"] as const)(
  "blocks duplicate keys on the %s with record positions and bounded diagnostics",
  async (side) => {
    await workspace(async (directory, client) => {
      const duplicate =
        header +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2"><v>1</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>a</t></is></c><c r="B3"><v>2</v></c></row>';
      await writeFile(
        join(directory, `${side}.xlsx`),
        await workbook(duplicate),
      );
      const result = payload(
        await client.callTool({
          name: "prepare_bulk",
          arguments: await request(directory),
        }),
      );
      expect(result).toMatchObject({
        kind: "blocked",
        failure: {
          kind: "record_conflicts",
          analysis: {
            conflictCount: 1,
            conflictsTruncated: false,
            conflicts: [
              { kind: "duplicate_key", side, record: 2, firstRecord: 1 },
            ],
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain('"wouldUpdateRecords"');
    });
  },
);

it("counts every missing-key conflict while returning only eight examples and no records", async () => {
  await workspace(async (directory, client) => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `<row r="${i + 2}"><c r="B${i + 2}"><v>999999</v></c></row>`,
    ).join("");
    await writeFile(
      join(directory, "source.xlsx"),
      await workbook(header + rows),
    );
    const args = await request(directory);
    args.source.selection.range = "A1:B13";
    const result = payload(
      await client.callTool({ name: "prepare_bulk", arguments: args }),
    );
    expect(result).toMatchObject({
      kind: "blocked",
      failure: {
        analysis: {
          conflictCount: 12,
          conflictsTruncated: true,
          conflicts: [1, 2, 3, 4, 5, 6, 7, 8].map((record) => ({
            kind: "missing_key",
            side: "source",
            record,
          })),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("999999");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
  });
});

it.each([
  { name: "blank", cell: "" },
  { name: "empty text", cell: '<c r="A2" t="inlineStr"><is><t></t></is></c>' },
])(
  "blocks a $name key without confusing zero or false with missing",
  async ({ cell }) => {
    await workspace(async (directory, client) => {
      await writeFile(
        join(directory, "source.xlsx"),
        await workbook(
          header + `<row r="2">${cell}<c r="B2"><v>1</v></c></row>`,
        ),
      );
      expect(
        payload(
          await client.callTool({
            name: "prepare_bulk",
            arguments: await request(directory),
          }),
        ),
      ).toMatchObject({
        kind: "blocked",
        failure: {
          analysis: {
            conflictCount: 1,
            conflicts: [{ kind: "missing_key", side: "source", record: 1 }],
          },
        },
      });
    });
  },
);

it("requires explicit overwrite for changed occupied values, while equal assignments remain unchanged", async () => {
  await workspace(async (directory, client) => {
    const args = await request(directory);
    const result = payload(
      await client.callTool({
        name: "prepare_bulk",
        arguments: {
          ...args,
          operation: {
            kind: "keyed_update",
            keys: args.operation.keys,
            set: args.operation.set,
          },
        },
      }),
    );
    expect(result).toMatchObject({
      kind: "blocked",
      failure: {
        analysis: {
          conflictCount: 1,
          conflicts: [{ kind: "overwrite_required", record: 2 }],
        },
      },
    });
  });
});

it("does not treat a filtered preview as the complete source selection", async () => {
  await workspace(async (directory, client) => {
    const args = await request(directory);
    expect(
      payload(
        await client.callTool({
          name: "prepare_bulk",
          arguments: {
            ...args,
            source: {
              ...args.source,
              selection: {
                ...args.source.selection,
                where: [{ column: "Value", op: "gte", value: 20 }],
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      kind: "ready",
      sourceSelection: { matchedRows: 2, rows: 2 },
      analysis: {
        matchedRecords: 1,
        sourceUnmatchedRecords: 1,
        targetUnmatchedRecords: 2,
        wouldUpdateRecords: 1,
        unchangedRecords: 0,
      },
    });
  });
});

it.each([
  {
    name: "duplicate",
    xml: header.replace("<t>Value</t>", "<t>Id</t>"),
    conflict: {
      kind: "duplicate_header",
      side: "source",
      column: 2,
      firstColumn: 1,
    },
  },
  {
    name: "missing",
    xml: header.replace("<t>Value</t>", "<t></t>"),
    conflict: { kind: "missing_header", side: "source", column: 2 },
  },
])(
  "blocks $name source headers instead of guessing a column",
  async ({ xml, conflict }) => {
    await workspace(async (directory, client) => {
      await writeFile(join(directory, "source.xlsx"), await workbook(xml));
      expect(
        payload(
          await client.callTool({
            name: "prepare_bulk",
            arguments: await request(directory),
          }),
        ),
      ).toMatchObject({
        kind: "blocked",
        failure: {
          analysis: { conflicts: expect.arrayContaining([conflict]) },
        },
      });
    });
  },
);

it("blocks incomplete upsert mappings instead of silently filling missing target fields", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "target.xlsx"),
      await workbook(
        originalTarget.replace(
          "</row>",
          '<c r="C1" t="inlineStr"><is><t>Note</t></is></c></row>',
        ),
      ),
    );
    const args = await request(directory);
    args.target.selection.range = "A1:C4";
    args.operation.kind = "upsert";
    expect(
      payload(await client.callTool({ name: "prepare_bulk", arguments: args })),
    ).toMatchObject({
      kind: "blocked",
      failure: {
        analysis: {
          conflicts: [{ kind: "incomplete_insert_mapping", columns: 1 }],
        },
      },
    });
  });
});

it("blocks protected targets before claiming key readiness", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "target.xlsx"),
      await workbook(originalTarget, '<sheetProtection sheet="1"/>'),
    );
    expect(
      payload(
        await client.callTool({
          name: "prepare_bulk",
          arguments: await request(directory),
        }),
      ),
    ).toMatchObject({
      kind: "blocked",
      failure: {
        kind: "target_policy",
        blockers: expect.arrayContaining([
          { kind: "workbook", code: "protected_sheet" },
        ]),
      },
    });
  });
});

it.each(["source", "target"] as const)(
  "rejects a stale exact %s version without producing output",
  async (side) => {
    await workspace(async (directory, client) => {
      const args = await request(directory);
      await writeFile(join(directory, `${side}.xlsx`), await workbook(header));
      const response = await client.callTool({
        name: "prepare_bulk",
        arguments: args,
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({ error: "file_changed" });
    });
  },
);

it.each([
  {
    name: "a filtered target",
    change: (args: Awaited<ReturnType<typeof request>>) => ({
      ...args,
      target: {
        ...args.target,
        selection: {
          ...args.target.selection,
          where: [{ column: "Id", op: "eq", value: "a" }],
        },
      },
    }),
  },
  {
    name: "a header outside the selected extent",
    change: (args: Awaited<ReturnType<typeof request>>) => ({
      ...args,
      target: {
        ...args.target,
        selection: { ...args.target.selection, headerRow: 2 },
      },
    }),
  },
  {
    name: "duplicate assignments",
    change: (args: Awaited<ReturnType<typeof request>>) => ({
      ...args,
      operation: {
        ...args.operation,
        set: [...args.operation.set, ...args.operation.set],
      },
    }),
  },
  {
    name: "key reassignment",
    change: (args: Awaited<ReturnType<typeof request>>) => ({
      ...args,
      operation: {
        ...args.operation,
        set: [{ sourceColumn: "Value", targetColumn: "Id" }],
      },
    }),
  },
])("rejects $name through MCP argument validation", async ({ change }) => {
  await workspace(async (directory, client) => {
    const response = await client.callTool({
      name: "prepare_bulk",
      arguments: change(await request(directory)),
    });
    expect(response.isError).toBe(true);
    expect(payload(response)).toMatchObject({ error: "invalid_argument" });
  });
});

it("rejects oversized descriptors before trying to read their sources", async () => {
  await workspace(async (directory, client) => {
    const args = await request(directory);
    const response = await client.callTool({
      name: "prepare_bulk",
      arguments: {
        ...args,
        source: { ...args.source, filePath: "missing.xlsx" },
        operation: {
          ...args.operation,
          keys: Array.from({ length: 9 }, (_, i) => ({
            sourceColumn: `${i}${"s".repeat(4000)}`,
            targetColumn: `${i}${"t".repeat(4000)}`,
          })),
        },
      },
    });
    expect(response.isError).toBe(true);
    expect(payload(response)).toMatchObject({
      error: "resource_limit",
      message: expect.stringContaining("64 KiB"),
    });
  });
});

it("enforces the record limit during complete source materialization", async () => {
  await workspace(async (directory, client) => {
    const csv =
      "Id,Value\n" +
      Array.from({ length: 100_001 }, (_, i) => `${i},1`).join("\n");
    await writeFile(join(directory, "source.csv"), csv);
    const args = await request(directory);
    const response = await client.callTool({
      name: "prepare_bulk",
      arguments: {
        ...args,
        source: {
          filePath: "source.csv",
          versionId: createHash("sha256").update(csv).digest("hex"),
          selection: {
            ...args.source.selection,
            sheetName: undefined,
            range: "A1:B100002",
          },
        },
      },
    });
    expect(response.isError).toBe(true);
    expect(payload(response)).toMatchObject({
      error: "resource_limit",
      message: expect.stringContaining("record budget"),
    });
  });
});

it("uses explicit CSV readings and complete selected subsets without implicit key coercion", async () => {
  await workspace(async (directory, client) => {
    const csv = "Id,Value\na,10\nb,20\nc,30\n";
    await writeFile(join(directory, "source.csv"), csv);
    const args = await request(directory);
    expect(
      payload(
        await client.callTool({
          name: "prepare_bulk",
          arguments: {
            ...args,
            source: {
              filePath: "source.csv",
              versionId: createHash("sha256").update(csv).digest("hex"),
              selection: {
                kind: "records",
                range: "A1:B4",
                headerRow: 1,
                columns: [{ column: "Value", type: "number", decimal: "." }],
                scope: { kind: "rows", rows: [2, 3] },
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      kind: "ready",
      sourceSelection: { rows: 2, matchedRows: 3, scope: "rows" },
      analysis: {
        matchedRecords: 2,
        sourceUnmatchedRecords: 0,
        targetUnmatchedRecords: 1,
        unchangedRecords: 1,
        wouldUpdateRecords: 1,
      },
    });
  });
});

it("preserves Unicode normalization differences in keys", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.xlsx"),
      await workbook(
        header +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>é</t></is></c><c r="B2"><v>1</v></c></row>' +
          '<row r="3"><c r="A3" t="inlineStr"><is><t>é</t></is></c><c r="B3"><v>2</v></c></row>',
      ),
    );
    await writeFile(
      join(directory, "target.xlsx"),
      await workbook(
        header +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>é</t></is></c><c r="B2"><v>1</v></c></row>',
      ),
    );
    expect(
      payload(
        await client.callTool({
          name: "prepare_bulk",
          arguments: await request(directory),
        }),
      ),
    ).toMatchObject({
      kind: "ready",
      analysis: {
        matchedRecords: 1,
        sourceUnmatchedRecords: 1,
        unchangedRecords: 1,
      },
    });
  });
});

it("matches local datetime precision without equating temporal cells with text", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.xlsx"),
      await workbook(
        header +
          '<row r="2"><c r="A2" t="d"><v>2026-10-26T09:30:00.100</v></c><c r="B2"><v>1</v></c></row>' +
          '<row r="3"><c r="A3" t="inlineStr"><is><t>2026-10-26T09:30:00.1</t></is></c><c r="B3"><v>2</v></c></row>',
      ),
    );
    await writeFile(
      join(directory, "target.xlsx"),
      await workbook(
        header +
          '<row r="2"><c r="A2" t="d"><v>2026-10-26T09:30:00.1</v></c><c r="B2"><v>1</v></c></row>',
      ),
    );
    expect(
      payload(
        await client.callTool({
          name: "prepare_bulk",
          arguments: await request(directory),
        }),
      ),
    ).toMatchObject({
      kind: "ready",
      analysis: {
        matchedRecords: 1,
        sourceUnmatchedRecords: 1,
        unchangedRecords: 1,
      },
    });
  });
});

it.each([
  {
    name: "error",
    cell: '<c r="A2" t="e"><v>#DIV/0!</v></c>',
    message: "without loss",
  },
  {
    name: "uncached formula",
    cell: '<c r="A2"><f>1+1</f></c>',
    message: "no saved result",
  },
])(
  "rejects an $name key instead of inventing an identity",
  async ({ cell, message }) => {
    await workspace(async (directory, client) => {
      await writeFile(
        join(directory, "source.xlsx"),
        await workbook(
          header + `<row r="2">${cell}<c r="B2"><v>1</v></c></row>`,
        ),
      );
      const response = await client.callTool({
        name: "prepare_bulk",
        arguments: await request(directory),
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({
        error: "invalid_argument",
        message: expect.stringContaining(message),
      });
    });
  },
);

it.each(["source", "target"] as const)(
  "analyzes an empty %s list without inventing a record",
  async (side) => {
    await workspace(async (directory, client) => {
      await writeFile(join(directory, `${side}.xlsx`), await workbook(header));
      const args = await request(directory);
      args.operation.kind = "upsert";
      expect(
        payload(
          await client.callTool({ name: "prepare_bulk", arguments: args }),
        ),
      ).toMatchObject({
        kind: "ready",
        analysis: {
          matchedRecords: 0,
          wouldUpdateRecords: 0,
          unchangedRecords: 0,
          sourceUnmatchedRecords: side === "source" ? 0 : 3,
          targetUnmatchedRecords: side === "target" ? 0 : 3,
          wouldInsertRecords: side === "source" ? 0 : 3,
        },
      });
    });
  },
);

it("bounds serialized key bytes independently of record and stored text limits", async () => {
  await workspace(async (directory, client) => {
    const prefix = "x".repeat(32_760);
    const rows = Array.from(
      { length: 513 },
      (_, i) =>
        `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>${prefix}${i}</t></is></c><c r="B${i + 2}"><v>1</v></c></row>`,
    ).join("");
    await writeFile(
      join(directory, "source.xlsx"),
      await workbook(header + rows),
    );
    const args = await request(directory);
    args.source.selection.range = "A1:B514";
    const response = await client.callTool({
      name: "prepare_bulk",
      arguments: args,
    });
    expect(response.isError).toBe(true);
    expect(payload(response)).toMatchObject({
      error: "resource_limit",
      message: expect.stringContaining("key indexes"),
    });
  });
});
