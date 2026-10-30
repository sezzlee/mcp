import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import JSZip from "jszip";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  createWorkbookOutput,
  mutationReceiptSchema,
} from "../src/platform/versions.js";
import { editPreparationSchema } from "../src/tools/edit-schemas.js";
import { createExcelMcpServer } from "../src/server.js";
import { rawWorkbook } from "./fixtures/raw-workbook.js";

const mainType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const office =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const types = "http://schemas.openxmlformats.org/package/2006/content-types";

async function seed(client: Client) {
  return mutationReceiptSchema.parse(
    payload(
      await client.callTool({
        name: "create_workbook",
        arguments: {
          sheets: [
            {
              name: "Data",
              blocks: [
                { startCell: "A1", values: [[{ kind: "number", value: 1 }]] },
              ],
            },
          ],
        },
      }),
    ),
  );
}

it("applies only the prepared edit and replays a verified receipt without another output", async () => {
  await workspace(async (directory, client) => {
    const original = await seed(client);
    const originalBytes = await readFile(
      join(directory, original.version.filePath),
    );
    const ready = await prepare(client, {
      filePath: original.version.filePath,
      expectedVersion: original.version,
      changes: [
        {
          kind: "write_cells",
          sheetName: "Data",
          startCell: "A1",
          values: [[{ kind: "number", value: 2 }]],
          overwrite: true,
        },
      ],
    });
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") throw new Error("Expected ready edit");
    const invalid = await client.callTool({
      name: "edit_workbook",
      arguments: {
        preparationId: ready.preparationId,
        changes: [{ kind: "delete_sheet", sheetName: "Data" }],
      },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(payload(invalid))).toContain("Unrecognized key");
    const apply = () =>
      client.callTool({
        name: ready.nextAction.tool,
        arguments: ready.nextAction.arguments,
      });
    const result = await apply();
    expect(result.isError).not.toBe(true);
    const receipt = mutationReceiptSchema.parse(payload(result));
    const outputs = await readdir(join(directory, "out"));
    expect(payload(await apply())).toEqual(receipt);
    expect(await readdir(join(directory, "out"))).toEqual(outputs);
    expect(await readFile(join(directory, original.version.filePath))).toEqual(
      originalBytes,
    );
    const read = payload(
      await client.callTool({
        name: "read_sheet",
        arguments: {
          filePath: receipt.version.filePath,
          sheetName: "Data",
          headerRow: 0,
        },
      }),
    );
    expect(read).toMatchObject({ values: [[2]] });
    await writeFile(join(directory, receipt.version.filePath), "changed");
    const changed = await apply();
    expect(changed.isError).toBe(true);
    expect(payload(changed)).toMatchObject({ error: "file_changed" });
  });
});

it("refuses stale sources and preparation ids from another session before publishing", async () => {
  await workspace(async (directory, client) => {
    const original = await seed(client);
    const ready = await prepare(client, {
      filePath: original.version.filePath,
      changes: [{ kind: "add_sheet", name: "New" }],
    });
    if (ready.kind !== "ready") throw new Error("Expected ready edit");
    await workspace(async (_otherDirectory, other) => {
      const result = await other.callTool({
        name: "edit_workbook",
        arguments: { preparationId: ready.preparationId },
      });
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({
        error: "invalid_argument",
        message: expect.stringContaining("another server session"),
      });
    });
    const outputs = await readdir(join(directory, "out"));
    await writeFile(join(directory, original.version.filePath), "changed");
    const result = await client.callTool({
      name: "edit_workbook",
      arguments: { preparationId: ready.preparationId },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "file_changed" });
    expect(await readdir(join(directory, "out"))).toEqual(outputs);
  });
});

it("expires preparations after fifteen minutes without publishing them", async () => {
  await workspace(async (directory, client) => {
    const original = await seed(client);
    const ready = await prepare(client, {
      filePath: original.version.filePath,
      changes: [{ kind: "add_sheet", name: "New" }],
    });
    if (ready.kind !== "ready") throw new Error("Expected ready edit");
    const outputs = await readdir(join(directory, "out"));
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now + 16 * 60_000);
      const result = await client.callTool({
        name: "edit_workbook",
        arguments: { preparationId: ready.preparationId },
      });
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({
        error: "invalid_argument",
        message: expect.stringContaining("expired"),
      });
      expect(await readdir(join(directory, "out"))).toEqual(outputs);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("bounds a session to eight retained preparations and releases expired slots", async () => {
  await workspace(async (_directory, client) => {
    const original = await seed(client);
    const args = {
      filePath: original.version.filePath,
      changes: [{ kind: "add_sheet", name: "New" }],
    };
    for (let index = 0; index < 8; index++)
      expect((await prepare(client, args)).kind).toBe("ready");
    const result = await client.callTool({
      name: "prepare_edit",
      arguments: args,
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: "resource_limit",
      message: expect.stringContaining("preparation store"),
    });
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now + 16 * 60_000);
      expect((await prepare(client, args)).kind).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });
});

it("rechecks external copy dependencies before applying a prepared edit", async () => {
  await workspace(async (directory, client) => {
    const original = await seed(client);
    const external = mutationReceiptSchema.parse(
      payload(
        await client.callTool({
          name: "create_workbook",
          arguments: {
            sheets: [
              {
                name: "Other",
                blocks: [
                  { startCell: "A1", values: [[{ kind: "number", value: 7 }]] },
                ],
              },
            ],
          },
        }),
      ),
    );
    const ready = await prepare(client, {
      filePath: original.version.filePath,
      changes: [
        {
          kind: "copy_range",
          sheetName: "Other",
          range: "A1",
          targetSheet: "Data",
          startCell: "B1",
          mode: "values",
          from: external.version,
        },
      ],
    });
    if (ready.kind !== "ready") throw new Error("Expected ready edit");
    const outputs = await readdir(join(directory, "out"));
    await writeFile(join(directory, external.version.filePath), "changed");
    const result = await client.callTool({
      name: "edit_workbook",
      arguments: { preparationId: ready.preparationId },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "file_changed" });
    expect(await readdir(join(directory, "out"))).toEqual(outputs);
  });
});

it("pins materialized retained rows even if the retained query expires before application", async () => {
  await workspace(async (_directory, client) => {
    const original = await seed(client);
    const aggregate = await client.callTool({
      name: "aggregate_sheet",
      arguments: {
        filePath: original.version.filePath,
        sheetName: "Data",
        headerRow: 0,
        range: "A1:A1",
        metrics: [{ fn: "sum", column: "A" }],
        resultMode: "retained",
      },
    });
    expect(aggregate.isError).not.toBe(true);
    const resultId = z
      .object({ resultId: z.string() })
      .parse(payload(aggregate)).resultId;
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now + 14 * 60_000);
      const ready = await prepare(client, {
        filePath: original.version.filePath,
        changes: [
          {
            kind: "write_cells",
            sheetName: "Data",
            startCell: "B1",
            source: { kind: "result", resultId },
          },
        ],
      });
      if (ready.kind !== "ready") throw new Error("Expected ready edit");
      vi.setSystemTime(now + 16 * 60_000);
      const expired = await client.callTool({
        name: "query_result",
        arguments: { resultId },
      });
      expect(expired.isError).toBe(true);
      expect(payload(expired)).toMatchObject({
        message: expect.stringMatching(/expired/),
      });
      const applied = await client.callTool({
        name: "edit_workbook",
        arguments: { preparationId: ready.preparationId },
      });
      expect(applied.isError).not.toBe(true);
      const receipt = mutationReceiptSchema.parse(payload(applied));
      const read = await client.callTool({
        name: "read_sheet",
        arguments: {
          filePath: receipt.version.filePath,
          sheetName: "Data",
          range: "B2:B2",
          headerRow: 0,
        },
      });
      expect(payload(read)).toMatchObject({ values: [[1]] });
    } finally {
      vi.useRealTimers();
    }
  });
});

function payload(result: { readonly content: readonly unknown[] }): unknown {
  const block = result.content[0];
  if (
    typeof block !== "object" ||
    block === null ||
    !("text" in block) ||
    typeof block.text !== "string"
  )
    throw new Error("Expected a JSON tool result");
  return JSON.parse(block.text);
}

async function workspace(
  run: (directory: string, client: Client) => Promise<void>,
  mode: "read" | "write" = "write",
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "excel-edit-preparation-"));
  await mkdir(join(directory, "out"));
  const root = await createWorkbookRoot(directory);
  const server =
    mode === "read"
      ? createExcelMcpServer(root)
      : createExcelMcpServer(root, {
          mode: "write",
          output: await createWorkbookOutput(root, "out"),
        });
  const client = new Client({
    name: "edit-preparation-acceptance",
    version: "1.0.0",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await run(directory, client);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function sourceBytes({
  before = "",
  after = "",
  workbook = "",
  contentType = mainType,
  strict = false,
  parts = {},
}: {
  readonly before?: string;
  readonly after?: string;
  readonly workbook?: string;
  readonly contentType?: string;
  readonly strict?: boolean;
  readonly parts?: Readonly<Record<string, string>>;
} = {}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(
    await rawWorkbook({
      strict,
      sheetData:
        '<row r="1"><c r="A1" s="1"><f t="shared" si="0">B1+1</f><v>2</v></c><c r="B1"><v>1</v></c></row>',
      beforeSheetData: before,
      afterSheetData: after,
      parts,
    }),
  );
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="${types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="${contentType}"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  if (workbook !== "") {
    const xml = await zip.file("xl/workbook.xml")?.async("string");
    if (xml === undefined) throw new Error("The raw workbook part is required");
    zip.file("xl/workbook.xml", xml.replace("<sheets>", workbook + "<sheets>"));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function prepare(client: Client, args: Record<string, unknown>) {
  const result = await preparedCall(client, {
    name: "prepare_edit",
    arguments: args,
  });
  expect(result.isError).not.toBe(true);
  return editPreparationSchema.parse(payload(result));
}

it("keeps edit inspection unavailable in default read mode", async () => {
  await workspace(async (_directory, client) => {
    expect(
      (await client.listTools()).tools.find(
        (tool) => tool.name === "prepare_edit",
      ),
    ).toBeUndefined();
    await expect(
      preparedCall(client, {
        name: "prepare_edit",
        arguments: {
          filePath: "missing.xlsx",
          changes: [{ kind: "add_sheet", name: "New" }],
        },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  }, "read");
});

it("prepares an executable canonical edit without output and binds both source and changes", async () => {
  await workspace(async (directory, client) => {
    const original = mutationReceiptSchema.parse(
      payload(
        await preparedCall(client, {
          name: "create_workbook",
          arguments: {
            sheets: [
              {
                name: "Data",
                blocks: [
                  { startCell: "A1", values: [[{ kind: "number", value: 1 }]] },
                ],
              },
            ],
          },
        }),
      ),
    );
    const bytes = await readFile(join(directory, original.version.filePath));
    const priorOutputs = await readdir(join(directory, "out"));
    const args = {
      filePath: original.version.filePath,
      expectedVersion: original.version.versionId,
      changes: [
        {
          kind: "write_cells",
          sheetName: "Data",
          startCell: "A1",
          values: [[{ kind: "number", value: 2 }]],
          overwrite: true,
        },
      ],
    };
    const first = await prepare(client, args);
    if (first.kind !== "ready")
      throw new Error("Expected a ready preparation.");
    expect(first).toMatchObject({
      kind: "ready",
      source: original.version,
      profile: "canonical_values",
      operations: 1,
      cellsRequested: 1,
      features: { sheets: 1, formulas: 0 },
      recalculated: false,
      publication: "not_published",
      nextAction: {
        tool: "edit_workbook",
        arguments: { preparationId: first.preparationId },
      },
    });
    expect(first.source.versionId).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const repeated = await prepare(client, args);
    if (repeated.kind !== "ready")
      throw new Error("Expected a ready preparation.");
    expect(repeated).toEqual({
      ...first,
      preparationId: repeated.preparationId,
      nextAction: {
        tool: "edit_workbook",
        arguments: { preparationId: repeated.preparationId },
      },
    });
    const changed = await prepare(client, {
      ...args,
      changes: [{ kind: "add_sheet", name: "New" }],
    });
    expect(changed.requestFingerprint).not.toBe(first.requestFingerprint);
    const defaultedChange = {
      kind: "write_cells",
      sheetName: "Data",
      startCell: "B1",
      values: [[{ kind: "number", value: 3 }]],
    };
    const defaulted = await prepare(client, {
      filePath: args.filePath,
      changes: [defaultedChange],
    });
    expect(
      await prepare(client, {
        filePath: args.filePath,
        changes: [{ ...defaultedChange, overwrite: false }],
      }),
    ).toEqual({
      ...defaulted,
      preparationId: expect.any(String),
      nextAction: {
        tool: "edit_workbook",
        arguments: { preparationId: expect.any(String) },
      },
    });
    expect(JSON.stringify(first).length).toBeLessThan(2048);
    expect(await readdir(join(directory, "out"))).toEqual(priorOutputs);
    const result = await preparedCall(client, {
      name: "edit_workbook",
      arguments: { source: first.source, changes: args.changes },
    });
    expect(result.isError).not.toBe(true);
    const edited = mutationReceiptSchema.parse(payload(result));
    const otherSource = await prepare(client, {
      ...args,
      filePath: edited.version.filePath,
      expectedVersion: edited.version.versionId,
    });
    expect(otherSource.requestFingerprint).not.toBe(first.requestFingerprint);
    expect(await readFile(join(directory, original.version.filePath))).toEqual(
      bytes,
    );
    const tool = (await client.listTools()).tools.find(
      (entry) => entry.name === "prepare_edit",
    );
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
    });
  });
});

it("prepares supported external edits and reports features without publishing", async () => {
  await workspace(async (directory, client) => {
    const bytes = await sourceBytes({
      after:
        '<mergeCells count="1"><mergeCell ref="C1:D1"/></mergeCells><conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>A1&gt;1</formula></cfRule></conditionalFormatting><dataValidations count="1"><dataValidation sqref="B1"/></dataValidations>',
      workbook:
        '<definedNames><definedName name="Value" localSheetId="0">S!$A$1</definedName></definedNames>',
    });
    await writeFile(join(directory, "source.xlsx"), bytes);
    const report = await prepare(client, {
      filePath: "source.xlsx",
      changes: [
        {
          kind: "write_cells",
          sheetName: "S",
          startCell: "B1",
          values: [[{ kind: "number", value: 3 }]],
          overwrite: true,
        },
      ],
    });
    expect(report).toMatchObject({
      kind: "ready",
      profile: "preserved_package",
      features: {
        sheets: 1,
        formulas: 1,
        sharedFormulas: 1,
        styledCells: 1,
        mergedRanges: 1,
        definedNames: 1,
        conditionalFormats: 1,
        validations: 1,
      },
      cellsRequested: 1,
    });
    expect(await readdir(join(directory, "out"))).toEqual([]);
    expect(await readFile(join(directory, "source.xlsx"))).toEqual(bytes);
    const executed = await preparedCall(client, {
      name: "edit_workbook",
      arguments: {
        source: report.source,
        changes: [{ kind: "add_sheet", name: "New" }],
      },
    });
    expect(executed.isError).not.toBe(true);
    expect(
      mutationReceiptSchema.parse(payload(executed)).editing?.operations,
    ).toBe(1);
    expect(await readdir(join(directory, "out"))).toHaveLength(1);
  });
});

it.each<{
  label: string;
  options: NonNullable<Parameters<typeof sourceBytes>[0]>;
  code: string;
}>([
  {
    label: "sheet protection",
    options: { after: '<sheetProtection sheet="1"/>' },
    code: "protected_sheet",
  },
  {
    label: "object protection",
    options: { after: '<sheetProtection sheet="false" objects="true"/>' },
    code: "protected_sheet",
  },
  {
    label: "XML boolean whitespace",
    options: { after: '<sheetProtection sheet=" true "/>' },
    code: "protected_sheet",
  },
  {
    label: "workbook structure",
    options: { workbook: '<workbookProtection lockStructure="true"/>' },
    code: "protected_workbook",
  },
  {
    label: "write reservation",
    options: { workbook: '<fileSharing reservationPassword="ABCD"/>' },
    code: "write_reservation",
  },
  {
    label: "macro content type",
    options: {
      contentType: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
    },
    code: "macros",
  },
  {
    label: "disguised VBA bytes",
    options: { parts: { "odd/vbaProject.bin": "opaque" } },
    code: "macros",
  },
  {
    label: "signature part",
    options: { parts: { "_xmlsignatures/sig1.xml": "<signature/>" } },
    code: "signed_package",
  },
  { label: "Strict markup", options: { strict: true }, code: "strict_markup" },
])("blocks $label without publishing a file", async ({ options, code }) => {
  await workspace(async (directory, client) => {
    await writeFile(join(directory, "source.xlsx"), await sourceBytes(options));
    const result = await prepare(client, {
      filePath: "source.xlsx",
      changes: [{ kind: "add_sheet", name: "New" }],
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked")
      expect(result.blockers).toContainEqual({ kind: "workbook", code });
    expect(await readdir(join(directory, "out"))).toEqual([]);
  });
});

it.each([
  {
    label: "empty protection elements",
    after: "<sheetProtection/>",
    workbook: "<workbookProtection/>",
  },
  {
    label: "explicit disabled flags",
    after: '<sheetProtection sheet="false" objects="0" scenarios="false"/>',
    workbook:
      '<workbookProtection lockStructure="0" lockWindows="false" lockRevision="0"/>',
  },
  {
    label: "foreign namespace",
    after: '<other:sheetProtection xmlns:other="urn:unrelated" sheet="1"/>',
    workbook: "",
  },
])(
  "does not report enabled protection for $label",
  async ({ after, workbook }) => {
    await workspace(async (directory, client) => {
      await writeFile(
        join(directory, "source.xlsx"),
        await sourceBytes({ after, workbook }),
      );
      const result = await prepare(client, {
        filePath: "source.xlsx",
        changes: [{ kind: "add_sheet", name: "New" }],
      });
      expect(result).toMatchObject({
        kind: "ready",
        features: { workbookProtected: false, protectedSheets: 0 },
      });
    });
  },
);

it("prepares and executes explicit clearing without shifting coordinates", async () => {
  await workspace(async (directory, client) => {
    const created = mutationReceiptSchema.parse(
      payload(
        await preparedCall(client, {
          name: "create_workbook",
          arguments: { sheets: [{ name: "Data" }] },
        }),
      ),
    );
    const changes = [
      { kind: "clear_contents", sheetName: "Data", range: "B2:D4" },
    ];
    const result = await prepare(client, {
      filePath: created.version.filePath,
      changes,
    });
    expect(result).toMatchObject({
      kind: "ready",
      profile: "preserved_package",
      cellsRequested: 9,
    });
    const execution = await preparedCall(client, {
      name: "edit_workbook",
      arguments: { source: result.source, changes },
    });
    expect(execution.isError).not.toBe(true);
    expect(
      mutationReceiptSchema.parse(payload(execution)).editing?.operations,
    ).toBe(1);
    expect(await readdir(join(directory, "out"))).toHaveLength(2);
  });
});

it.each([
  {
    label: "unknown sheet",
    changes: [
      {
        kind: "write_cells",
        sheetName: "Missing",
        startCell: "A1",
        values: [[{ kind: "number", value: 1 }]],
      },
    ],
    error: "unknown_sheet",
  },
  {
    label: "row overflow",
    changes: [
      {
        kind: "write_cells",
        sheetName: "S",
        startCell: "A1048576",
        values: [
          [{ kind: "number", value: 1 }],
          [{ kind: "number", value: 2 }],
        ],
      },
    ],
    error: "invalid_range",
  },
  {
    label: "reversed clear range",
    changes: [{ kind: "clear_contents", sheetName: "S", range: "D4:B2" }],
    error: "invalid_range",
  },
  {
    label: "clear budget",
    changes: [
      { kind: "clear_contents", sheetName: "S", range: "A1:XFD1048576" },
    ],
    error: "resource_limit",
  },
])("refuses $label before returning readiness", async ({ changes, error }) => {
  await workspace(async (directory, client) => {
    await writeFile(join(directory, "source.xlsx"), await sourceBytes());
    const result = await preparedCall(client, {
      name: "prepare_edit",
      arguments: { filePath: "source.xlsx", changes },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error });
    expect(await readdir(join(directory, "out"))).toEqual([]);
  });
});

it("rejects occupied canonical targets unless overwrite is explicit", async () => {
  await workspace(async (_directory, client) => {
    const created = mutationReceiptSchema.parse(
      payload(
        await preparedCall(client, {
          name: "create_workbook",
          arguments: {
            sheets: [
              {
                name: "Data",
                blocks: [
                  { startCell: "A1", values: [[{ kind: "text", value: "" }]] },
                ],
              },
            ],
          },
        }),
      ),
    );
    const result = await preparedCall(client, {
      name: "prepare_edit",
      arguments: {
        filePath: created.version.filePath,
        changes: [
          {
            kind: "write_cells",
            sheetName: "Data",
            startCell: "A1",
            values: [[{ kind: "blank" }]],
          },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toEqual({
      error: "invalid_argument",
      message: 'Cell A1 on sheet "Data" already holds a value.',
      recovery:
        "Check that this is the intended target. To keep its contents, write to an empty range or a new sheet (add_sheet); set overwrite:true only when the request asks to replace them.",
    });
  });
});

it("takes expectedVersion as the version object a receipt returned", async () => {
  await workspace(async (_directory, client) => {
    const created = mutationReceiptSchema.parse(
      payload(
        await preparedCall(client, {
          name: "create_workbook",
          arguments: {
            sheets: [
              {
                name: "Data",
                blocks: [
                  { startCell: "A1", values: [[{ kind: "number", value: 1 }]] },
                ],
              },
            ],
          },
        }),
      ),
    );
    const changes = [
      {
        kind: "write_cells",
        sheetName: "Data",
        startCell: "B1",
        values: [[{ kind: "number", value: 2 }]],
      },
    ];
    const ready = await preparedCall(client, {
      name: "prepare_edit",
      arguments: {
        filePath: created.version.filePath,
        expectedVersion: created.version,
        changes,
      },
    });
    expect(ready.isError, JSON.stringify(payload(ready))).not.toBe(true);
    expect(payload(ready)).toMatchObject({
      kind: "ready",
      source: created.version,
    });
    const stale = await preparedCall(client, {
      name: "prepare_edit",
      arguments: {
        filePath: created.version.filePath,
        expectedVersion: { ...created.version, versionId: "0".repeat(64) },
        changes,
      },
    });
    expect(stale.isError).toBe(true);
    expect(payload(stale)).toMatchObject({ error: "file_changed" });
  });
});

it("rejects stale sources, non-xlsx formats, compound-file containers and path escapes", async () => {
  const outside = await mkdtemp(join(tmpdir(), "excel-edit-outside-"));
  try {
    await writeFile(join(outside, "outside.xlsx"), await sourceBytes());
    await workspace(async (directory, client) => {
      const bytes = await sourceBytes();
      await writeFile(join(directory, "source.xlsx"), bytes);
      await writeFile(join(directory, "source.xlsm"), bytes);
      await writeFile(
        join(directory, "encrypted.xlsx"),
        Buffer.from("d0cf11e0a1b11ae10000000000000000", "hex"),
      );
      await symlink(
        join(outside, "outside.xlsx"),
        join(directory, "escape.xlsx"),
      );
      const changes = [{ kind: "add_sheet", name: "New" }];
      const initial = await prepare(client, {
        filePath: "source.xlsx",
        changes,
      });
      await writeFile(
        join(directory, "source.xlsx"),
        await sourceBytes({ workbook: '<workbookPr date1904="1"/>' }),
      );
      for (const [args, error] of [
        [
          {
            filePath: "source.xlsx",
            expectedVersion: initial.source.versionId,
          },
          "file_changed",
        ],
        [{ filePath: "source.xlsm" }, "invalid_argument"],
        [{ filePath: "encrypted.xlsx" }, "encrypted_workbook"],
        [
          { filePath: relative(directory, join(outside, "outside.xlsx")) },
          "path_outside_root",
        ],
        [{ filePath: "escape.xlsx" }, "path_outside_root"],
      ] as const) {
        const result = await preparedCall(client, {
          name: "prepare_edit",
          arguments: { ...args, changes },
        });
        expect(result.isError).toBe(true);
        expect(payload(result)).toMatchObject({ error });
      }
      expect(await readdir(join(directory, "out"))).toEqual([]);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it("resolves and prepares a noncanonical workbook entry point", async () => {
  await workspace(async (directory, client) => {
    const zip = await JSZip.loadAsync(await sourceBytes());
    zip.file(
      "_rels/.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${office}/officeDocument" Target="custom/book.xml"/></Relationships>`,
    );
    zip.file(
      "custom/book.xml",
      `<workbook xmlns="${main}" xmlns:r="${office}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    );
    zip.file(
      "custom/_rels/book.xml.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${office}/worksheet" Target="../xl/worksheets/sheet1.xml"/></Relationships>`,
    );
    zip.file(
      "[Content_Types].xml",
      `<Types xmlns="${types}"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/custom/book.xml" ContentType="${mainType}"/><Override PartName="/xl/workbook.xml" ContentType="application/xml"/></Types>`,
    );
    await writeFile(
      join(directory, "source.xlsx"),
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
    const result = await prepare(client, {
      filePath: "source.xlsx",
      changes: [{ kind: "add_sheet", name: "New" }],
    });
    expect(result).toMatchObject({
      kind: "ready",
      profile: "preserved_package",
      features: { sheets: 1, formulas: 1 },
    });
  });
});

it.each([
  {
    label: "invalid boolean flag",
    options: { after: '<sheetProtection sheet="FALSE"/>' },
    error: "corrupt_workbook",
  },
  {
    label: "non-spreadsheet main part",
    options: { contentType: "application/xml" },
    error: "not_a_workbook",
  },
])("returns a specific error for $label", async ({ options, error }) => {
  await workspace(async (directory, client) => {
    await writeFile(join(directory, "source.xlsx"), await sourceBytes(options));
    const result = await preparedCall(client, {
      name: "prepare_edit",
      arguments: {
        filePath: "source.xlsx",
        changes: [{ kind: "add_sheet", name: "New" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error });
  });
});

it.skipIf(process.env["SEZZLEE_CORPUS"] === undefined).each([
  { file: "Booleans.xlsx", protectedSheets: 0, strict: false },
  { file: "SimpleStrict.xlsx", protectedSheets: 0, strict: true },
  {
    file: "sheetProtection_not_protected.xlsx",
    protectedSheets: 0,
    strict: false,
  },
  {
    file: "workbookProtection_worksheet_protected.xlsx",
    protectedSheets: 1,
    strict: false,
  },
])(
  "inspects real corpus protection/conformance without changing $file",
  async ({ file, protectedSheets, strict }) => {
    const corpus = process.env["SEZZLEE_CORPUS"];
    if (corpus === undefined) throw new Error("The corpus root is required");
    const originalPath = join(
      corpus,
      "apache-testdata/files/poi/spreadsheet",
      file,
    );
    const original = await readFile(originalPath);
    await workspace(async (directory, client) => {
      await writeFile(join(directory, "source.xlsx"), original);
      const report = await prepare(client, {
        filePath: "source.xlsx",
        changes: [{ kind: "add_sheet", name: "NewInspectionSheet" }],
      });
      expect(report).toMatchObject({
        kind: protectedSheets > 0 || strict ? "blocked" : "ready",
        features: { protectedSheets, strict },
      });
      if (report.kind === "blocked") {
        expect(
          report.blockers.some(
            (entry) =>
              entry.kind === "workbook" && entry.code === "protected_sheet",
          ),
        ).toBe(protectedSheets > 0);
      }
      expect(report.source.versionId).toBe(
        createHash("sha256").update(original).digest("hex"),
      );
      expect(await readFile(originalPath)).toEqual(original);
      expect(await readdir(join(directory, "out"))).toEqual([]);
    });
  },
);
import { preparedCall } from "./fixtures/prepared-call.js";
