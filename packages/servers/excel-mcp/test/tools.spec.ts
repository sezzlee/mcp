import { mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, inject, it } from "vitest";
import {
  createWorkbookRoot,
  type WorkbookRoot,
} from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";
import {
  toolDefinitions,
  toolNames,
  type ToolHandlers,
} from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

const manifest = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

function payload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("the tool returned no text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("tool registration", () => {
  it("registers exactly the declared tools", async () => {
    const fixtures = inject("fixtures");
    const server = createExcelMcpServer(
      await createWorkbookRoot(fixtures.root),
    );
    const client = new Client({ name: "excel-spec", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    expect(client.getServerVersion()).toEqual({
      name: "sezzlee-excel",
      version: manifest.version,
    });

    const listed = (await client.listTools()).tools;
    expect(listed.map((tool) => tool.name).sort()).toEqual(
      [...toolNames].sort(),
    );
    expect(toolNames.slice().sort()).toEqual(
      Object.keys(toolDefinitions).sort(),
    );
    expect(
      listed.every((tool) => tool.annotations?.readOnlyHint === true),
    ).toBe(true);

    const called = await client.callTool({
      name: "list_workbooks",
      arguments: {},
    });
    expect(called.isError).toBeUndefined();

    await client.close();
    await server.close();
  });
});

describe("handlers", () => {
  let handlers: ToolHandlers;
  let root: WorkbookRoot;

  beforeAll(async () => {
    const fixtures = inject("fixtures");
    root = await createWorkbookRoot(fixtures.root);
    handlers = createHandlers(root);
  });

  it("lists workbooks", async () => {
    const result = await handlers.list_workbooks({});
    expect(result.isError).toBeUndefined();
    expect(payload(result)["root"]).toBe(root.real);
  });

  it("describes a workbook", async () => {
    const result = await handlers.describe_workbook({
      filePath: "q1/sample.xlsx",
    });
    expect(payload(result)["dateSystem"]).toBe("1900");
  });

  it("reads a sheet", async () => {
    const result = await handlers.read_sheet({
      filePath: "q1/sample.xlsx",
      range: "A1:B3",
    });
    expect(payload(result)["values"]).toEqual([
      ["EMEA0", 1],
      ["EMEA1", 2],
    ]);
  });

  it("returns merged ranges", async () => {
    const result = await handlers.get_merged_ranges({
      filePath: "q1/sample.xlsx",
    });
    expect(payload(result)["merges"]).toEqual(["A10:C10"]);
  });

  it("returns data validations", async () => {
    const result = await handlers.get_data_validations({
      filePath: "validations.xlsx",
    });
    expect(payload(result)["count"]).toBe(3);
  });

  it("returns declared tables", async () => {
    const result = await handlers.get_tables({
      filePath: "facets.xlsx",
      sheetName: "Tablolar",
    });
    expect(payload(result)["count"]).toBe(2);
  });

  it("returns conditional format rules", async () => {
    const result = await handlers.get_conditional_formats({
      filePath: "facets.xlsx",
      sheetName: "Kosullu",
    });
    expect(payload(result)["count"]).toBe(5);
  });

  it("returns embedded images", async () => {
    const result = await handlers.get_images({
      filePath: "facets.xlsx",
      sheetName: "Resimler",
    });
    expect(payload(result)["count"]).toBe(2);
  });

  it("aggregates a sheet", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "q1/sample.xlsx",
      metrics: [{ fn: "count" }],
    });
    expect(result.isError).toBeUndefined();
    expect(payload(result)["matchedRows"]).toBeGreaterThan(0);
  });

  it("says who chose the header row", async () => {
    const scanned = payload(
      await handlers.read_sheet({ filePath: "title-band.xlsx" }),
    );
    expect(scanned).toMatchObject({ headerRow: 3, headerRowSource: "scanned" });
    const fallback = payload(
      await handlers.read_sheet({
        filePath: "title-band.xlsx",
        sheetName: "NoHeader",
      }),
    );
    expect(fallback).toMatchObject({
      headerRow: 1,
      headerRowSource: "default",
    });
    const explicit = await handlers.read_sheet({
      filePath: "title-band.xlsx",
      headerRow: 3,
    });
    expect(payload(explicit)["headerRowSource"]).toBe("explicit");
  });

  it("finds the same header row whatever window a call reads", async () => {
    for (const range of ["A6:G8", "D1:D9", "A1:A9"]) {
      const body = payload(
        await handlers.read_sheet({
          filePath: "title-band.xlsx",
          sheetName: "Faturalar",
          range,
        }),
      );
      expect(body).toMatchObject({ headerRow: 3, headerRowSource: "scanned" });
    }
  });

  it("previews the header row a read uses for every sheet", async () => {
    const described = payload(
      await handlers.describe_workbook({ filePath: "title-band.xlsx" }),
    );
    const sheets = described["sheets"] as {
      name: string;
      header: { row: number; source: string } | null;
    }[];
    for (const sheet of sheets) {
      const read = payload(
        await handlers.read_sheet({
          filePath: "title-band.xlsx",
          sheetName: sheet.name,
          maxCells: 1,
        }),
      );
      expect(sheet.header).toMatchObject({
        row: read["headerRow"],
        source: read["headerRowSource"],
      });
    }
    expect(sheets.find((sheet) => sheet.name === "Faturalar")?.header).toEqual({
      row: 3,
      source: "scanned",
      columns: [
        { letter: "A", text: "Fatura Tarihi" },
        { letter: "B", text: "Vade Tarihi" },
        { letter: "C", text: "Fatura No" },
        { letter: "D", text: "Tutar" },
        { letter: "E", text: "Ödenen Tutar" },
        { letter: "F", text: "Kalan Tutar" },
        { letter: "G", text: "Kalan Gün" },
      ],
      moreColumns: 0,
    });
  });

  it("names a numeric header cell by its text", async () => {
    const body = payload(
      await handlers.read_sheet({
        filePath: "title-band.xlsx",
        sheetName: "NoHeader",
      }),
    );
    expect(
      (body["columns"] as { header: string | null }[]).map(
        (column) => column.header,
      ),
    ).toEqual(["1", "2", "3"]);
  });

  it("returns the header row of a header-only range without leaving it", async () => {
    const body = payload(
      await handlers.read_sheet({
        filePath: "title-band.xlsx",
        sheetName: "Faturalar",
        range: "A3:G3",
      }),
    );
    expect(body).toMatchObject({ range: "A3:G3", values: [], returnedRows: 0 });
    expect((body["columns"] as { header: string | null }[])[3]?.header).toBe(
      "Tutar",
    );
    expect(body["warnings"]).toEqual([
      expect.objectContaining({
        code: "header_only_range",
        message: expect.stringContaining("only header row 3"),
      }),
    ]);
  });

  it("proves the header row on request", async () => {
    const result = await handlers.read_sheet({
      filePath: "title-band.xlsx",
      sheetName: "Faturalar",
      headerScan: true,
    });
    const body = payload(result);
    expect(body["headerRow"]).toBe(3);
    expect(body["headerRowSource"]).toBe("scanned");
  });

  it("reads the columns under a title band without being told the header row", async () => {
    const input = {
      filePath: "title-band.xlsx",
      sheetName: "Faturalar",
      metrics: [{ fn: "sum" as const, column: "Tutar" }],
    };
    expect(payload(await handlers.aggregate_sheet(input))).toMatchObject({
      headerRow: 3,
      headerRowSource: "scanned",
      rows: [[21000]],
      matchedRows: 6,
    });
    const failed = await handlers.aggregate_sheet({ ...input, headerRow: 1 });
    expect(failed.isError).toBe(true);
    expect(payload(failed)).toMatchObject({
      error: "unknown_column",
      recovery: expect.stringContaining("headerRow"),
    });
  });

  it("reads the header row a table declares", async () => {
    const result = await handlers.read_sheet({
      filePath: "title-band.xlsx",
      sheetName: "Declared",
      headerScan: true,
    });
    const body = payload(result);
    expect(body["headerRow"]).toBe(3);
    expect(body["headerRowSource"]).toBe("declared");
  });

  it("finds cells", async () => {
    const result = await handlers.find_in_sheet({
      filePath: "q1/sample.xlsx",
      query: "EMEA1",
    });
    expect(payload(result)["total"]).toBe(1);
  });
});

describe("error surfacing", () => {
  let handlers: ToolHandlers;

  beforeAll(async () => {
    const fixtures = inject("fixtures");
    handlers = createHandlers(await createWorkbookRoot(fixtures.root));
  });

  it.each([
    ["../package.json.xlsx", "path_outside_root"],
    ["missing.xlsx", "file_not_found"],
    ["corrupt.xlsx", "not_a_workbook"],
    ["encrypted.xlsx", "encrypted_workbook"],
  ])("maps %s to %s", async (filePath, code) => {
    const result = await handlers.describe_workbook({ filePath });
    expect(result.isError).toBe(true);
    expect(payload(result)["error"]).toBe(code);
  });

  it.each([["chart"], ["pivotTable"], ["sparkline"]] as const)(
    "refuses a %s request instead of returning an empty list",
    async (kind) => {
      const result = await handlers.get_images({
        filePath: "facets.xlsx",
        sheetName: "Resimler",
        kind,
      });
      expect(result.isError).toBe(true);
      const body = payload(result);
      expect(body["error"]).toBe("unsupported_object_kind");
      if (kind === "chart") {
        expect(String(body["recovery"])).toContain("get_charts");
      } else {
        expect(String(body["recovery"])).toContain("capabilities");
      }
    },
  );

  it("refuses headerScan combined with headerRow", async () => {
    const result = await handlers.read_sheet({
      filePath: "title-band.xlsx",
      headerScan: true,
      headerRow: 3,
    });
    expect(payload(result)["error"]).toBe("invalid_argument");
  });

  it("rejects an invalid cursor before inheriting headerScan", async () => {
    const result = await handlers.read_sheet({
      filePath: "title-band.xlsx",
      headerScan: true,
      cursor: "x",
    });
    expect(payload(result)["error"]).toBe("invalid_cursor");
  });

  it("refuses headerScan for a delimited file", async () => {
    const result = await handlers.read_sheet({
      filePath: "csv/simple.csv",
      headerScan: true,
    });
    expect(payload(result)["error"]).toBe("unsupported_for_format");
  });

  it("reports a missing subdirectory as file_not_found, not a corrupt workbook", async () => {
    const result = await handlers.list_workbooks({ subdirectory: "nope" });
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body["error"]).toBe("file_not_found");
    expect(String(body["message"])).not.toContain("could not be read");
    expect(String(body["recovery"])).not.toContain("re-save");
  });

  it("surfaces an ambiguous column as a tool error", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "analysis.xlsx",
      groupBy: ["Total"],
      metrics: [{ fn: "count" }],
    });
    expect(result.isError).toBe(true);
    expect(payload(result)["error"]).toBe("ambiguous_column");
    expect(String(payload(result)["recovery"])).toContain('"B"');
  });

  it("surfaces an unknown column with the resolvable columns", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "analysis.xlsx",
      groupBy: ["Nope"],
      metrics: [{ fn: "count" }],
    });
    expect(payload(result)["error"]).toBe("unknown_column");
    expect(String(payload(result)["recovery"])).toContain("A (Region)");
  });

  it("reports an unknown sheet with a recovery hint", async () => {
    const result = await handlers.read_sheet({
      filePath: "q1/sample.xlsx",
      sheetName: "Nope",
    });
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body["error"]).toBe("unknown_sheet");
    expect(String(body["recovery"])).toContain("Notes (hidden)");
  });

  it("reports an empty sheet", async () => {
    const result = await handlers.read_sheet({ filePath: "empty.xlsx" });
    expect(payload(result)["error"]).toBe("empty_sheet");
  });

  it("reports an invalid range", async () => {
    const result = await handlers.read_sheet({
      filePath: "q1/sample.xlsx",
      range: "not-a-range",
    });
    expect(payload(result)["error"]).toBe("invalid_range");
  });

  it("rejects a cursor combined with a range", async () => {
    const result = await handlers.read_sheet({
      filePath: "q1/sample.xlsx",
      cursor: "x",
      range: "A1:B2",
    });
    expect(payload(result)["error"]).toBe("invalid_argument");
  });
});

describe("a directory that carries a readable extension", () => {
  it("is refused without leaking the sandbox root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "excel-trap-"));
    await mkdir(join(dir, "trap.xlsx"));
    const handlers = createHandlers(await createWorkbookRoot(dir));
    const result = await handlers.describe_workbook({ filePath: "trap.xlsx" });
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body["error"]).toBe("not_a_file");
    expect(String(body["message"])).toContain("not a regular file");
    expect(JSON.stringify(body)).not.toContain(dir);
  });
});
