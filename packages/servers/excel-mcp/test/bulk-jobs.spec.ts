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
import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createWorkbookOutput } from "../src/platform/versions.js";
import { createExcelMcpServer } from "../src/server.js";
import {
  bulkGroupReceiptSchema,
  bulkBatchReceiptSchema,
} from "../src/tools/bulk-job-schemas.js";
import { z } from "zod";

const rows = [
  ["a", "pending", 10, "A"],
  ["b", "done", 20, "B"],
  ["c", "pending", 30, "C"],
  ["d", "hold", 40, "D"],
];
async function book(
  directory: string,
  name: string,
  values: unknown[][],
  options: { outside?: boolean; table?: boolean; formula?: boolean } = {},
): Promise<void> {
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet("S");
  if (options.table)
    sheet.addTable({
      name: "Orders",
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      columns: [
        { name: "Id" },
        { name: "Status" },
        { name: "Amount" },
        { name: "Note" },
      ],
      rows: values,
    });
  else {
    sheet.addRow(["Id", "Status", "Amount", "Note"]);
    for (const row of values) sheet.addRow(row);
  }
  sheet.getCell("C2").numFmt = "#,##0.00";
  sheet.getCell("C2").font = { bold: true };
  if (options.outside) sheet.getCell("F2").value = "neighbor";
  if (options.formula)
    sheet.getCell("D3").value = { formula: "C3*2", result: 40 };
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  zip.file(
    "customXml/retained.xml",
    '<retained xmlns="urn:test">opaque</retained>',
  );
  await writeFile(
    join(directory, name),
    await zip.generateAsync({ type: "nodebuffer" }),
  );
}
async function connected(
  directory: string,
  run: (client: Client) => Promise<void>,
  mode: "read" | "write" = "write",
  outputDirectory = "out",
) {
  const root = await createWorkbookRoot(directory),
    server =
      mode === "read"
        ? createExcelMcpServer(root)
        : createExcelMcpServer(root, {
            mode: "write",
            output: await createWorkbookOutput(root, outputDirectory),
          });
  const client = new Client({ name: "bulk-job-acceptance", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}
async function workspace(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "excel-bulk-job-"));
  try {
    await mkdir(join(directory, "out"));
    await book(directory, "orders.xlsx", rows);
    await run(directory);
  } finally {
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
    throw new Error("Expected JSON tool output");
  return JSON.parse(first.text);
}
async function readStep(
  directory: string,
  id = "orders",
  filePath = "orders.xlsx",
  range = "A1:D5",
) {
  const bytes = await readFile(join(directory, filePath));
  return {
    kind: "read",
    id,
    source: {
      filePath,
      versionId: createHash("sha256").update(bytes).digest("hex"),
    },
    selection: { kind: "records", sheetName: "S", range, headerRow: 1 },
  };
}
async function invoke(client: Client, group: unknown, tool = "run_bulk_job") {
  return preparedCall(client, {
    name: tool,
    arguments: { job: { kind: "dependent", group } },
  });
}
async function values(directory: string, filePath: string) {
  const workbook = XLSX.read(await readFile(join(directory, filePath)), {
    type: "buffer",
    cellDates: true,
  });
  const sheet = workbook.Sheets["S"];
  if (sheet === undefined) throw new Error("Missing output sheet");
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
  });
}
function newOutput(input: string) {
  return { id: "report", kind: "new", sheets: [{ name: "S", input }] };
}

it("returns bounded batch summaries with retrievable full output inventories", async () => {
  await workspace(async (directory) => {
    const outputDirectory = "outputs-" + "x".repeat(140);
    await mkdir(join(directory, outputDirectory));
    const source = await readStep(directory);
    const jobs = Array.from({ length: 16 }, (_, i) => {
      const steps: unknown[] = [source];
      let input = "orders";
      for (let n = 0; n < 8; n++) {
        const id = `n${n}`;
        steps.push({
          kind: "update",
          id,
          input,
          set: [
            { column: "Status", value: { kind: "text", value: `batch${i}` } },
          ],
        });
        input = id;
      }
      return {
        id: `batch${i}`,
        group: {
          steps,
          outputs: Array.from({ length: 16 }, (_, n) => ({
            ...newOutput(input),
            id: `out${n}`,
          })),
        },
      };
    });
    await connected(
      directory,
      async (client) => {
        const response = await preparedCall(client, {
          name: "run_bulk_job",
          arguments: { job: { kind: "independent", jobs } },
        });
        expect(response.isError, JSON.stringify(payload(response))).not.toBe(
          true,
        );
        const result = bulkBatchReceiptSchema.parse(payload(response));
        expect(result.kind).toBe("complete");
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
          128 * 1024,
        );
        expect(result.jobs).toHaveLength(16);
        for (const child of result.jobs)
          expect(child).toMatchObject({
            kind: "complete",
            details: "summary",
            outputCount: 16,
            stepCount: 9,
          });
        const child = result.jobs[0];
        if (child === undefined || child.kind !== "complete")
          throw new Error("Missing completed child");
        const full = bulkGroupReceiptSchema.parse(
          payload(
            await preparedCall(client, {
              name: "get_bulk_job",
              arguments: { jobId: child.result.jobId },
            }),
          ),
        );
        expect(full.outputs).toHaveLength(16);
        expect(full.steps).toHaveLength(9);
        const first = full.outputs[0];
        if (first === undefined) throw new Error("Missing detailed output");
        expect((await values(directory, first.version.filePath))[1]).toEqual([
          "a",
          "batch0",
          10,
          "A",
        ]);
      },
      "write",
      outputDirectory,
    );
  });
});

it("refuses a truncated completion inventory even when its retained files still exist", async () => {
  await workspace(async (directory) =>
    connected(directory, async (client) => {
      const group = {
        steps: [await readStep(directory)],
        outputs: [
          newOutput("orders"),
          { ...newOutput("orders"), id: "second" },
        ],
      };
      const result = bulkGroupReceiptSchema.parse(
          payload(await invoke(client, group)),
        ),
        path = join(directory, "out", `job-${result.jobId}`, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.result.outputs.pop();
      await writeFile(path, JSON.stringify(manifest));
      const response = await preparedCall(client, {
        name: "get_bulk_job",
        arguments: { jobId: result.jobId },
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({
        error: "file_changed",
        message: expect.stringContaining("inventory"),
      });
    }),
  );
});
function editOutput(input: string, mode = "changed_values") {
  return {
    id: "report",
    kind: "edit",
    target: "orders",
    input,
    mode,
    overwrite: true,
  };
}

it("prepares, atomically commits and independently reads conditional updates while preserving sources, formulas and styles", async () => {
  await workspace(async (directory) => {
    await book(directory, "orders.xlsx", rows, {
      outside: true,
      formula: true,
    });
    const original = await readFile(join(directory, "orders.xlsx"));
    await connected(directory, async (client) => {
      const group = {
        steps: [
          await readStep(directory),
          {
            kind: "update",
            id: "updated",
            input: "orders",
            where: [{ column: "Status", op: "eq", value: "pending" }],
            set: [{ column: "Amount", value: { kind: "number", value: 99 } }],
          },
        ],
        outputs: [editOutput("updated")],
      };
      expect(
        payload(await invoke(client, group, "prepare_bulk_job")),
      ).toMatchObject({ kind: "ready", executionAvailable: true });
      expect(await readdir(join(directory, "out"))).toEqual([]);
      const response = await invoke(client, group);
      expect(response.isError).not.toBe(true);
      const receipt = bulkGroupReceiptSchema.parse(payload(response));
      expect(receipt.steps[1]).toMatchObject({
        counts: { matched: 2, updated: 2, unchanged: 0, unmatched: 2 },
      });
      const output = receipt.outputs[0];
      if (output === undefined) throw new Error("Missing output");
      const workbook = XLSX.read(
        await readFile(join(directory, output.version.filePath)),
        { type: "buffer", cellStyles: true },
      );
      expect(workbook.Sheets.S?.C2?.v).toBe(99);
      expect(workbook.Sheets.S?.C3?.v).toBe(20);
      expect(workbook.Sheets.S?.C4?.v).toBe(99);
      expect(workbook.Sheets.S?.D3?.f).toBe("C3*2");
      expect(workbook.Sheets.S?.F2?.v).toBe("neighbor");
      expect(workbook.Sheets.S?.C2?.z).toBe("#,##0.00");
      const inputZip = await JSZip.loadAsync(original),
        outputZip = await JSZip.loadAsync(
          await readFile(join(directory, output.version.filePath)),
        );
      expect(
        await outputZip.file("customXml/retained.xml")?.async("string"),
      ).toBe(await inputZip.file("customXml/retained.xml")?.async("string"));
      expect(await readFile(join(directory, "orders.xlsx"))).toEqual(original);
      expect(payload(await invoke(client, group))).toEqual(receipt);
      expect(
        payload(
          await preparedCall(client, {
            name: "get_bulk_job",
            arguments: { jobId: receipt.jobId },
          }),
        ),
      ).toEqual(receipt);
    });
  });
});

it("dependent late failure publishes no workbook or completion directory", async () => {
  await workspace(async (directory) =>
    connected(directory, async (client) => {
      const group = {
        steps: [await readStep(directory)],
        outputs: [newOutput("orders"), { ...newOutput("missing"), id: "bad" }],
      };
      expect(
        payload(await invoke(client, group, "prepare_bulk_job")),
      ).toMatchObject({ kind: "blocked" });
      const result = await invoke(client, group);
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ error: "invalid_argument" });
      expect(await readdir(join(directory, "out"))).toEqual([]);
    }),
  );
});

it("recovers a committed result after restart and original-source changes, and refuses a corrupt retained output", async () => {
  await workspace(async (directory) => {
    const group = {
      steps: [await readStep(directory)],
      outputs: [newOutput("orders")],
    };
    let retained: ReturnType<typeof bulkGroupReceiptSchema.parse> | undefined;
    await connected(directory, async (client) => {
      retained = bulkGroupReceiptSchema.parse(
        payload(await invoke(client, group)),
      );
    });
    await writeFile(
      join(directory, "orders.xlsx"),
      "changed after committed response",
    );
    await connected(directory, async (client) => {
      const replay = bulkGroupReceiptSchema.parse(
        payload(await invoke(client, group)),
      );
      expect(replay).toEqual(retained);
      const output = replay.outputs[0];
      if (output === undefined) throw new Error("Missing output");
      await writeFile(join(directory, output.version.filePath), "tampered");
      const response = await preparedCall(client, {
        name: "get_bulk_job",
        arguments: { jobId: replay.jobId },
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({ error: "file_changed" });
    });
  });
});

it("returns nine independent reports, retains failure, and retries only the missing report across restart", async () => {
  await workspace(async (directory) => {
    const source = await readStep(directory);
    const jobs = Array.from({ length: 10 }, (_, i) => ({
      id: `report${i}`,
      group: {
        steps: [
          i === 7
            ? {
                ...source,
                source: { ...source.source, filePath: "missing.xlsx" },
              }
            : source,
          {
            kind: "transform",
            id: "numbered",
            input: "orders",
            transformations: [
              {
                kind: "constant",
                column: "Batch",
                value: { kind: "number", value: i },
              },
            ],
          },
        ],
        outputs: [newOutput("numbered")],
      },
    }));
    const job = { kind: "independent", jobs };
    let first: ReturnType<typeof bulkBatchReceiptSchema.parse> | undefined;
    await connected(directory, async (client) => {
      first = bulkBatchReceiptSchema.parse(
        payload(
          await preparedCall(client, {
            name: "run_bulk_job",
            arguments: { job },
          }),
        ),
      );
      expect(first.kind).toBe("partial");
      expect(
        first.jobs.filter((child) => child.kind === "complete"),
      ).toHaveLength(9);
      expect(first.jobs[7]).toMatchObject({
        kind: "failed",
        failure: {
          error: "file_not_found",
          observation: "current_attempt",
          diagnosticRetained: true,
        },
      });
      const status = bulkBatchReceiptSchema.parse(
        payload(
          await preparedCall(client, {
            name: "get_bulk_job",
            arguments: { jobId: first.jobId },
          }),
        ),
      );
      expect(status.kind).toBe("partial");
      expect(status.jobs[7]).toMatchObject({
        kind: "failed",
        failure: {
          error: "file_not_found",
          observation: "first_failed_attempt",
          diagnosticRetained: true,
        },
      });
      for (const [i, child] of status.jobs.entries())
        if (i !== 7) expect(child).toEqual(first?.jobs[i]);
    });
    const bytes = await readFile(join(directory, "orders.xlsx"));
    await writeFile(join(directory, "missing.xlsx"), bytes);
    await writeFile(
      join(directory, "orders.xlsx"),
      "original is now unavailable",
    );
    await connected(directory, async (client) => {
      const retry = bulkBatchReceiptSchema.parse(
        payload(
          await preparedCall(client, {
            name: "run_bulk_job",
            arguments: { job },
          }),
        ),
      );
      expect(retry.kind).toBe("complete");
      expect(
        retry.jobs.filter((child) => child.kind === "complete"),
      ).toHaveLength(10);
      for (const [i, child] of retry.jobs.entries())
        if (i !== 7) expect(child).toEqual(first?.jobs[i]);
    });
  });
});

it.each(["clear", "delete_rows"])(
  "removes matched records with explicit %s semantics",
  async (mode) => {
    await workspace(async (directory) =>
      connected(directory, async (client) => {
        const group = {
          steps: [
            await readStep(directory),
            {
              kind: "remove",
              id: "removed",
              input: "orders",
              mode,
              where: [{ column: "Status", op: "eq", value: "pending" }],
            },
          ],
          outputs: [editOutput("removed")],
        };
        const response = await invoke(client, group);
        expect(response.isError, JSON.stringify(payload(response))).not.toBe(
          true,
        );
        const receipt = bulkGroupReceiptSchema.parse(payload(response)),
          output = receipt.outputs[0];
        if (output === undefined) throw new Error("Missing output");
        const data = await values(directory, output.version.filePath);
        expect(data).toEqual(
          mode === "clear"
            ? [
                ["Id", "Status", "Amount", "Note"],
                [null, null, null, null],
                ["b", "done", 20, "B"],
                [null, null, null, null],
                ["d", "hold", 40, "D"],
              ]
            : [
                ["Id", "Status", "Amount", "Note"],
                ["b", "done", 20, "B"],
                ["d", "hold", 40, "D"],
              ],
        );
      }),
    );
  },
);

it("refuses physical deletion of neighboring content and leaves every source unchanged", async () => {
  await workspace(async (directory) => {
    await book(directory, "orders.xlsx", rows, { outside: true });
    const before = await readFile(join(directory, "orders.xlsx"));
    await connected(directory, async (client) => {
      const response = await invoke(client, {
        steps: [
          await readStep(directory),
          {
            kind: "remove",
            id: "removed",
            input: "orders",
            mode: "delete_rows",
            where: [{ column: "Id", op: "eq", value: "a" }],
          },
        ],
        outputs: [editOutput("removed")],
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({
        error: "invalid_argument",
        message: expect.stringContaining("outside"),
      });
      expect(await readdir(join(directory, "out"))).toEqual([]);
      expect(await readFile(join(directory, "orders.xlsx"))).toEqual(before);
    });
  });
});

it.each(["keyed_update", "upsert"])(
  "executes %s with explicit key mappings and exact record counts",
  async (kind) => {
    await workspace(async (directory) => {
      await book(directory, "changes.xlsx", [
        ["b", "done", 25, "B"],
        ["e", "new", 50, "E"],
      ]);
      await connected(directory, async (client) => {
        const group = {
          steps: [
            await readStep(directory),
            await readStep(directory, "changes", "changes.xlsx", "A1:D3"),
            {
              kind,
              id: "merged",
              source: "changes",
              target: "orders",
              keys: [{ sourceColumn: "Id", targetColumn: "Id" }],
              set: [
                { sourceColumn: "Status", targetColumn: "Status" },
                { sourceColumn: "Amount", targetColumn: "Amount" },
                { sourceColumn: "Note", targetColumn: "Note" },
              ],
            },
          ],
          outputs: [editOutput("merged")],
        };
        const response = await invoke(client, group);
        expect(response.isError).not.toBe(true);
        const receipt = bulkGroupReceiptSchema.parse(payload(response));
        expect(receipt.steps[2]).toMatchObject({
          counts: {
            matched: 1,
            updated: 1,
            unchanged: 0,
            sourceUnmatched: 1,
            targetUnmatched: 3,
            inserted: kind === "upsert" ? 1 : 0,
          },
        });
        const output = receipt.outputs[0];
        if (output === undefined) throw new Error("Missing output");
        expect(await values(directory, output.version.filePath)).toEqual([
          ["Id", "Status", "Amount", "Note"],
          ["a", "pending", 10, "A"],
          ["b", "done", 25, "B"],
          ["c", "pending", 30, "C"],
          ["d", "hold", 40, "D"],
          ...(kind === "upsert" ? [["e", "new", 50, "E"]] : []),
        ]);
      });
    });
  },
);

it.each([false, true])(
  "replaces a 100-record list with 80 records and clears the old tail; table=%s",
  async (table) => {
    await workspace(async (directory) => {
      await book(
        directory,
        "orders.xlsx",
        Array.from({ length: 100 }, (_, i) => [`id${i}`, "old", i, "old"]),
        { table },
      );
      await book(
        directory,
        "replacement.xlsx",
        Array.from({ length: 80 }, (_, i) => [
          `new${i}`,
          "new",
          1000 + i,
          "new",
        ]),
      );
      await connected(directory, async (client) => {
        const target = await readStep(
          directory,
          "orders",
          "orders.xlsx",
          "A1:D101",
        );
        const source = await readStep(
          directory,
          "replacement",
          "replacement.xlsx",
          "A1:D81",
        );
        const group = {
          steps: [
            table
              ? {
                  ...target,
                  selection: {
                    kind: "records",
                    sheetName: "S",
                    table: "orders",
                    headerRow: 1,
                  },
                }
              : target,
            source,
            {
              kind: "replace",
              id: "replaced",
              target: "orders",
              source: "replacement",
            },
          ],
          outputs: [editOutput("replaced", "replace_values")],
        };
        const response = await invoke(client, group);
        expect(response.isError, JSON.stringify(payload(response))).not.toBe(
          true,
        );
        const receipt = bulkGroupReceiptSchema.parse(payload(response)),
          output = receipt.outputs[0];
        if (output === undefined) throw new Error("Missing output");
        const data = await values(directory, output.version.filePath);
        expect(data.slice(0, 81)).toEqual([
          ["Id", "Status", "Amount", "Note"],
          ...Array.from({ length: 80 }, (_, i) => [
            `new${i}`,
            "new",
            1000 + i,
            "new",
          ]),
        ]);
        expect(
          data
            .slice(81)
            .every(
              (row) => Array.isArray(row) && row.every((cell) => cell === null),
            ),
        ).toBe(true);
        const zip = await JSZip.loadAsync(
          await readFile(join(directory, output.version.filePath)),
        );
        expect(
          await zip.file("xl/worksheets/sheet1.xml")?.async("string"),
        ).not.toContain("id99");
        if (table) {
          const xml = await zip.file("xl/tables/table1.xml")?.async("string");
          expect(xml).toContain('ref="A1:D81"');
        }
      });
    });
  },
);

it.each(["inner", "left", "full"])(
  "joins typed records with explicit %s semantics and projected columns",
  async (joinKind) => {
    await workspace(async (directory) => {
      await book(directory, "right.xlsx", [
        ["b", "paid", 200, "R"],
        ["z", "extra", 900, "Z"],
      ]);
      await connected(directory, async (client) => {
        const group = {
          steps: [
            await readStep(directory),
            await readStep(directory, "right", "right.xlsx", "A1:D3"),
            {
              kind: "join",
              id: "joined",
              left: "orders",
              right: "right",
              join: joinKind,
              keys: [{ sourceColumn: "Id", targetColumn: "Id" }],
              columns: [
                { side: "left", column: "Id", as: "LeftId" },
                { side: "right", column: "Id", as: "RightId" },
                { side: "right", column: "Amount", as: "Amount" },
              ],
            },
          ],
          outputs: [newOutput("joined")],
        };
        const response = await invoke(client, group);
        expect(response.isError).not.toBe(true);
        const receipt = bulkGroupReceiptSchema.parse(payload(response)),
          output = receipt.outputs[0];
        if (output === undefined) throw new Error("Missing output");
        expect(await values(directory, output.version.filePath)).toEqual([
          ["LeftId", "RightId", "Amount"],
          ...(joinKind === "inner"
            ? [["b", "b", 200]]
            : [
                ["a", null, null],
                ["b", "b", 200],
                ["c", null, null],
                ["d", null, null],
              ]),
          ...(joinKind === "full" ? [[null, "z", 900]] : []),
        ]);
      });
    });
  },
);

it("appends, filters, stably sorts, deduplicates, projects and transforms a complete pipeline", async () => {
  await workspace(async (directory) =>
    connected(directory, async (client) => {
      const group = {
        steps: [
          await readStep(directory),
          {
            kind: "append",
            id: "appended",
            inputs: ["orders", "orders"],
            columns: ["Id", "Status", "Amount", "Note"],
          },
          {
            kind: "filter",
            id: "filtered",
            input: "appended",
            where: [{ column: "Amount", op: "gte", value: 20 }],
          },
          {
            kind: "deduplicate",
            id: "unique",
            input: "filtered",
            keys: ["Id"],
            keep: "last",
          },
          {
            kind: "sort",
            id: "sorted",
            input: "unique",
            by: [{ column: "Amount", direction: "desc", blanks: "last" }],
          },
          {
            kind: "project",
            id: "projected",
            input: "sorted",
            columns: [
              { column: "Id", as: "Code" },
              { column: "Status", as: "State" },
            ],
          },
          {
            kind: "transform",
            id: "transformed",
            input: "projected",
            transformations: [
              {
                kind: "case",
                column: "State",
                direction: "upper",
                locale: "en",
              },
              {
                kind: "constant",
                column: "Source",
                value: { kind: "text", value: "report" },
              },
            ],
          },
        ],
        outputs: [newOutput("transformed")],
      };
      const response = await invoke(client, group);
      expect(response.isError).not.toBe(true);
      const receipt = bulkGroupReceiptSchema.parse(payload(response)),
        output = receipt.outputs[0];
      if (output === undefined) throw new Error("Missing output");
      expect(await values(directory, output.version.filePath)).toEqual([
        ["Code", "State", "Source"],
        ["d", "HOLD", "report"],
        ["c", "PENDING", "report"],
        ["b", "DONE", "report"],
      ]);
      expect(receipt.steps[3]).toMatchObject({
        counts: { duplicateGroups: 3, duplicateRecords: 3, removed: 3 },
      });
    }),
  );
});

it.each(["error", "first", "last"])(
  "requires explicit duplicate resolution and supports %s",
  async (duplicates) => {
    await workspace(async (directory) => {
      await book(directory, "changes.xlsx", [
        ["b", "first", 1, "F"],
        ["b", "last", 2, "L"],
      ]);
      await connected(directory, async (client) => {
        const group = {
          steps: [
            await readStep(directory),
            await readStep(directory, "changes", "changes.xlsx", "A1:D3"),
            {
              kind: "keyed_update",
              id: "merged",
              source: "changes",
              target: "orders",
              duplicates,
              keys: [{ sourceColumn: "Id", targetColumn: "Id" }],
              set: [{ sourceColumn: "Status", targetColumn: "Status" }],
            },
          ],
          outputs: [editOutput("merged")],
        };
        const response = await invoke(client, group);
        if (duplicates === "error") {
          expect(response.isError).toBe(true);
          expect(payload(response)).toMatchObject({
            error: "invalid_argument",
            message: expect.stringContaining("Duplicate"),
          });
          expect(await readdir(join(directory, "out"))).toEqual([]);
        } else {
          const receipt = bulkGroupReceiptSchema.parse(payload(response)),
            output = receipt.outputs[0];
          if (output === undefined) throw new Error("Missing output");
          expect((await values(directory, output.version.filePath))[2]).toEqual(
            ["b", duplicates, 20, "B"],
          );
        }
      });
    });
  },
);

it("keeps typed and case-sensitive key identity through executable updates", async () => {
  await workspace(async (directory) => {
    await book(directory, "orders.xlsx", [
      ["0012", "old", 0, ""],
      [12, "old", 0, ""],
      ["12", "old", 0, ""],
      ["abc", "old", 0, ""],
      ["ABC", "old", 0, ""],
      [false, "old", 0, ""],
      [0, "old", 0, ""],
    ]);
    await book(directory, "changes.xlsx", [
      [12, "numeric", 99, ""],
      ["abc", "lower", 222, ""],
    ]);
    await connected(directory, async (client) => {
      const group = {
        steps: [
          await readStep(directory, "orders", "orders.xlsx", "A1:D8"),
          await readStep(directory, "changes", "changes.xlsx", "A1:D3"),
          {
            kind: "keyed_update",
            id: "result",
            source: "changes",
            target: "orders",
            keys: [{ sourceColumn: "Id", targetColumn: "Id" }],
            set: [{ sourceColumn: "Status", targetColumn: "Status" }],
          },
        ],
        outputs: [editOutput("result")],
      };
      const response = await invoke(client, group),
        result = bulkGroupReceiptSchema.parse(payload(response)),
        output = result.outputs[0];
      if (output === undefined) throw new Error("Missing output");
      expect(result.steps[2]).toMatchObject({
        counts: { matched: 2, updated: 2, targetUnmatched: 5 },
      });
      expect(
        (await values(directory, output.version.filePath))
          .slice(1)
          .map((row) => (Array.isArray(row) ? row.slice(0, 2) : row)),
      ).toEqual([
        ["0012", "old"],
        [12, "numeric"],
        ["12", "old"],
        ["abc", "lower"],
        ["ABC", "old"],
        [false, "old"],
        [0, "old"],
      ]);
    });
  });
});

it("executes locale-aware trim/case and explicit number conversion without implicit coercion", async () => {
  await workspace(async (directory) => {
    await book(directory, "orders.xlsx", [
      ["a", "  ışık  ", "1.234,50", ""],
      ["b", "  izmir  ", "bad", ""],
    ]);
    await connected(directory, async (client) => {
      const group = {
        steps: [
          await readStep(directory, "orders", "orders.xlsx", "A1:D3"),
          {
            kind: "transform",
            id: "transformed",
            input: "orders",
            onError: "blank",
            transformations: [
              { kind: "trim", column: "Status" },
              {
                kind: "case",
                column: "Status",
                direction: "upper",
                locale: "tr",
              },
              {
                kind: "convert",
                spec: {
                  column: "Amount",
                  type: "number",
                  decimal: ",",
                  group: ".",
                },
              },
            ],
          },
        ],
        outputs: [newOutput("transformed")],
      };
      const response = await invoke(client, group);
      expect(response.isError).not.toBe(true);
      const result = bulkGroupReceiptSchema.parse(payload(response)),
        output = result.outputs[0];
      if (output === undefined) throw new Error("Missing output");
      expect(
        (await values(directory, output.version.filePath))
          .slice(1)
          .map((row) => (Array.isArray(row) ? row.slice(0, 3) : row)),
      ).toEqual([
        ["a", "IŞIK", 1234.5],
        ["b", "İZMİR", null],
      ]);
      expect(result.steps[1]).toMatchObject({
        counts: { changed: 2, conversionFailures: 1 },
      });
    });
  });
});

it("rejects conversion failures by default before publishing any dependent output", async () => {
  await workspace(async (directory) => {
    await book(directory, "orders.xlsx", [["a", "old", "bad", ""]]);
    await connected(directory, async (client) => {
      const response = await invoke(client, {
        steps: [
          await readStep(directory, "orders", "orders.xlsx", "A1:D2"),
          {
            kind: "transform",
            id: "converted",
            input: "orders",
            transformations: [
              {
                kind: "convert",
                spec: { column: "Amount", type: "number", decimal: "." },
              },
            ],
          },
        ],
        outputs: [
          newOutput("orders"),
          { ...newOutput("converted"), id: "converted" },
        ],
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({
        error: "invalid_argument",
        message: expect.stringContaining("transformation failed"),
      });
      expect(await readdir(join(directory, "out"))).toEqual([]);
    });
  });
});

it.each([false, true])(
  "requires an explicit many-to-many join; enabled=%s",
  async (manyToMany) => {
    await workspace(async (directory) => {
      await book(directory, "orders.xlsx", [
        ["a", "L1", 1, ""],
        ["a", "L2", 2, ""],
      ]);
      await book(directory, "right.xlsx", [
        ["a", "R1", 3, ""],
        ["a", "R2", 4, ""],
      ]);
      await connected(directory, async (client) => {
        const response = await invoke(client, {
          steps: [
            await readStep(directory, "orders", "orders.xlsx", "A1:D3"),
            await readStep(directory, "right", "right.xlsx", "A1:D3"),
            {
              kind: "join",
              id: "joined",
              left: "orders",
              right: "right",
              join: "inner",
              manyToMany,
              keys: [{ sourceColumn: "Id", targetColumn: "Id" }],
              columns: [
                { side: "left", column: "Status", as: "Left" },
                { side: "right", column: "Status", as: "Right" },
              ],
            },
          ],
          outputs: [newOutput("joined")],
        });
        if (!manyToMany) {
          expect(response.isError).toBe(true);
          expect(payload(response)).toMatchObject({
            error: "invalid_argument",
            message: expect.stringContaining("Duplicate"),
          });
          expect(await readdir(join(directory, "out"))).toEqual([]);
        } else {
          const result = bulkGroupReceiptSchema.parse(payload(response)),
            output = result.outputs[0];
          if (output === undefined) throw new Error("Missing output");
          expect(await values(directory, output.version.filePath)).toEqual([
            ["Left", "Right"],
            ["L1", "R1"],
            ["L1", "R2"],
            ["L2", "R1"],
            ["L2", "R2"],
          ]);
        }
      });
    });
  },
);

it("bounds many-to-many expansion before publication", async () => {
  await workspace(async (directory) => {
    const repeated = Array.from({ length: 320 }, (_, i) => [
      "a",
      "value",
      i,
      "",
    ]);
    await book(directory, "orders.xlsx", repeated);
    await book(directory, "right.xlsx", repeated);
    await connected(directory, async (client) => {
      const response = await invoke(client, {
        steps: [
          await readStep(directory, "orders", "orders.xlsx", "A1:D321"),
          await readStep(directory, "right", "right.xlsx", "A1:D321"),
          {
            kind: "join",
            id: "joined",
            left: "orders",
            right: "right",
            join: "inner",
            manyToMany: true,
            keys: [{ sourceColumn: "Id", targetColumn: "Id" }],
            columns: [
              { side: "left", column: "Amount", as: "Left" },
              { side: "right", column: "Amount", as: "Right" },
            ],
          },
        ],
        outputs: [newOutput("joined")],
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({
        error: "resource_limit",
        message: expect.stringContaining("Join expansion"),
      });
      expect(await readdir(join(directory, "out"))).toEqual([]);
    });
  });
});

it.each(["first", "last", "drop_all", "report"])(
  "deduplicates with the explicit %s rule",
  async (keep) => {
    await workspace(async (directory) => {
      await book(directory, "orders.xlsx", [
        ["a", "first", 1, ""],
        ["b", "unique", 2, ""],
        ["a", "last", 3, ""],
      ]);
      await connected(directory, async (client) => {
        const response = await invoke(client, {
          steps: [
            await readStep(directory, "orders", "orders.xlsx", "A1:D4"),
            {
              kind: "deduplicate",
              id: "dedup",
              input: "orders",
              keys: ["Id"],
              keep,
            },
          ],
          outputs: [newOutput("dedup")],
        });
        const result = bulkGroupReceiptSchema.parse(payload(response)),
          output = result.outputs[0];
        if (output === undefined) throw new Error("Missing output");
        const data = (await values(directory, output.version.filePath))
          .slice(1)
          .map((row) => (Array.isArray(row) ? row.slice(0, 2) : row));
        expect(data).toEqual(
          keep === "first"
            ? [
                ["a", "first"],
                ["b", "unique"],
              ]
            : keep === "last"
              ? [
                  ["b", "unique"],
                  ["a", "last"],
                ]
              : keep === "drop_all"
                ? [["b", "unique"]]
                : [
                    ["a", "first"],
                    ["b", "unique"],
                    ["a", "last"],
                  ],
        );
      });
    });
  },
);

it.each(["asc", "desc"])(
  "sorts ties stably with blanks last in %s order",
  async (direction) => {
    await workspace(async (directory) => {
      await book(directory, "orders.xlsx", [
        ["a", "x", 10, ""],
        ["b", "x", 10, ""],
        ["c", "x", null, ""],
        ["d", "x", 20, ""],
      ]);
      await connected(directory, async (client) => {
        const response = await invoke(client, {
          steps: [
            await readStep(directory),
            {
              kind: "sort",
              id: "sorted",
              input: "orders",
              by: [{ column: "Amount", direction, blanks: "last" }],
            },
          ],
          outputs: [newOutput("sorted")],
        });
        const result = bulkGroupReceiptSchema.parse(payload(response)),
          output = result.outputs[0];
        if (output === undefined) throw new Error("Missing output");
        expect(
          (await values(directory, output.version.filePath))
            .slice(1)
            .map((row) => (Array.isArray(row) ? row[0] : row)),
        ).toEqual(
          direction === "asc" ? ["a", "b", "d", "c"] : ["d", "a", "b", "c"],
        );
      });
    });
  },
);

it("refuses silent sorting through changed_values and stale source execution after a ready preparation", async () => {
  await workspace(async (directory) =>
    connected(directory, async (client) => {
      const read = await readStep(directory),
        group = {
          steps: [
            read,
            {
              kind: "sort",
              id: "sorted",
              input: "orders",
              by: [{ column: "Amount", direction: "desc", blanks: "last" }],
            },
          ],
          outputs: [editOutput("sorted")],
        };
      const response = await invoke(client, group);
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({
        error: "invalid_argument",
        message: expect.stringContaining("Reordering"),
      });
      expect(await readdir(join(directory, "out"))).toEqual([]);
      const safe = {
        ...group,
        outputs: [editOutput("sorted", "replace_values")],
      };
      expect(
        payload(await invoke(client, safe, "prepare_bulk_job")),
      ).toMatchObject({ kind: "ready" });
      await book(directory, "orders.xlsx", [["changed", "x", 1, ""]]);
      const stale = await invoke(client, safe);
      expect(stale.isError).toBe(true);
      expect(payload(stale)).toMatchObject({ error: "file_changed" });
      expect(await readdir(join(directory, "out"))).toEqual([]);
    }),
  );
});

it("combines edits on distinct sheets into one preserved immutable workbook", async () => {
  await workspace(async (directory) => {
    const workbook = new ExcelJS.Workbook();
    for (const name of ["S", "T"]) {
      const sheet = workbook.addWorksheet(name);
      sheet.addRow(["Id", "Status", "Amount", "Note"]);
      sheet.addRow([name, "pending", 10, "keep"]);
    }
    await writeFile(
      join(directory, "orders.xlsx"),
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    await connected(directory, async (client) => {
      const first = await readStep(directory, "orders", "orders.xlsx", "A1:D2"),
        second = {
          ...first,
          id: "second",
          selection: { ...first.selection, sheetName: "T" },
        };
      const response = await invoke(client, {
        steps: [
          first,
          second,
          {
            kind: "update",
            id: "a",
            input: "orders",
            set: [{ column: "Amount", value: { kind: "number", value: 99 } }],
          },
          {
            kind: "update",
            id: "b",
            input: "second",
            set: [{ column: "Amount", value: { kind: "number", value: 88 } }],
          },
        ],
        outputs: [
          {
            kind: "edit_workbook",
            id: "report",
            changes: [
              {
                target: "orders",
                input: "a",
                mode: "changed_values",
                overwrite: true,
              },
              {
                target: "second",
                input: "b",
                mode: "changed_values",
                overwrite: true,
              },
            ],
          },
        ],
      });
      expect(response.isError).not.toBe(true);
      const result = bulkGroupReceiptSchema.parse(payload(response)),
        output = result.outputs[0];
      if (output === undefined) throw new Error("Missing output");
      const loaded = XLSX.read(
        await readFile(join(directory, output.version.filePath)),
        { type: "buffer" },
      );
      expect(loaded.Sheets.S?.C2?.v).toBe(99);
      expect(loaded.Sheets.T?.C2?.v).toBe(88);
      expect(loaded.Sheets.S?.D2?.v).toBe("keep");
      expect(loaded.Sheets.T?.D2?.v).toBe("keep");
    });
  });
});

it("replaces a list with an empty dataset without retaining old records", async () => {
  await workspace(async (directory) =>
    connected(directory, async (client) => {
      const response = await invoke(client, {
        steps: [
          await readStep(directory),
          {
            kind: "filter",
            id: "empty",
            input: "orders",
            where: [{ column: "Amount", op: "gt", value: 999 }],
          },
          {
            kind: "replace",
            id: "replaced",
            target: "orders",
            source: "empty",
          },
        ],
        outputs: [editOutput("replaced", "replace_values")],
      });
      const result = bulkGroupReceiptSchema.parse(payload(response)),
        output = result.outputs[0];
      if (output === undefined) throw new Error("Missing output");
      const data = await values(directory, output.version.filePath);
      expect(data[0]).toEqual(["Id", "Status", "Amount", "Note"]);
      expect(
        data
          .slice(1)
          .every(
            (row) => Array.isArray(row) && row.every((value) => value === null),
          ),
      ).toBe(true);
    }),
  );
});

it("finds duplicate records without including unique records in its output", async () => {
  await workspace(async (directory) => {
    await book(directory, "orders.xlsx", [
      ["a", "first", 1, ""],
      ["b", "unique", 2, ""],
      ["a", "last", 3, ""],
    ]);
    await connected(directory, async (client) => {
      const response = await invoke(client, {
        steps: [
          await readStep(directory, "orders", "orders.xlsx", "A1:D4"),
          {
            kind: "deduplicate",
            id: "duplicates",
            input: "orders",
            keys: ["Id"],
            keep: "duplicates_only",
          },
        ],
        outputs: [newOutput("duplicates")],
      });
      const result = bulkGroupReceiptSchema.parse(payload(response)),
        output = result.outputs[0];
      if (output === undefined) throw new Error("Missing output");
      expect(
        (await values(directory, output.version.filePath))
          .slice(1)
          .map((row) => (Array.isArray(row) ? row.slice(0, 2) : row)),
      ).toEqual([
        ["a", "first"],
        ["a", "last"],
      ]);
      expect(result.steps[1]).toMatchObject({
        counts: {
          duplicateGroups: 1,
          duplicateRecords: 1,
          excluded: 1,
          removed: 0,
        },
      });
    });
  });
});

it("refuses to silently ignore deduplication through changed_values", async () => {
  await workspace(async (directory) => {
    await book(directory, "orders.xlsx", [
      ["a", "first", 1, ""],
      ["a", "last", 2, ""],
    ]);
    await connected(directory, async (client) => {
      const response = await invoke(client, {
        steps: [
          await readStep(directory, "orders", "orders.xlsx", "A1:D3"),
          {
            kind: "deduplicate",
            id: "dedup",
            input: "orders",
            keys: ["Id"],
            keep: "first",
          },
        ],
        outputs: [editOutput("dedup")],
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({
        error: "invalid_argument",
        message: expect.stringContaining("replace_values"),
      });
      expect(await readdir(join(directory, "out"))).toEqual([]);
    });
  });
});

it("keeps successful independent outputs when the failed job diagnostic location is unusable", async () => {
  await workspace(async (directory) =>
    connected(directory, async (client) => {
      const source = await readStep(directory),
        bad = {
          ...source,
          source: { ...source.source, filePath: "missing.xlsx" },
        };
      const job = {
        kind: "independent",
        jobs: [
          {
            id: "good",
            group: { steps: [source], outputs: [newOutput("orders")] },
          },
          {
            id: "bad",
            group: { steps: [bad], outputs: [newOutput("orders")] },
          },
        ],
      };
      const prepared = z
        .object({
          jobs: z.array(z.object({ id: z.string(), jobId: z.string() })),
        })
        .parse(
          payload(
            await preparedCall(client, {
              name: "prepare_bulk_job",
              arguments: { job },
            }),
          ),
        );
      const badId = prepared.jobs.find((child) => child.id === "bad")?.jobId;
      if (badId === undefined) throw new Error("Missing failed job identity");
      await writeFile(
        join(directory, "out", `failed-${badId}`),
        "occupied diagnostic path",
      );
      const response = await preparedCall(client, {
        name: "run_bulk_job",
        arguments: { job },
      });
      expect(response.isError, JSON.stringify(payload(response))).not.toBe(
        true,
      );
      const result = bulkBatchReceiptSchema.parse(payload(response));
      expect(result.kind).toBe("partial");
      expect(result.jobs[0]).toMatchObject({ kind: "complete" });
      expect(result.jobs[1]).toMatchObject({
        kind: "failed",
        failure: { error: "file_not_found", diagnosticRetained: false },
      });
    }),
  );
});

it("bounds the advertised job catalog while keeping kind-specific argument validation strict", async () => {
  await workspace(async (directory) =>
    connected(directory, async (client) => {
      const tools = (await client.listTools()).tools;
      for (const name of ["prepare_bulk_job", "run_bulk_job"]) {
        const tool = tools.find((item) => item.name === name);
        expect(tool).toBeDefined();
        expect(Buffer.byteLength(JSON.stringify(tool))).toBeLessThanOrEqual(
          50_000,
        );
        expect(tool?.inputSchema).toMatchObject({
          properties: {
            job: {
              type: "object",
              properties: {
                kind: { enum: ["dependent", "independent"] },
                group: {
                  properties: {
                    steps: {
                      items: {
                        properties: {
                          where: {
                            type: "array",
                            items: { required: ["column", "op"] },
                          },
                        },
                      },
                    },
                  },
                },
                jobs: { type: "array" },
              },
            },
          },
        });
      }
      const read = await readStep(directory);
      for (const value of [
        { kind: "number", value: "7" },
        { kind: "blank", value: "unexpected" },
        { kind: "date", value: "2026-02-30" },
      ]) {
        const invalid = await invoke(client, {
          steps: [
            read,
            {
              kind: "update",
              id: "invalid",
              input: read.id,
              set: [{ column: "Amount", value }],
            },
          ],
          outputs: [newOutput("invalid")],
        });
        expect(invalid.isError).toBe(true);
        expect(payload(invalid)).toMatchObject({ error: "invalid_argument" });
      }
      const response = await invoke(client, {
        steps: [{ kind: "read", id: "invalid", source: read.source }],
        outputs: [newOutput("invalid")],
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({
        error: "invalid_argument",
        message: expect.stringContaining("selection"),
      });
      expect(await readdir(join(directory, "out"))).toEqual([]);
      const extra = await invoke(client, {
        steps: [{ ...read, overwrite: true }],
        outputs: [newOutput("orders")],
      });
      expect(extra.isError).toBe(true);
      expect(payload(extra)).toMatchObject({ error: "invalid_argument" });
      for (const job of [
        { kind: "dependent" },
        {
          kind: "dependent",
          group: { steps: [read], outputs: [newOutput("orders")] },
          jobs: [],
        },
        {
          kind: "independent",
          group: { steps: [read], outputs: [newOutput("orders")] },
        },
      ]) {
        const invalid = await preparedCall(client, {
          name: "run_bulk_job",
          arguments: { job },
        });
        expect(invalid.isError).toBe(true);
        expect(payload(invalid)).toMatchObject({ error: "invalid_argument" });
      }
      expect(await readdir(join(directory, "out"))).toEqual([]);
    }),
  );
});
import { preparedCall } from "./fixtures/prepared-call.js";
