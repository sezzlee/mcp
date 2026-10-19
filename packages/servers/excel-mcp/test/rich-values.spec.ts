import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";
import { richWorkbook } from "./fixtures/rich-workbook.js";

const altText = "店舗 — München — متجر <A&B>";
const array = { anchor: "C2", ref: "C2:C4", dynamic: true, collapsed: false };
let directory: string;
let client: Client;
let server: ReturnType<typeof createExcelMcpServer>;

async function request(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({
    name,
    arguments: { filePath: "rich.xlsx", sheetName: "Rich", ...args },
  });
  const content = response.content[0];
  if (content?.type !== "text") throw new Error("Missing text response");
  return {
    ...(JSON.parse(content.text) as Record<string, unknown>),
    isError: response.isError === true,
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-rich-values-"));
  await writeFile(join(directory, "rich.xlsx"), richWorkbook());
  server = createExcelMcpServer(await createWorkbookRoot(directory));
  client = new Client({ name: "rich-values-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
});

afterAll(async () => {
  await client.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

describe("independent modern OOXML values", () => {
  it("lists Place in Cell pictures before reading the sheet grid", async () => {
    const report = await request("get_images", {});
    expect(report["isError"]).toBe(false);
    expect(report["count"]).toBe(2);
    expect(report["images"]).toEqual([
      expect.objectContaining({
        imageId: 0,
        anchor: "inCell",
        cell: "A2",
        extension: "png",
        altText,
        decorative: false,
      }),
      expect.objectContaining({
        imageId: 1,
        anchor: "inCell",
        cell: "A3",
        decorative: true,
      }),
    ]);
  });

  it("resolves the metadata chain instead of returning image fallback errors", async () => {
    const report = await request("read_sheet", {
      range: "A2:A3",
      headerRow: 1,
    });
    expect(report["isError"]).toBe(false);
    expect(report["values"]).toEqual([
      [{ imageId: 0, altText, decorative: false }],
      [{ imageId: 1, decorative: true }],
    ]);
  });

  it("searches the exact multilingual alternative text", async () => {
    const report = await request("find_in_sheet", {
      query: altText,
      matchMode: "exact",
    });
    expect(report["isError"]).toBe(false);
    expect(report["total"]).toBe(1);
    expect(report["matches"]).toEqual([
      {
        address: "A2",
        row: 2,
        column: 1,
        value: { imageId: 0, altText, decorative: false },
      },
    ]);
  });

  it("links every stored dynamic result to its array anchor and extent", async () => {
    const report = await request("read_sheet", {
      range: "C2:C4",
      headerRow: 1,
    });
    expect(report["isError"]).toBe(false);
    expect(report["values"]).toEqual([[10], [20], [30]]);
    expect(report["cellNotes"]).toEqual({
      C2: {
        kind: "formula",
        formula: "=SEQUENCE(3,1,10,10)",
        cached: true,
        array,
      },
      C3: { kind: "array", array },
      C4: { kind: "array", array },
    });
  });

  it("keeps native formula errors distinct from rich image fallbacks", async () => {
    const report = await request("read_sheet", {
      range: "E2:E4",
      headerRow: 1,
    });
    expect(report["isError"]).toBe(false);
    expect(report["values"]).toEqual([
      [{ error: "#DIV/0!" }],
      [{ error: "#N/A" }],
      [{ error: "#NUM!" }],
    ]);
  });

  it("counts image values while excluding them from numeric/error diagnostics", async () => {
    const report = await request("aggregate_sheet", {
      range: "A2:A3",
      headerRow: 0,
      columnMode: "letter",
      metrics: [
        { fn: "countValues", column: "A" },
        { fn: "countDistinct", column: "A" },
        { fn: "sum", column: "A" },
      ],
    });
    expect(report["isError"]).toBe(false);
    expect(report["rows"]).toEqual([[2, 2, null]]);
    expect(report["columnStats"]).toMatchObject({ A: { images: 2 } });
    expect(JSON.stringify(report["columnStats"])).not.toContain('"errors"');
    expect(report["errorDistribution"]).toBeUndefined();
  });
});
