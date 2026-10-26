import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { parse } from "csv-parse/sync";
import * as XLSX from "@e965/xlsx";
import JSZip from "jszip";
import { z } from "zod";
import { it, expect } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createWorkbookOutput } from "../src/platform/versions.js";
import { createExcelMcpServer } from "../src/server.js";
import { bulkGroupReceiptSchema } from "../src/tools/bulk-job-schemas.js";

const corpus = process.env["SEZZLEE_CORPUS"];
const csvRows = z.array(z.array(z.string()));
function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function payload(result: { readonly content: readonly unknown[] }): unknown {
  const first = result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("text" in first) ||
    typeof first.text !== "string"
  )
    throw new Error("Missing tool JSON");
  return JSON.parse(first.text);
}
async function workspace(
  run: (directory: string, client: Client) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "excel-bulk-corpus-"));
  await mkdir(join(directory, "out"));
  const root = await createWorkbookRoot(directory),
    server = createExcelMcpServer(root, {
      mode: "write",
      output: await createWorkbookOutput(root, "out"),
    }),
    client = new Client({ name: "bulk-external-corpus", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await run(directory, client);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function fixture(directory: string, relative: string, name: string) {
  if (corpus === undefined) throw new Error("SEZZLEE_CORPUS is required");
  const path = join(corpus, relative),
    bytes = await readFile(path);
  await writeFile(join(directory, name), bytes);
  return { path, bytes, version: { filePath: name, versionId: sha(bytes) } };
}
async function outputRows(directory: string, filePath: string) {
  const workbook = XLSX.read(await readFile(join(directory, filePath)), {
      type: "buffer",
    }),
    sheet = workbook.Sheets.S;
  if (sheet === undefined) throw new Error("Missing report");
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
  });
}

it.skipIf(corpus === undefined)(
  "updates complete public corpus CSV records against an independent CSV parser and SheetJS reader",
  async () => {
    await workspace(async (directory, client) => {
      const source = await fixture(
          directory,
          "csv-spectrum/files/simple.csv",
          "source.csv",
        ),
        raw = csvRows.parse(
          parse(source.bytes, { skip_empty_lines: true, bom: true }),
        ),
        headers = raw[0],
        first = raw[1];
      expect(headers).toEqual(["a", "b", "c"]);
      if (first === undefined) throw new Error("The pinned CSV needs records");
      const response = await client.callTool({
        name: "run_bulk_job",
        arguments: {
          job: {
            kind: "dependent",
            group: {
              steps: [
                {
                  kind: "read",
                  id: "rows",
                  source: source.version,
                  selection: {
                    kind: "records",
                    range: `A1:C${raw.length}`,
                    headerRow: 1,
                  },
                },
                {
                  kind: "update",
                  id: "updated",
                  input: "rows",
                  where: [{ column: "a", op: "eq", value: first[0] }],
                  set: [
                    {
                      column: "b",
                      value: { kind: "text", value: "bulk-corpus" },
                    },
                  ],
                },
              ],
              outputs: [
                {
                  kind: "new",
                  id: "report",
                  sheets: [{ name: "S", input: "updated" }],
                },
              ],
            },
          },
        },
      });
      expect(response.isError, JSON.stringify(payload(response))).not.toBe(
        true,
      );
      const result = bulkGroupReceiptSchema.parse(payload(response)),
        output = result.outputs[0];
      if (output === undefined) throw new Error("Missing output");
      expect(await outputRows(directory, output.version.filePath)).toEqual([
        headers,
        ...raw
          .slice(1)
          .map((row) =>
            row[0] === first[0] ? [row[0], "bulk-corpus", row[2]] : row,
          ),
      ]);
      expect(await readFile(source.path)).toEqual(source.bytes);
      expect(await readFile(join(directory, "source.csv"))).toEqual(
        source.bytes,
      );
    });
  },
);

it.skipIf(corpus === undefined)(
  "joins two public corpus encodings while preserving text keys and numeric-looking text",
  async () => {
    await workspace(async (directory, client) => {
      const left = await fixture(
          directory,
          "csv-spectrum/files/simple.csv",
          "left.csv",
        ),
        right = await fixture(
          directory,
          "csv-spectrum/files/simple_crlf.csv",
          "right.csv",
        );
      const l = csvRows.parse(
          parse(left.bytes, { skip_empty_lines: true, bom: true }),
        ),
        r = csvRows.parse(
          parse(right.bytes, { skip_empty_lines: true, bom: true }),
        );
      expect(l[0]).toEqual(["a", "b", "c"]);
      expect(r[0]).toEqual(["a", "b", "c"]);
      expect(new Set(r.slice(1).map((row) => row[0])).size).toBe(r.length - 1);
      const response = await client.callTool({
        name: "run_bulk_job",
        arguments: {
          job: {
            kind: "dependent",
            group: {
              steps: [
                {
                  kind: "read",
                  id: "left",
                  source: left.version,
                  selection: {
                    kind: "records",
                    range: `A1:C${l.length}`,
                    headerRow: 1,
                  },
                },
                {
                  kind: "read",
                  id: "right",
                  source: right.version,
                  selection: {
                    kind: "records",
                    range: `A1:C${r.length}`,
                    headerRow: 1,
                  },
                },
                {
                  kind: "join",
                  id: "joined",
                  left: "left",
                  right: "right",
                  join: "left",
                  keys: [{ sourceColumn: "a", targetColumn: "a" }],
                  columns: [
                    { side: "left", column: "a", as: "Id" },
                    { side: "left", column: "b", as: "Left" },
                    { side: "right", column: "c", as: "Right" },
                  ],
                },
              ],
              outputs: [
                {
                  kind: "new",
                  id: "report",
                  sheets: [{ name: "S", input: "joined" }],
                },
              ],
            },
          },
        },
      });
      expect(response.isError, JSON.stringify(payload(response))).not.toBe(
        true,
      );
      const result = bulkGroupReceiptSchema.parse(payload(response)),
        output = result.outputs[0];
      if (output === undefined) throw new Error("Missing output");
      expect(await outputRows(directory, output.version.filePath)).toEqual([
        ["Id", "Left", "Right"],
        ...l
          .slice(1)
          .map((row) => [
            row[0],
            row[1],
            r.slice(1).find((candidate) => candidate[0] === row[0])?.[2] ??
              null,
          ]),
      ]);
      expect(await readFile(left.path)).toEqual(left.bytes);
      expect(await readFile(right.path)).toEqual(right.bytes);
    });
  },
);

it.skipIf(corpus === undefined)(
  "refuses preserved editing of a real Strict corpus workbook without claiming output completion",
  async () => {
    await workspace(async (directory, client) => {
      const source = await fixture(
          directory,
          "apache-testdata/files/poi/spreadsheet/SimpleStrict.xlsx",
          "strict.xlsx",
        ),
        zip = await JSZip.loadAsync(source.bytes);
      const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
      expect(workbookXml).toContain(
        "http://purl.oclc.org/ooxml/spreadsheetml/main",
      );
      const parsed = XLSX.read(Buffer.from(source.bytes), { type: "buffer" }),
        name = parsed.SheetNames[0];
      if (name === undefined) throw new Error("Missing pinned Strict sheet");
      const sheet = parsed.Sheets[name];
      if (sheet === undefined) throw new Error("Missing pinned sheet");
      const reference = Object.keys(sheet).find(
        (key) =>
          !key.startsWith("!") &&
          sheet[key]?.v !== undefined &&
          sheet[key]?.v !== null &&
          String(sheet[key]?.v) !== "" &&
          sheet[key]?.f === undefined &&
          ["s", "n", "b"].includes(sheet[key]?.t ?? ""),
      );
      if (reference === undefined)
        throw new Error(
          "The pinned Strict fixture needs a literal header cell",
        );
      const headerRow = XLSX.utils.decode_cell(reference).r + 1;
      const job = {
        kind: "dependent",
        group: {
          steps: [
            {
              kind: "read",
              id: "strict",
              source: source.version,
              selection: {
                kind: "records",
                sheetName: name,
                range: `${reference}:${reference}`,
                headerRow,
              },
            },
          ],
          outputs: [
            {
              kind: "edit",
              id: "report",
              target: "strict",
              input: "strict",
              mode: "changed_values",
            },
          ],
        },
      };
      const prepared = await client.callTool({
        name: "prepare_bulk_job",
        arguments: { job },
      });
      expect(payload(prepared)).toMatchObject({
        kind: "blocked",
        jobs: [
          {
            kind: "blocked",
            failure: { message: expect.stringContaining("strict_markup") },
          },
        ],
      });
      const response = await client.callTool({
        name: "run_bulk_job",
        arguments: { job },
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({
        error: "invalid_argument",
        message: expect.stringContaining("strict_markup"),
      });
      expect(await readdir(join(directory, "out"))).toEqual([]);
      expect(await readFile(source.path)).toEqual(source.bytes);
    });
  },
);
