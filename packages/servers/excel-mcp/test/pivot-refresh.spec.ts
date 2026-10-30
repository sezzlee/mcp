import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import * as XLSX from "@e965/xlsx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  createWorkbookOutput,
  mutationReceiptSchema,
} from "../src/platform/versions.js";
import { createExcelMcpServer } from "../src/server.js";

function payload(result: { content: readonly unknown[] }): unknown {
  const first = result.content[0];
  if (
    first === null ||
    typeof first !== "object" ||
    !("text" in first) ||
    typeof first.text !== "string"
  )
    throw new Error("Missing JSON tool result.");
  return JSON.parse(first.text);
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await preparedCall(client, { name, arguments: args });
  expect(response.isError, JSON.stringify(payload(response))).not.toBe(true);
  return mutationReceiptSchema.parse(payload(response));
}

const pivot = {
  kind: "set_pivot",
  sheetName: "Data",
  name: "ReportPivot",
  cell: "E1",
  sourceSheet: "Data",
  sourceRange: "A1:B3",
  rowColumn: "Group",
  measures: [{ column: "Amount", function: "sum", name: "Total" }],
};

async function workspace(
  run: (
    directory: string,
    client: Client,
    source: ReturnType<typeof mutationReceiptSchema.parse>,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "excel-pivot-refresh-"));
  await mkdir(join(directory, "out"));
  const root = await createWorkbookRoot(directory);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({ name: "pivot-refresh-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const source = await call(client, "create_workbook", {
      sheets: [
        {
          name: "Data",
          blocks: [
            {
              startCell: "A1",
              values: [
                [
                  { kind: "text", value: "Group" },
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
          ],
        },
        {
          name: "Other",
          blocks: [
            {
              startCell: "E1",
              values: [
                [
                  { kind: "text", value: "Group" },
                  { kind: "text", value: "Total" },
                ],
                [
                  { kind: "text", value: "North" },
                  { kind: "number", value: 7 },
                ],
              ],
            },
          ],
        },
      ],
      changes: [pivot],
    });
    await run(directory, client, source);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("pivot replacement source preservation", () => {
  it.each([
    { sourceRange: "E1:F4", column: "Total", function: "sum" },
    { sourceRange: "E1:E4", column: "Group", function: "count" },
  ])(
    "atomically refuses clearing a prior output that overlaps the new source $sourceRange",
    async ({ sourceRange, column, function: aggregate }) => {
      await workspace(async (directory, client, source) => {
        const sourcePath = join(directory, source.version.filePath);
        const before = await readFile(sourcePath);
        const files = (await readdir(join(directory, "out"))).sort();
        const response = await preparedCall(client, {
          name: "edit_workbook",
          arguments: {
            source: source.version,
            changes: [
              {
                kind: "write_cells",
                sheetName: "Data",
                startCell: "L1",
                values: [[{ kind: "text", value: "Not published" }]],
              },
              {
                ...pivot,
                cell: "H1",
                sourceRange,
                measures: [{ column, function: aggregate, name: "Result" }],
                overwrite: true,
              },
            ],
          },
        });
        expect(response.isError).toBe(true);
        expect(JSON.stringify(payload(response))).toContain(
          "Clearing the previous pivot output would overlap its source.",
        );
        expect(await readFile(sourcePath)).toEqual(before);
        expect((await readdir(join(directory, "out"))).sort()).toEqual(files);
      });
    },
  );

  it.each([
    { sourceSheet: "Data", sourceRange: "A1:B2", column: "Amount", total: 10 },
    { sourceSheet: "Other", sourceRange: "E1:F2", column: "Total", total: 7 },
  ])(
    "refreshes a shorter source on $sourceSheet while clearing the complete old output",
    async ({ sourceSheet, sourceRange, column, total }) => {
      await workspace(async (directory, client, source) => {
        const sourcePath = join(directory, source.version.filePath);
        const before = await readFile(sourcePath);
        const result = await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              ...pivot,
              cell: "H1",
              sourceSheet,
              sourceRange,
              measures: [{ column, function: "sum", name: "Total" }],
              overwrite: true,
            },
          ],
        });
        const output = await readFile(join(directory, result.version.filePath));
        const saved = XLSX.read(output, { type: "buffer" });
        const data = saved.Sheets["Data"];
        expect(
          ["H1", "I1", "H2", "I2", "H3", "I3"].map((cell) => data?.[cell]?.v),
        ).toEqual(["Group", "Total", "North", total, "Grand Total", total]);
        for (const cell of ["E1", "F1", "E2", "F2", "E3", "F3", "E4", "F4"])
          expect(data?.[cell]?.v, cell).toBeUndefined();
        expect(saved.Sheets["Other"]?.["F2"]?.v).toBe(7);
        expect(data?.["B2"]?.v).toBe(10);
        const zip = await JSZip.loadAsync(output);
        const caches = Object.keys(zip.files).filter((name) =>
          /^xl\/pivotCache\/pivotCacheDefinition[0-9]+\.xml$/.test(name),
        );
        expect(caches).toHaveLength(1);
        const cache = await zip.file(caches[0] ?? "")?.async("string");
        expect(cache).toContain('recordCount="1"');
        expect(cache).toContain(`ref="${sourceRange}"`);
        expect(cache).toContain(`sheet="${sourceSheet}"`);
        expect(cache).toContain('refreshOnLoad="0"');
        expect(await readFile(sourcePath)).toEqual(before);
      });
    },
  );
});
import { preparedCall } from "./fixtures/prepared-call.js";
