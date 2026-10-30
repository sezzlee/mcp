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
import { createExcelMcpServer } from "../src/server.js";
import { createAuthoredWorkbook } from "../src/format/authoring.js";
import {
  createWritingHandlers,
  writingToolDefinitions,
} from "../src/tools/writing.js";
import { createResultStore } from "../src/tools/retained-results.js";

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

it("refuses a block above the million-cell envelope before populating a workbook", () => {
  const row = Array.from(
    { length: 1_000 },
    () => ({ kind: "number", value: 1 }) as const,
  );
  expect(() =>
    createAuthoredWorkbook([
      {
        name: "TooLarge",
        blocks: [
          { startCell: "A1", values: Array.from({ length: 1_001 }, () => row) },
        ],
      },
    ]),
  ).toThrow(expect.objectContaining({ code: "resource_limit" }));
});

it("bounds aggregate stored text even when every cell meets its individual text limit", () => {
  const cell = { kind: "text", value: "x".repeat(32_767) } as const;
  expect(() =>
    createAuthoredWorkbook([
      {
        name: "TooMuchText",
        blocks: [
          {
            startCell: "A1",
            values: [Array.from({ length: 1_025 }, () => cell)],
          },
        ],
      },
    ]),
  ).toThrow(expect.objectContaining({ code: "resource_limit" }));
});

async function workspace(
  run: (directory: string, client: Client) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "excel-authoring-"));
  await mkdir(join(directory, "out"));
  const root = await createWorkbookRoot(directory);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({ name: "authoring-acceptance", version: "1.0.0" });
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

it("creates blank, header-only and positioned typed sheets readable independently and through MCP", async () => {
  await workspace(async (directory, client) => {
    const args = {
      sheets: [
        {
          name: "Giderler",
          blocks: [
            {
              startCell: "B2",
              values: [
                [
                  { kind: "text", value: "00123" },
                  { kind: "text", value: "=SUM(A1:A2)" },
                  { kind: "text", value: "" },
                ],
                [
                  { kind: "number", value: 12.25 },
                  { kind: "boolean", value: false },
                  { kind: "blank" },
                ],
                [
                  { kind: "date", value: "1900-02-28" },
                  { kind: "datetime", value: "2026-10-25T00:00:00.125" },
                  {
                    kind: "text",
                    value: "  Türkçe 😀 <&> _x000D_\r\n\u0000  ",
                  },
                ],
              ],
            },
          ],
        },
        { name: "Boş" },
        {
          name: "Başlık",
          blocks: [
            { startCell: "A1", values: [[{ kind: "text", value: "Tutar" }]] },
          ],
        },
      ],
    };
    const result = await preparedCall(client, {
      name: "create_workbook",
      arguments: args,
    });
    expect(result.isError).not.toBe(true);
    const receipt = mutationReceiptSchema.parse(payload(result));
    expect(receipt).toMatchObject({
      kind: "complete",
      source: null,
      changes: { sheetsAdded: 3, blocksWritten: 2, cellsWritten: 10 },
    });
    expect(JSON.stringify(receipt).length).toBeLessThan(700);
    const bytes = await readFile(join(directory, receipt.version.filePath));
    const independent = independentRead(bytes, {
      type: "buffer",
      cellDates: true,
    });
    expect(independent.SheetNames).toEqual(["Giderler", "Boş", "Başlık"]);
    const sheet = independent.Sheets["Giderler"];
    expect(sheet?.["B2"]).toMatchObject({ t: "s", v: "00123" });
    expect(sheet?.["C2"]).toMatchObject({ t: "s", v: "=SUM(A1:A2)" });
    expect(sheet?.["D2"]).toMatchObject({ t: "s", v: "" });
    expect(sheet?.["B3"]).toMatchObject({ t: "n", v: 12.25 });
    expect(sheet?.["C3"]).toMatchObject({ t: "b", v: false });
    expect(sheet?.["D3"]).toBeUndefined();
    expect(sheet?.["B4"]?.v).toEqual(new Date("1900-02-28T00:00:00.000Z"));
    expect(sheet?.["C4"]?.v).toEqual(new Date("2026-10-25T00:00:00.125Z"));
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
    expect(xml).toContain("&lt;&amp;&gt; _x005F_x000D__x000d_\n_x0000_");
    expect(xml).not.toContain("<f>");
    expect(
      await zip.file("xl/worksheets/sheet2.xml")?.async("string"),
    ).toContain("<sheetData></sheetData>");
    const read = await preparedCall(client, {
      name: "read_sheet",
      arguments: {
        filePath: receipt.version.filePath,
        sheetName: "Giderler",
        range: "B2:D4",
        headerRow: 0,
        valueMode: "values",
      },
    });
    expect(read.isError).not.toBe(true);
    expect(payload(read)).toMatchObject({
      values: [
        ["00123", "=SUM(A1:A2)", ""],
        [12.25, false, null],
        [
          "1900-02-28",
          "2026-10-25T00:00:00.125",
          "  Türkçe 😀 <&> _x000D_\n\u0000  ",
        ],
      ],
    });
    const retry = mutationReceiptSchema.parse(
      payload(
        await preparedCall(client, {
          name: "create_workbook",
          arguments: args,
        }),
      ),
    );
    expect(retry.version).toEqual(receipt.version);
    expect((await readdir(join(directory, "out"))).length).toBe(1);
  });
});

it("atomically corrects, appends and adds a sheet, reuses retries and keeps source branches immutable", async () => {
  await workspace(async (directory, client) => {
    const original = mutationReceiptSchema.parse(
      payload(
        await preparedCall(client, {
          name: "create_workbook",
          arguments: {
            sheets: [
              {
                name: "Giderler",
                blocks: [
                  {
                    startCell: "A1",
                    values: [
                      [
                        { kind: "text", value: "Başlık" },
                        { kind: "number", value: 10 },
                      ],
                    ],
                  },
                ],
              },
            ],
          },
        }),
      ),
    );
    const originalBytes = await readFile(
      join(directory, original.version.filePath),
    );
    const args = {
      source: original.version,
      changes: [
        { kind: "add_sheet", name: "Gelirler" },
        {
          kind: "write_cells",
          sheetName: "Giderler",
          startCell: "B1",
          overwrite: true,
          values: [[{ kind: "number", value: 20 }]],
        },
        {
          kind: "write_cells",
          sheetName: "Giderler",
          startCell: "A2",
          values: [
            [
              { kind: "text", value: "Yeni" },
              { kind: "number", value: 30 },
            ],
          ],
        },
        {
          kind: "write_cells",
          sheetName: "Gelirler",
          startCell: "A1",
          values: [[{ kind: "number", value: 100 }]],
        },
      ],
    };
    const edited = mutationReceiptSchema.parse(
      payload(
        await preparedCall(client, { name: "edit_workbook", arguments: args }),
      ),
    );
    expect(edited).toMatchObject({
      source: original.version,
      changes: { sheetsAdded: 1, blocksWritten: 3, cellsWritten: 4 },
    });
    expect(edited.version.versionId).not.toBe(original.version.versionId);
    const independent = independentRead(
      await readFile(join(directory, edited.version.filePath)),
      { type: "buffer" },
    );
    expect(independent.Sheets["Giderler"]?.["B1"]?.v).toBe(20);
    expect(independent.Sheets["Giderler"]?.["A2"]?.v).toBe("Yeni");
    expect(independent.Sheets["Gelirler"]?.["A1"]?.v).toBe(100);
    const retry = mutationReceiptSchema.parse(
      payload(
        await preparedCall(client, { name: "edit_workbook", arguments: args }),
      ),
    );
    expect(retry.version).toEqual(edited.version);
    const branch = mutationReceiptSchema.parse(
      payload(
        await preparedCall(client, {
          name: "edit_workbook",
          arguments: {
            source: original.version,
            changes: [
              {
                kind: "write_cells",
                sheetName: "Giderler",
                startCell: "B1",
                overwrite: true,
                values: [[{ kind: "blank" }]],
              },
            ],
          },
        }),
      ),
    );
    expect(branch.version.versionId).not.toBe(edited.version.versionId);
    expect(
      independentRead(
        await readFile(join(directory, branch.version.filePath)),
        { type: "buffer" },
      ).Sheets["Giderler"]?.["B1"],
    ).toBeUndefined();
    expect(await readFile(join(directory, original.version.filePath))).toEqual(
      originalBytes,
    );
    expect((await readdir(join(directory, "out"))).length).toBe(3);
  });
});

it("rejects invalid wire data and late transaction failures without publishing any partial output", async () => {
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
                  { startCell: "A1", values: [[{ kind: "text", value: "" }]] },
                ],
              },
            ],
          },
        }),
      ),
    );
    for (const [name, args, error] of [
      ["create_workbook", { sheets: [] }, "invalid_argument"],
      [
        "create_workbook",
        { sheets: [{ name: "Bad/name" }] },
        "invalid_argument",
      ],
      [
        "create_workbook",
        { sheets: [{ name: "Data" }, { name: "data" }] },
        "invalid_argument",
      ],
      [
        "create_workbook",
        {
          sheets: [
            {
              name: "S",
              blocks: [
                {
                  startCell: "A1",
                  values: [[{ kind: "number", value: 0.30000000000000004 }]],
                },
              ],
            },
          ],
        },
        "invalid_argument",
      ],
      [
        "create_workbook",
        {
          sheets: [
            {
              name: "S",
              blocks: [
                {
                  startCell: "XFD1048576",
                  values: [[{ kind: "blank" }, { kind: "blank" }]],
                },
              ],
            },
          ],
        },
        "invalid_range",
      ],
      [
        "create_workbook",
        {
          sheets: [
            {
              name: "S",
              blocks: [
                {
                  startCell: "A1",
                  values: [
                    [{ kind: "blank" }],
                    [{ kind: "blank" }, { kind: "blank" }],
                  ],
                },
              ],
            },
          ],
        },
        "invalid_argument",
      ],
      [
        "edit_workbook",
        {
          source: original.version,
          changes: [
            { kind: "add_sheet", name: "MustNotAppear" },
            {
              kind: "write_cells",
              sheetName: "Data",
              startCell: "A1",
              values: [[{ kind: "blank" }]],
            },
          ],
        },
        "invalid_argument",
      ],
      [
        "edit_workbook",
        {
          source: { ...original.version, versionId: "0".repeat(64) },
          changes: [{ kind: "add_sheet", name: "No" }],
        },
        "file_changed",
      ],
      [
        "edit_workbook",
        {
          source: original.version,
          changes: [
            {
              kind: "write_cells",
              sheetName: "Missing",
              startCell: "A1",
              values: [[{ kind: "blank" }]],
            },
          ],
        },
        "unknown_sheet",
      ],
    ] as const) {
      const result = await preparedCall(client, { name, arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(payload(result)).toMatchObject({ error });
      expect((await readdir(join(directory, "out"))).length).toBe(1);
    }
  });
});

it("preserves opaque source parts instead of silently dropping them", async () => {
  await workspace(async (directory, client) => {
    const original = mutationReceiptSchema.parse(
      payload(
        await preparedCall(client, {
          name: "create_workbook",
          arguments: { sheets: [{ name: "Data" }] },
        }),
      ),
    );
    const zip = await JSZip.loadAsync(
      await readFile(join(directory, original.version.filePath)),
    );
    zip.file("custom/important.xml", "<important>retain me</important>");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(join(directory, "external.xlsx"), bytes);
    const result = await preparedCall(client, {
      name: "edit_workbook",
      arguments: {
        source: {
          filePath: "external.xlsx",
          versionId: createHash("sha256").update(bytes).digest("hex"),
        },
        changes: [{ kind: "add_sheet", name: "No" }],
      },
    });
    expect(result.isError).not.toBe(true);
    const receipt = mutationReceiptSchema.parse(payload(result));
    const output = await JSZip.loadAsync(
      await readFile(join(directory, receipt.version.filePath)),
    );
    expect(await output.file("custom/important.xml")?.async("string")).toBe(
      "<important>retain me</important>",
    );
    expect(await readFile(join(directory, "external.xlsx"))).toEqual(bytes);
    expect((await readdir(join(directory, "out"))).length).toBe(2);
  });
});

it("shares admission across all writing tools and honors cancellation before publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "excel-admission-"));
  try {
    await mkdir(join(directory, "out"));
    const root = await createWorkbookRoot(directory);
    const handlers = createWritingHandlers(
      root,
      await createWorkbookOutput(root, "out"),
      createResultStore(),
    );
    const args = writingToolDefinitions.create_workbook.inputSchema.parse({
      sheets: [{ name: "S" }],
    });
    const first = handlers.create_workbook(args);
    const second = await handlers.create_workbook_version({
      filePath: "not-read.xlsx",
    });
    expect(payload(second)).toMatchObject({ error: "resource_limit" });
    expect((await first).isError).not.toBe(true);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await handlers.create_workbook(args, {
      signal: controller.signal,
    });
    expect(payload(cancelled)).toMatchObject({ error: "invalid_argument" });
    expect((await readdir(join(directory, "out"))).length).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
import { preparedCall } from "./fixtures/prepared-call.js";
