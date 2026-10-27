import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import * as XLSX from "@e965/xlsx";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  createWorkbookOutput,
  mutationReceiptSchema,
  versionReceiptSchema,
} from "../src/platform/versions.js";
import { createExcelMcpServer } from "../src/server.js";
import { bulkGroupReceiptSchema } from "../src/tools/bulk-job-schemas.js";

function payload(result: { content: readonly unknown[] }): unknown {
  const first = result.content[0];
  if (
    first === null ||
    typeof first !== "object" ||
    !("text" in first) ||
    typeof first.text !== "string"
  )
    throw new Error("Missing JSON tool result");
  return JSON.parse(first.text);
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(payload(response))).not.toBe(true);
  return payload(response);
}

async function workspace(
  run: (directory: string, client: Client) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "excel-expert-"));
  await mkdir(join(directory, "out"));
  const root = await createWorkbookRoot(directory);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({ name: "expert-contract", version: "1" });
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

async function create(client: Client, changes: readonly unknown[] = []) {
  return mutationReceiptSchema.parse(
    await call(client, "create_workbook", {
      sheets: [
        { name: "Sales '26", blocks: [] },
        { name: "Summary", blocks: [] },
      ],
      changes,
    }),
  );
}

async function bytes(
  directory: string,
  receipt: Pick<ReturnType<typeof versionReceiptSchema.parse>, "version">,
) {
  return readFile(join(directory, receipt.version.filePath));
}

describe("Phase 7 authoring through MCP", () => {
  it("embeds a bounded real JPEG with matching bytes and placement", async () => {
    await workspace(async (directory, client) => {
      const jpeg =
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z";
      const source = await create(client, [
        {
          kind: "set_image",
          sheetName: "Summary",
          name: "Pixel",
          cell: "C4",
          mime: "image/jpeg",
          data: jpeg,
          width: 32,
          height: 16,
        },
      ]);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(
        Uint8Array.from(await bytes(directory, source)).buffer,
      );
      expect(book.model.media).toHaveLength(1);
      expect(book.model.media?.[0]?.extension).toBe("jpeg");
      expect(book.model.media?.[0]?.buffer).toEqual(
        Buffer.from(jpeg, "base64"),
      );
      expect(book.getWorksheet("Summary")?.getImages()).toEqual([
        expect.objectContaining({
          range: expect.objectContaining({
            tl: expect.objectContaining({ nativeCol: 2, nativeRow: 3 }),
            ext: { width: 32, height: 16 },
          }),
        }),
      ]);
    });
  });
  it.each([
    {
      name: "corrupt PNG checksum",
      change: {
        kind: "set_image",
        sheetName: "Summary",
        name: "Bad",
        cell: "A1",
        mime: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXs8AAAAASUVORK5CYII=",
        width: 1,
        height: 1,
      },
      message: "checksum",
    },
    {
      name: "external link scheme",
      change: {
        kind: "set_hyperlink",
        sheetName: "Summary",
        cell: "A1",
        target: { kind: "external", url: "http://example.com" },
      },
      message: "HTTPS",
    },
    {
      name: "chart point limit",
      change: {
        kind: "set_chart",
        sheetName: "Summary",
        name: "Large",
        chartType: "line",
        cell: "D1",
        series: [
          {
            name: "Series",
            sheetName: "Summary",
            categories: "A1:A10001",
            values: "B1:B10001",
          },
        ],
      },
      message: "10,000",
    },
    {
      name: "validation application limit",
      change: {
        kind: "set_validation",
        sheetName: "Summary",
        range: "A1:A1000001",
        rule: { type: "list", items: ["One"] },
      },
      message: "1,000,000",
    },
    {
      name: "pivot source limit",
      change: {
        kind: "set_pivot",
        sheetName: "Summary",
        name: "Large",
        cell: "H1",
        sourceSheet: "Sales '26",
        sourceRange: "A1:D25001",
        rowColumn: "Region",
        measures: [{ column: "Amount", function: "sum", name: "Total" }],
      },
      message: "100,000",
    },
  ])(
    "refuses $name after prior changes without publishing anything",
    async ({ change, message }) => {
      await workspace(async (directory, client) => {
        const source = await create(client);
        const before = await bytes(directory, source),
          files = await readdir(join(directory, "out"));
        const result = await client.callTool({
          name: "edit_workbook",
          arguments: {
            source: source.version,
            changes: [
              {
                kind: "define_name",
                sheetName: "Summary",
                name: "Transient",
                range: "A1",
              },
              change,
            ],
          },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(payload(result))).toContain(message);
        expect((await bytes(directory, source)).equals(before)).toBe(true);
        expect(await readdir(join(directory, "out"))).toEqual(files);
      });
    },
  );

  it("invalidates only affected chart caches and marks a changed pivot source stale", async () => {
    await workspace(async (directory, client) => {
      const initial = await create(client, [
        {
          kind: "define_name",
          sheetName: "Sales '26",
          name: "Dataset",
          range: "A1:B3",
        },
        {
          kind: "write_named_range",
          sheetName: "Summary",
          name: "Dataset",
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
          ],
        },
        {
          kind: "set_pivot",
          sheetName: "Summary",
          name: "Regions",
          cell: "A1",
          sourceSheet: "Sales '26",
          sourceRange: "A1:B3",
          rowColumn: "Region",
          measures: [{ column: "Amount", function: "sum", name: "Total" }],
        },
        {
          kind: "set_chart",
          sheetName: "Summary",
          name: "Sales",
          chartType: "column",
          cell: "D1",
          series: [
            {
              name: "Revenue",
              sheetName: "Sales '26",
              categories: "A2:A3",
              values: "B2:B3",
            },
          ],
        },
      ]);
      const composed = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: initial.version,
          changes: [
            {
              kind: "write_formula",
              sheetName: "Summary",
              cell: "B8",
              formula: "SUM('Sales ''26'!B2:B3)",
            },
            {
              kind: "set_note",
              sheetName: "Summary",
              cell: "A9",
              text: "Retain with drawings",
              author: "Finance",
            },
            {
              kind: "set_image",
              sheetName: "Summary",
              name: "Logo",
              cell: "H1",
              mime: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
              width: 24,
              height: 24,
            },
          ],
        }),
      );
      const source = versionReceiptSchema
        .passthrough()
        .parse(
          await call(client, "calculate_workbook", {
            source: composed.version,
          }),
        );
      const sourceBytes = await bytes(directory, source);
      expect(
        XLSX.read(sourceBytes, { type: "buffer" }).Sheets.Summary?.B8,
      ).toMatchObject({ t: "n", v: 30 });
      const unrelated = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              kind: "write_cells",
              sheetName: "Summary",
              startCell: "Z1",
              values: [[{ kind: "number", value: 99 }]],
            },
          ],
        }),
      );
      const retained = await JSZip.loadAsync(await bytes(directory, unrelated));
      expect(
        await retained.file("xl/charts/chart1.xml")?.async("string"),
      ).toContain("<c:numCache>");
      expect(unrelated.editing?.refreshRequired).not.toContain("charts");
      const changed = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              kind: "write_cells",
              sheetName: "Sales '26",
              startCell: "B2",
              values: [[{ kind: "number", value: 45 }]],
              overwrite: true,
            },
          ],
        }),
      );
      const stale = await JSZip.loadAsync(await bytes(directory, changed));
      expect(
        await stale.file("xl/charts/chart1.xml")?.async("string"),
      ).not.toContain("<c:numCache>");
      expect(
        await stale
          .file("xl/pivotCache/pivotCacheDefinition1.xml")
          ?.async("string"),
      ).toContain('invalid="1"');
      expect(changed.editing?.refreshRequired).toEqual(
        expect.arrayContaining(["charts", "pivots"]),
      );
      expect(changed.editing?.recalculationRequired).toBe(true);
      const refreshed = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: changed.version,
          changes: [
            {
              kind: "set_pivot",
              sheetName: "Summary",
              name: "Regions",
              cell: "A1",
              sourceSheet: "Sales '26",
              sourceRange: "A1:B3",
              rowColumn: "Region",
              measures: [{ column: "Amount", function: "sum", name: "Total" }],
              overwrite: true,
            },
            {
              kind: "set_chart",
              sheetName: "Summary",
              name: "Sales",
              chartType: "column",
              cell: "D1",
              series: [
                {
                  name: "Revenue",
                  sheetName: "Sales '26",
                  categories: "A2:A3",
                  values: "B2:B3",
                },
              ],
              overwrite: true,
            },
          ],
        }),
      );
      expect(refreshed.editing?.refreshRequired ?? []).not.toContain("charts");
      expect(refreshed.editing?.refreshRequired ?? []).not.toContain("pivots");
      const recalculated = versionReceiptSchema
        .passthrough()
        .parse(
          await call(client, "calculate_workbook", {
            source: refreshed.version,
          }),
        );
      const current = await JSZip.loadAsync(
        await bytes(directory, recalculated),
      );
      expect(
        await current.file("xl/charts/chart1.xml")?.async("string"),
      ).toContain('<c:pt idx="0"><c:v>45</c:v></c:pt>');
      expect(
        await current
          .file("xl/pivotCache/pivotCacheDefinition1.xml")
          ?.async("string"),
      ).not.toContain('invalid="1"');
      const values = XLSX.read(await bytes(directory, recalculated), {
        type: "buffer",
      }).Sheets.Summary;
      expect(values?.B2).toMatchObject({ t: "n", v: 45 });
      expect(values?.B3).toMatchObject({ t: "n", v: 20 });
      expect(values?.B4).toMatchObject({ t: "n", v: 65 });
      expect(values?.B8).toMatchObject({ t: "n", v: 65 });
      const chartRemoved = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: recalculated.version,
          changes: [
            { kind: "remove_chart", sheetName: "Summary", name: "Sales" },
          ],
        }),
      );
      const withoutChart = await JSZip.loadAsync(
        await bytes(directory, chartRemoved),
      );
      expect(
        Object.keys(withoutChart.files).filter((path) =>
          /^xl\/charts\/[^/]+\.xml$/.test(path),
        ),
      ).toHaveLength(0);
      const withImage = new ExcelJS.Workbook();
      await withImage.xlsx.load(
        Uint8Array.from(await bytes(directory, chartRemoved)).buffer,
      );
      expect(withImage.model.media).toHaveLength(1);
      const note = await current.file("xl/comments1.xml")?.async("string");
      expect(note).toContain('ref="A9"');
      expect(note).toContain("Retain with drawings");
      expect(
        await withoutChart.file("xl/comments1.xml")?.async("string"),
      ).toEqual(note);
      const imageRemoved = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: chartRemoved.version,
          changes: [
            { kind: "remove_image", sheetName: "Summary", name: "Logo" },
          ],
        }),
      );
      const noMedia = new ExcelJS.Workbook();
      await noMedia.xlsx.load(
        Uint8Array.from(await bytes(directory, imageRemoved)).buffer,
      );
      expect(noMedia.model.media).toHaveLength(0);
      const withoutImage = await JSZip.loadAsync(
        await bytes(directory, imageRemoved),
      );
      expect(
        await withoutImage.file("xl/comments1.xml")?.async("string"),
      ).toEqual(note);
      expect(
        XLSX.read(await bytes(directory, imageRemoved), { type: "buffer" })
          .Sheets.Summary?.B8,
      ).toMatchObject({ t: "n", v: 65 });
      expect((await bytes(directory, source)).equals(sourceBytes)).toBe(true);
    });
  });
  it("replays one completed period job without duplicates and rolls back a failed expert finishing step", async () => {
    await workspace(async (directory, client) => {
      const initial = mutationReceiptSchema.parse(
        await call(client, "create_workbook", {
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
                      { kind: "text", value: "West" },
                      { kind: "number", value: 40 },
                    ],
                  ],
                },
              ],
            },
            { name: "Report", blocks: [] },
          ],
          changes: [
            {
              kind: "define_name",
              sheetName: "Report",
              name: "Period",
              range: "D1",
            },
            {
              kind: "set_note",
              sheetName: "Report",
              cell: "D1",
              text: "Template note",
            },
            {
              kind: "set_pivot",
              sheetName: "Report",
              name: "Regional",
              cell: "A3",
              sourceSheet: "Data",
              sourceRange: "A1:B4",
              rowColumn: "Region",
              measures: [{ column: "Amount", function: "sum", name: "Total" }],
            },
          ],
        }),
      );
      const incoming = mutationReceiptSchema.parse(
        await call(client, "create_workbook", {
          sheets: [
            {
              name: "Incoming",
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
                      { kind: "number", value: 30 },
                    ],
                  ],
                },
              ],
            },
          ],
        }),
      );
      const group = {
        steps: [
          {
            kind: "read",
            id: "old",
            source: initial.version,
            selection: {
              kind: "records",
              sheetName: "Data",
              range: "A1:B4",
              headerRow: 1,
            },
          },
          {
            kind: "read",
            id: "fresh",
            source: incoming.version,
            selection: {
              kind: "records",
              sheetName: "Incoming",
              range: "A1:B2",
              headerRow: 1,
            },
          },
        ],
        outputs: [
          {
            kind: "edit",
            id: "report",
            target: "old",
            input: "fresh",
            mode: "replace_values",
            overwrite: true,
          },
        ],
      };
      const changes = [
        {
          kind: "write_named_range",
          sheetName: "Report",
          name: "Period",
          values: [[{ kind: "text", value: "2026-11" }]],
        },
        {
          kind: "set_pivot",
          sheetName: "Report",
          name: "Regional",
          cell: "A3",
          sourceSheet: "Data",
          sourceRange: "A1:B2",
          rowColumn: "Region",
          measures: [{ column: "Amount", function: "sum", name: "Total" }],
          overwrite: true,
        },
      ];
      const job = {
        kind: "dependent",
        group,
        finish: [{ output: "report", changes }],
      };
      const result = bulkGroupReceiptSchema.parse(
        await call(client, "run_bulk_job", { job }),
      );
      expect(await call(client, "run_bulk_job", { job })).toEqual(result);
      const version = result.outputs[0]?.version;
      if (version === undefined) throw new Error("Missing report output");
      const book = XLSX.read(
        await readFile(join(directory, version.filePath)),
        { type: "buffer", sheetStubs: true },
      );
      expect(book.Sheets.Data?.A3?.v).toBeUndefined();
      expect(book.Sheets.Data?.A4?.v).toBeUndefined();
      expect(book.Sheets.Report?.D1?.v).toBe("2026-11");
      expect(book.Sheets.Report?.D1?.c?.[0]?.t).toBe("Template note");
      expect(book.Sheets.Report?.B4?.v).toBe(30);
      expect(book.Sheets.Report?.A6?.v).toBeUndefined();
      const before = (await readdir(join(directory, "out"))).filter((name) =>
        name.startsWith("job-"),
      );
      const failed = await client.callTool({
        name: "run_bulk_job",
        arguments: {
          job: {
            kind: "dependent",
            group,
            finish: [
              {
                output: "report",
                changes: [
                  ...changes,
                  {
                    kind: "set_pivot",
                    sheetName: "Report",
                    name: "Bad",
                    cell: "D3",
                    sourceSheet: "Data",
                    sourceRange: "A1:B2",
                    rowColumn: "Missing",
                    measures: [
                      { column: "Amount", function: "sum", name: "Total" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(payload(failed))).toContain("does not exist");
      expect(
        (await readdir(join(directory, "out"))).filter((name) =>
          name.startsWith("job-"),
        ),
      ).toEqual(before);
    });
  });
  it("protects locked/unlocked cells and workbook structure, and requires authenticated explicit removal before continuation", async () => {
    await workspace(async (directory, client) => {
      const source = await create(client, [
        {
          kind: "format_cells",
          sheetName: "Summary",
          range: "A1",
          style: { protection: { locked: false } },
        },
        {
          kind: "protect_sheet",
          sheetName: "Summary",
          password: "secret",
          selectLocked: false,
        },
        { kind: "protect_workbook", sheetName: "Summary", password: "secret" },
      ]);
      const zip = await JSZip.loadAsync(await bytes(directory, source));
      expect(await zip.file("xl/workbook.xml")?.async("string")).toContain(
        'workbookPassword="DAA7"',
      );
      expect(
        await zip.file("xl/worksheets/sheet2.xml")?.async("string"),
      ).toContain('password="DAA7"');
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(
        Uint8Array.from(await bytes(directory, source)).buffer,
      );
      expect(
        book.getWorksheet("Summary")?.getCell("A1").protection,
      ).toMatchObject({ locked: false });
      const before = await bytes(directory, source),
        files = await readdir(join(directory, "out"));
      const denied = await client.callTool({
        name: "edit_workbook",
        arguments: {
          source: source.version,
          changes: [
            {
              kind: "unprotect_workbook",
              sheetName: "Summary",
              password: "wrong",
            },
            {
              kind: "unprotect_sheet",
              sheetName: "Summary",
              password: "secret",
            },
          ],
        },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(payload(denied))).toContain(
        "password does not match",
      );
      expect(await readdir(join(directory, "out"))).toEqual(files);
      const next = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              kind: "unprotect_workbook",
              sheetName: "Summary",
              password: "secret",
            },
            {
              kind: "unprotect_sheet",
              sheetName: "Summary",
              password: "secret",
            },
            {
              kind: "write_cells",
              sheetName: "Summary",
              startCell: "A1",
              values: [[{ kind: "number", value: 42 }]],
            },
          ],
        }),
      );
      expect(
        XLSX.read(await bytes(directory, next), { type: "buffer" }).Sheets
          .Summary?.A1?.v,
      ).toBe(42);
      expect((await bytes(directory, source)).equals(before)).toBe(true);
    });
  });
  it("creates a real pivot cache and results, then refreshes a shorter source without an old output tail", async () => {
    await workspace(async (directory, client) => {
      const measures = [
        { column: "Amount", function: "sum", name: "Total" },
        { column: "Amount", function: "count", name: "Entries" },
        { column: "Amount", function: "min", name: "Minimum" },
        { column: "Amount", function: "max", name: "Maximum" },
      ];
      const source = await create(client, [
        {
          kind: "define_name",
          sheetName: "Sales '26",
          name: "Dataset",
          range: "A1:B4",
        },
        {
          kind: "write_named_range",
          sheetName: "Sales '26",
          name: "Dataset",
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
        {
          kind: "set_pivot",
          sheetName: "Summary",
          name: "Regional",
          cell: "A1",
          sourceSheet: "Sales '26",
          sourceRange: "A1:B4",
          rowColumn: "Region",
          measures,
        },
      ]);
      const book = XLSX.read(await bytes(directory, source), {
        type: "buffer",
      });
      expect(
        XLSX.utils.sheet_to_json(book.Sheets.Summary ?? {}, { header: 1 }),
      ).toEqual([
        ["Region", "Total", "Entries", "Minimum", "Maximum"],
        ["North", 15, 2, 5, 10],
        ["South", 20, 1, 20, 20],
        ["Grand Total", 35, 3, 5, 20],
      ]);
      const zip = await JSZip.loadAsync(await bytes(directory, source));
      expect(
        await zip.file("xl/pivotTables/pivotTable1.xml")?.async("string"),
      ).toContain('name="Regional"');
      expect(
        await zip.file("xl/pivotCache/pivotCacheRecords1.xml")?.async("string"),
      ).toContain('count="3"');
      const next = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              kind: "write_cells",
              sheetName: "Sales '26",
              startCell: "B2",
              values: [[{ kind: "number", value: 30 }]],
              overwrite: true,
            },
            {
              kind: "set_pivot",
              sheetName: "Summary",
              name: "Regional",
              cell: "A1",
              sourceSheet: "Sales '26",
              sourceRange: "A1:B2",
              rowColumn: "Region",
              measures,
              overwrite: true,
            },
          ],
        }),
      );
      const refreshed = XLSX.read(await bytes(directory, next), {
        type: "buffer",
      });
      expect(
        XLSX.utils.sheet_to_json(refreshed.Sheets.Summary ?? {}, {
          header: 1,
          blankrows: false,
        }),
      ).toEqual([
        ["Region", "Total", "Entries", "Minimum", "Maximum"],
        ["North", 30, 1, 30, 30],
        ["Grand Total", 30, 1, 30, 30],
      ]);
      expect(refreshed.Sheets.Summary?.A4?.v).toBeUndefined();
    });
  });
  it.each(["column", "bar", "line", "pie"])(
    "creates a real %s chart and replaces/removes its anchored object",
    async (chartType) => {
      await workspace(async (directory, client) => {
        const series = [
          {
            name: "Revenue",
            sheetName: "Summary",
            categories: "A1:A2",
            values: "B1:B2",
          },
        ];
        const source = await create(client, [
          {
            kind: "define_name",
            sheetName: "Summary",
            name: "Inputs",
            range: "A1:B2",
          },
          {
            kind: "write_named_range",
            sheetName: "Summary",
            name: "Inputs",
            values: [
              [
                { kind: "text", value: "Oct" },
                { kind: "number", value: 20 },
              ],
              [
                { kind: "text", value: "Nov" },
                { kind: "number", value: 35 },
              ],
            ],
          },
          {
            kind: "set_chart",
            sheetName: "Summary",
            name: "Sales",
            chartType,
            cell: "D2",
            title: "Monthly sales",
            series,
          },
        ]);
        const zip = await JSZip.loadAsync(await bytes(directory, source));
        const chart = await zip.file("xl/charts/chart1.xml")?.async("string");
        expect(chart).toContain("Monthly sales");
        expect(chart).toContain('<a:srgbClr val="4472C4"/>');
        expect(chart).toContain("&apos;Summary&apos;!$B$1:$B$2");
        expect(chart).toContain('<c:pt idx="1"><c:v>35</c:v></c:pt>');
        const read = await call(client, "get_charts", {
          filePath: source.version.filePath,
          sheetName: "Summary",
        });
        expect(JSON.stringify(read)).toContain("Monthly sales");
        const replaced = mutationReceiptSchema.parse(
          await call(client, "edit_workbook", {
            source: source.version,
            changes: [
              {
                kind: "set_chart",
                sheetName: "Summary",
                name: "Sales",
                chartType,
                cell: "E3",
                title: "Updated title",
                series,
                overwrite: true,
              },
            ],
          }),
        );
        expect(
          JSON.stringify(
            await call(client, "get_charts", {
              filePath: replaced.version.filePath,
              sheetName: "Summary",
            }),
          ),
        ).toContain("Updated title");
        const removed = mutationReceiptSchema.parse(
          await call(client, "edit_workbook", {
            source: replaced.version,
            changes: [
              { kind: "remove_chart", sheetName: "Summary", name: "Sales" },
            ],
          }),
        );
        expect(
          JSON.stringify(
            await call(client, "get_charts", {
              filePath: removed.version.filePath,
              sheetName: "Summary",
            }),
          ),
        ).not.toContain("Updated title");
      });
    },
  );
  it("reopens hyperlinks, legacy notes and embedded image bytes and supports explicit replacement/removal", async () => {
    await workspace(async (directory, client) => {
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
      const source = await create(client, [
        {
          kind: "set_hyperlink",
          sheetName: "Summary",
          cell: "A1",
          target: { kind: "external", url: "https://example.com/invoice" },
          tooltip: "Invoice",
        },
        {
          kind: "set_note",
          sheetName: "Summary",
          cell: "B2",
          text: "Reviewed <&_x0041_",
          author: "Finance",
        },
        {
          kind: "set_image",
          sheetName: "Summary",
          name: "Logo",
          cell: "D3",
          data: png,
          mime: "image/png",
          width: 96,
          height: 48,
        },
      ]);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(
        Uint8Array.from(await bytes(directory, source)).buffer,
      );
      const sheet = book.getWorksheet("Summary");
      expect(sheet?.getCell("A1").hyperlink).toBe(
        "https://example.com/invoice",
      );
      const notes = XLSX.read(await bytes(directory, source), {
        type: "buffer",
        sheetStubs: true,
      });
      expect(notes.Sheets.Summary?.B2?.c).toEqual([
        expect.objectContaining({ t: "Reviewed <&_x0041_", a: "Finance" }),
      ]);
      const media = book.model.media;
      expect(media).toHaveLength(1);
      expect(media?.[0]?.buffer).toEqual(Buffer.from(png, "base64"));
      expect(sheet?.getImages()).toEqual([
        expect.objectContaining({
          range: expect.objectContaining({
            tl: expect.objectContaining({ nativeCol: 3, nativeRow: 2 }),
            ext: { width: 96, height: 48 },
          }),
        }),
      ]);
      const edited = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              kind: "set_note",
              sheetName: "Summary",
              cell: "B2",
              text: "Updated",
              overwrite: true,
            },
            {
              kind: "set_hyperlink",
              sheetName: "Summary",
              cell: "A1",
              target: { kind: "internal", location: "'Summary'!B2" },
              overwrite: true,
            },
            {
              kind: "set_image",
              sheetName: "Summary",
              name: "Logo",
              cell: "E4",
              data: png,
              mime: "image/png",
              width: 24,
              height: 24,
              overwrite: true,
            },
          ],
        }),
      );
      const next = new ExcelJS.Workbook();
      await next.xlsx.load(
        Uint8Array.from(await bytes(directory, edited)).buffer,
      );
      expect(
        XLSX.read(await bytes(directory, edited), {
          type: "buffer",
          sheetStubs: true,
        }).Sheets.Summary?.B2?.c,
      ).toEqual([expect.objectContaining({ t: "Updated" })]);
      expect(next.getWorksheet("Summary")?.getImages()).toHaveLength(1);
      const removed = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: edited.version,
          changes: [
            { kind: "remove_note", sheetName: "Summary", cell: "B2" },
            { kind: "remove_hyperlink", sheetName: "Summary", cell: "A1" },
            { kind: "remove_image", sheetName: "Summary", name: "Logo" },
          ],
        }),
      );
      const final = new ExcelJS.Workbook();
      await final.xlsx.load(
        Uint8Array.from(await bytes(directory, removed)).buffer,
      );
      expect(final.getWorksheet("Summary")?.getCell("B2").note).toBeUndefined();
      expect(
        final.getWorksheet("Summary")?.getCell("A1").hyperlink,
      ).toBeUndefined();
      expect(final.getWorksheet("Summary")?.getImages()).toHaveLength(0);
      const packageView = await JSZip.loadAsync(
        await bytes(directory, removed),
      );
      expect(
        Object.keys(packageView.files).filter((part) =>
          part.startsWith("xl/media/"),
        ),
      ).toHaveLength(0);
    });
  });
  it("reopens validation and conditional rules with their formulas, styles, priorities and shifted ranges", async () => {
    await workspace(async (directory, client) => {
      const source = await create(client, [
        {
          kind: "set_validation",
          sheetName: "Summary",
          range: "A2:A5",
          rule: { type: "list", items: ["Open", "Closed"] },
          allowBlank: true,
          promptTitle: "Status",
          prompt: "Select a status",
        },
        {
          kind: "set_validation",
          sheetName: "Summary",
          range: "B2:B5",
          rule: { type: "whole", operator: "between", bounds: [0, 100] },
        },
        {
          kind: "set_conditional_format",
          sheetName: "Summary",
          range: "B2:B5",
          priority: 2,
          rule: { type: "cellIs", operator: "greaterThan", formulas: ["50"] },
          appearance: { fill: "FF0000", font: { bold: true } },
          stopIfTrue: true,
        },
        {
          kind: "set_conditional_format",
          sheetName: "Summary",
          range: "B2:B5",
          priority: 1,
          rule: { type: "expression", formula: "B2<0" },
          appearance: { font: { color: "0000FF" } },
        },
      ]);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(
        Uint8Array.from(await bytes(directory, source)).buffer,
      );
      expect(
        book.getWorksheet("Summary")?.getCell("A2").dataValidation,
      ).toMatchObject({
        type: "list",
        formulae: ['"Open,Closed"'],
        allowBlank: true,
        promptTitle: "Status",
      });
      expect(
        book.getWorksheet("Summary")?.getCell("B5").dataValidation,
      ).toMatchObject({
        type: "whole",
        operator: "between",
        formulae: [0, 100],
      });
      const sheet = book.getWorksheet("Summary");
      expect(sheet?.model).toMatchObject({
        conditionalFormattings: expect.arrayContaining([
          expect.objectContaining({
            ref: "B2:B5",
            rules: [
              expect.objectContaining({
                type: "cellIs",
                priority: 2,
                formulae: ["50"],
                style: expect.objectContaining({
                  font: expect.objectContaining({ bold: true }),
                  fill: expect.objectContaining({
                    fgColor: { argb: "FFFF0000" },
                  }),
                }),
              }),
            ],
          }),
        ]),
      });
      const packageView = await JSZip.loadAsync(await bytes(directory, source));
      expect(
        await packageView.file("xl/worksheets/sheet2.xml")?.async("string"),
      ).toMatch(/priority="2"[^>]*stopIfTrue="1"/);
      const edited = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            { kind: "insert_rows", sheetName: "Summary", at: 1, count: 1 },
            {
              kind: "set_validation",
              sheetName: "Summary",
              range: "A3:A6",
              rule: { type: "custom", formula: "LEN(A3)>0" },
              overwrite: true,
            },
            { kind: "remove_validation", sheetName: "Summary", range: "B3:B6" },
            {
              kind: "remove_conditional_format",
              sheetName: "Summary",
              priority: 2,
            },
            {
              kind: "set_conditional_format",
              sheetName: "Summary",
              range: "D3:D6",
              priority: 1,
              rule: { type: "expression", formula: "D3>10" },
              appearance: { fill: "00FF00" },
              overwrite: true,
            },
          ],
        }),
      );
      const next = new ExcelJS.Workbook();
      await next.xlsx.load(
        Uint8Array.from(await bytes(directory, edited)).buffer,
      );
      expect(
        next.getWorksheet("Summary")?.getCell("A3").dataValidation,
      ).toMatchObject({ type: "custom", formulae: ["LEN(A3)>0"] });
      expect(
        next.getWorksheet("Summary")?.getCell("B3").dataValidation,
      ).toBeUndefined();
      expect(next.getWorksheet("Summary")?.model).toMatchObject({
        conditionalFormattings: [
          expect.objectContaining({
            ref: "D3:D6",
            rules: [
              expect.objectContaining({ priority: 1, formulae: ["D3>10"] }),
            ],
          }),
        ],
      });
    });
  });

  it.each([
    {
      name: "partial validation overlap",
      change: {
        kind: "set_validation",
        sheetName: "Summary",
        range: "A3:A7",
        rule: { type: "list", items: ["New"] },
        overwrite: true,
      },
      message: "exactly select",
    },
    {
      name: "oversized inline list",
      change: {
        kind: "set_validation",
        sheetName: "Summary",
        range: "B2",
        rule: { type: "list", items: ["A".repeat(254)] },
      },
      message: "255",
    },
    {
      name: "incorrect numeric bounds",
      change: {
        kind: "set_validation",
        sheetName: "Summary",
        range: "B2",
        rule: { type: "whole", operator: "between", bounds: [2] },
      },
      message: "bounds",
    },
    {
      name: "duplicate rule priority",
      change: {
        kind: "set_conditional_format",
        sheetName: "Summary",
        range: "B2",
        priority: 1,
        rule: { type: "expression", formula: "B2>0" },
        appearance: { fill: "00FF00" },
      },
      message: "overwrite",
    },
  ])(
    "refuses $name and retains the whole source",
    async ({ change, message }) => {
      await workspace(async (directory, client) => {
        const source = await create(client, [
          {
            kind: "set_validation",
            sheetName: "Summary",
            range: "A2:A5",
            rule: { type: "list", items: ["Old"] },
          },
          {
            kind: "set_conditional_format",
            sheetName: "Summary",
            range: "A2:A5",
            priority: 1,
            rule: { type: "expression", formula: "A2=1" },
            appearance: { fill: "FF0000" },
          },
        ]);
        const before = await bytes(directory, source),
          files = await readdir(join(directory, "out"));
        const response = await client.callTool({
          name: "edit_workbook",
          arguments: { source: source.version, changes: [change] },
        });
        expect(response.isError).toBe(true);
        expect(JSON.stringify(payload(response))).toContain(message);
        expect((await bytes(directory, source)).equals(before)).toBe(true);
        expect(await readdir(join(directory, "out"))).toEqual(files);
      });
    },
  );
  it("fills scoped static names with exact typed rectangles and calculates dependent formulas", async () => {
    await workspace(async (directory, client) => {
      const report = await create(client, [
        {
          kind: "define_name",
          sheetName: "Sales '26",
          name: "SalesData",
          range: "A1:B2",
        },
        {
          kind: "define_name",
          sheetName: "Summary",
          name: "SalesData",
          scope: "sheet",
          range: "D1",
        },
        {
          kind: "write_named_range",
          sheetName: "Summary",
          name: "SalesData",
          values: [
            [
              { kind: "text", value: "=literal" },
              { kind: "number", value: 20 },
            ],
            [
              { kind: "boolean", value: true },
              { kind: "number", value: 30 },
            ],
          ],
        },
        {
          kind: "write_named_range",
          sheetName: "Summary",
          name: "SalesData",
          scope: "sheet",
          values: [[{ kind: "number", value: 7 }]],
        },
        {
          kind: "write_formula",
          sheetName: "Summary",
          cell: "A1",
          formula: "SUM(SalesData)",
        },
        {
          kind: "write_formula",
          sheetName: "Sales '26",
          cell: "D1",
          formula: "SUM(SalesData)",
        },
      ]);
      const original = await bytes(directory, report);
      const book = XLSX.read(original, { type: "buffer", cellFormula: true });
      expect(book.Workbook?.Names).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Name: "SalesData",
            Ref: "'Sales ''26'!$A$1:$B$2",
          }),
          expect.objectContaining({
            Name: "SalesData",
            Sheet: 1,
            Ref: "'Summary'!$D$1:$D$1",
          }),
        ]),
      );
      expect(book.Sheets["Sales '26"]?.A1).toMatchObject({
        t: "s",
        v: "=literal",
      });
      expect(book.Sheets["Sales '26"]?.A2).toMatchObject({ t: "b", v: true });
      expect(book.Sheets.Summary?.D1).toMatchObject({ t: "n", v: 7 });
      const calculated = await call(client, "calculate_workbook", {
        source: report.version,
      });
      expect(calculated).toHaveProperty("version");
      const parsed = versionReceiptSchema.passthrough().parse(calculated);
      const evaluated = XLSX.read(await bytes(directory, parsed), {
        type: "buffer",
      });
      expect(evaluated.Sheets.Summary?.A1).toMatchObject({ t: "n", v: 7 });
      expect(evaluated.Sheets["Sales '26"]?.D1).toMatchObject({
        t: "n",
        v: 50,
      });
      expect((await bytes(directory, report)).equals(original)).toBe(true);
    });
  });

  it("updates named targets across sheet rename and inserted rows while retaining the source", async () => {
    await workspace(async (directory, client) => {
      const source = await create(client, [
        {
          kind: "define_name",
          sheetName: "Sales '26",
          name: "Period",
          range: "B2",
        },
      ]);
      const hash = createHash("sha256")
        .update(await bytes(directory, source))
        .digest("hex");
      const edited = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              kind: "rename_sheet",
              sheetName: "Sales '26",
              name: "Next Period",
            },
            { kind: "insert_rows", sheetName: "Next Period", at: 1, count: 2 },
            {
              kind: "write_named_range",
              sheetName: "Summary",
              name: "Period",
              values: [[{ kind: "text", value: "November" }]],
            },
          ],
        }),
      );
      const book = XLSX.read(await bytes(directory, edited), {
        type: "buffer",
      });
      expect(book.Workbook?.Names).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Name: "Period",
            Ref: "'Next Period'!$B$4:$B$4",
          }),
        ]),
      );
      expect(book.Sheets["Next Period"]?.B4).toMatchObject({
        v: "November",
        t: "s",
      });
      expect(
        createHash("sha256")
          .update(await bytes(directory, source))
          .digest("hex"),
      ).toBe(hash);
    });
  });

  it("requires explicit name and value replacement and removes only the selected scope", async () => {
    await workspace(async (directory, client) => {
      const source = await create(client, [
        {
          kind: "define_name",
          sheetName: "Summary",
          name: "Period",
          range: "A1",
        },
        {
          kind: "define_name",
          sheetName: "Summary",
          name: "Period",
          scope: "sheet",
          range: "B1",
        },
      ]);
      const edited = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              kind: "define_name",
              sheetName: "Summary",
              name: "period",
              range: "C1",
              overwrite: true,
            },
            {
              kind: "write_named_range",
              sheetName: "Summary",
              name: "Period",
              values: [[{ kind: "number", value: 4 }]],
            },
            {
              kind: "write_named_range",
              sheetName: "Summary",
              name: "Period",
              values: [[{ kind: "number", value: 9 }]],
              overwrite: true,
            },
            {
              kind: "delete_name",
              sheetName: "Summary",
              name: "Period",
              scope: "sheet",
            },
          ],
        }),
      );
      const book = XLSX.read(await bytes(directory, edited), {
        type: "buffer",
      });
      expect(book.Workbook?.Names).toHaveLength(1);
      expect(book.Workbook?.Names?.[0]).toMatchObject({
        Name: "period",
        Ref: "'Summary'!$C$1:$C$1",
      });
      expect(book.Sheets.Summary?.C1).toMatchObject({ t: "n", v: 9 });
    });
  });

  it.each([
    {
      name: "cell collision",
      changes: [
        {
          kind: "define_name",
          sheetName: "Summary",
          name: "XFD1048576",
          range: "A1",
        },
      ],
      message: "cell reference",
    },
    {
      name: "reserved name",
      changes: [
        { kind: "define_name", sheetName: "Summary", name: "R", range: "A1" },
      ],
      message: "reserved",
    },
    {
      name: "duplicate name",
      changes: [
        {
          kind: "define_name",
          sheetName: "Summary",
          name: "Period",
          range: "A2",
        },
      ],
      message: "overwrite",
    },
    {
      name: "incorrect rectangle",
      changes: [
        {
          kind: "write_named_range",
          sheetName: "Summary",
          name: "Period",
          values: [
            [
              { kind: "number", value: 1 },
              { kind: "number", value: 2 },
            ],
          ],
        },
      ],
      message: "rectangle",
    },
    {
      name: "occupied target",
      changes: [
        {
          kind: "write_named_range",
          sheetName: "Summary",
          name: "Period",
          values: [[{ kind: "number", value: 1 }]],
        },
      ],
      message: "overwrite",
    },
    {
      name: "referenced deletion",
      changes: [{ kind: "delete_name", sheetName: "Summary", name: "Period" }],
      message: "still referenced",
    },
  ])(
    "refuses $name without publishing a partial version",
    async ({ changes, message }) => {
      await workspace(async (directory, client) => {
        const source = await create(client, [
          {
            kind: "define_name",
            sheetName: "Summary",
            name: "Period",
            range: "A1",
          },
          {
            kind: "write_named_range",
            sheetName: "Summary",
            name: "Period",
            values: [[{ kind: "number", value: 7 }]],
          },
          {
            kind: "write_formula",
            sheetName: "Summary",
            cell: "B1",
            formula: "Period*2",
          },
        ]);
        const before = await readdir(join(directory, "out"));
        const original = await bytes(directory, source);
        const response = await client.callTool({
          name: "edit_workbook",
          arguments: {
            source: source.version,
            changes: [
              {
                kind: "format_cells",
                sheetName: "Summary",
                range: "D1",
                style: { fill: "FF0000" },
              },
              ...changes,
            ],
          },
        });
        expect(response.isError).toBe(true);
        expect(JSON.stringify(payload(response))).toContain(message);
        expect(await readdir(join(directory, "out"))).toEqual(before);
        expect(await bytes(directory, source)).toEqual(original);
        const zip = await JSZip.loadAsync(original);
        expect(await zip.file("xl/workbook.xml")?.async("string")).toContain(
          "Period",
        );
      });
    },
  );
});
