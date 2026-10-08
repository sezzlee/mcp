import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
  type WorkbookRoot,
} from "../src/platform/paths.js";
import { createDocumentCache, sheetSource } from "../src/format/document.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";
import { parseCsv } from "../src/format/csv.js";
import { limits } from "../src/platform/limits.js";
import { decodeCursor } from "../src/grid/cursor.js";
import { selectSheetName } from "../src/format/sheetjs-workbook.js";
import { parseSheetJs } from "../src/format/sheetjs-workbook.js";
import { collectValidations } from "../src/metadata/validations.js";
import { validateCondition } from "../src/grid/predicate.js";
import { declaredTablesOf } from "../src/metadata/tables.js";
import { buildColumnIndex, resolveColumn } from "../src/grid/columns.js";
import { normalizeCell } from "../src/grid/cell-value.js";
import { readSheet } from "../src/grid/read-sheet.js";

let directory: string;
let root: WorkbookRoot;
let handlers: ToolHandlers;
function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return JSON.parse(content.text) as Record<string, unknown>;
}
async function save(
  name: string,
  rows: readonly (readonly ExcelJS.CellValue[])[],
): Promise<void> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Sales");
  for (const row of rows) sheet.addRow([...row]);
  await book.xlsx.writeFile(join(directory, name));
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-hardening-"));
  root = await createWorkbookRoot(directory);
  handlers = createHandlers(root);
  await save("mixed.xlsx", [["value"], [5], ["abc"]]);
  await save("reverse.xlsx", [["value"], ["abc"], [5]]);
  await save("overflow.xlsx", [
    ["group", "value"],
    ["a", 1e308],
    ["a", 1e308],
    ["b", 0],
  ]);
  await save("groups.xlsx", [
    ["group", "value"],
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  await save("paging.xlsx", [
    ["name", "value"],
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("CSV security and limits (#1 #14 #15 #17)", () => {
  it.each([
    [Buffer.from([0x61, 0x2c, 0xff]), {}],
    [Buffer.from([0xef, 0xbb, 0xbf, 0xff]), { encoding: "utf-8" }],
    [Buffer.from([0xff]), { encoding: "utf-8" }],
    [Buffer.from([0xff, 0xfe, 0x00, 0xd8]), {}],
    [Buffer.from([0x00, 0xd8]), { encoding: "utf-16le" }],
    [Buffer.from([0xd8, 0x00]), { encoding: "utf-16be" }],
    [Buffer.from([0xff, 0xfe, 0x61]), { encoding: "utf-16le" }],
  ] as const)("rejects malformed UTF input %j %j", async (bytes, options) => {
    await expect(
      parseCsv(bytes, bytes.length, options, "bad.csv"),
    ).rejects.toMatchObject({ code: "undecodable_text" });
  });
  it("preserves blank records and tells the caller how to select the header", async () => {
    const bytes = Buffer.from("\nName,Name\na,b\n\nc,d\n\n");
    await writeFile(join(directory, "blank.csv"), bytes);
    const parsed = await parseCsv(
      bytes,
      bytes.length,
      { delimiter: "comma" },
      "blank.csv",
    );
    expect(parsed.rows).toEqual([
      [],
      ["Name", "Name"],
      ["a", "b"],
      [],
      ["c", "d"],
      [],
    ]);
    expect(parsed.report.warnings?.join(" ")).toContain("headerRow");
    const response = body(
      await handlers.read_sheet({
        filePath: "blank.csv",
        delimiter: "comma",
        headerRow: 2,
      }),
    );
    expect(response.headerRow).toBe(2);
    expect(response.values).toEqual([
      ["a", "b"],
      [null, null],
      ["c", "d"],
      [null, null],
    ]);
  });
  it.each(["comma", "semicolon", "tab", "pipe"] as const)(
    "bounds field allocation with %s while preserving quoted delimiters",
    async (delimiter) => {
      const char = { comma: ",", semicolon: ";", tab: "\t", pipe: "|" }[
        delimiter
      ];
      const at = Buffer.from(Array(limits.maxCsvColumns).fill("x").join(char));
      expect(
        (await parseCsv(at, at.length, { delimiter }, "wide.csv")).rows[0],
      ).toHaveLength(limits.maxCsvColumns);
      const over = Buffer.concat([at, Buffer.from(char)]);
      await expect(
        parseCsv(over, over.length, { delimiter }, "wide.csv"),
      ).rejects.toMatchObject({ code: "file_too_large" });
      const quoted = Buffer.from(`"a${char}b\n""quote"""${char}ok\r\n`);
      expect(
        (await parseCsv(quoted, quoted.length, { delimiter }, "quotes.csv"))
          .rows,
      ).toEqual([[`a${char}b\n"quote"`, "ok"]]);
    },
  );
  /** Guard: parsing 16 MiB of CSV was measured at 31 s on the GitHub darwin-x64 runner. */
  it("enforces the real 16 MiB byte boundary before decoding", async () => {
    const at = Buffer.alloc(limits.maxCsvBytes, 0x61);
    expect(
      (await parseCsv(at, at.length, { delimiter: "comma" }, "at.csv")).rows,
    ).toHaveLength(1);
    const forbidden = new Proxy(Buffer.alloc(0), {
      get() {
        throw new Error("bytes must not be accessed");
      },
    });
    await expect(
      parseCsv(forbidden, limits.maxCsvBytes + 1, {}, "over.csv"),
    ).rejects.toMatchObject({ code: "file_too_large" });
  }, 120_000);
  it("enforces the real 16 MiB byte boundary through the handler", async () => {
    const at = Buffer.alloc(limits.maxCsvBytes, 0x61);
    await writeFile(join(directory, "at.csv"), at);
    expect(
      (
        await handlers.describe_workbook({
          filePath: "at.csv",
          delimiter: "comma",
        })
      ).isError,
    ).not.toBe(true);
    await writeFile(
      join(directory, "over.csv"),
      Buffer.concat([at, Buffer.from("a")]),
    );
    expect(
      body(
        await handlers.describe_workbook({
          filePath: "over.csv",
          delimiter: "comma",
        }),
      ).error,
    ).toBe("file_too_large");
  }, 120_000);
  it("enforces exactly 2,000,000 fields independently of bytes and record width", async () => {
    // 2,000 records x 1,000 fields, including the first/header record.
    const at = Buffer.from(`${Array(1000).fill("x").join(",")}\n`.repeat(2000));
    expect(at.length).toBeLessThan(limits.maxCsvBytes);
    const parsed = await parseCsv(
      at,
      at.length,
      { delimiter: "comma" },
      "cells.csv",
    );
    expect(parsed.rows.reduce((sum, row) => sum + row.length, 0)).toBe(
      limits.maxCsvCells,
    );
    const over = Buffer.concat([at, Buffer.from("x")]);
    await expect(
      parseCsv(over, over.length, { delimiter: "comma" }, "cells-over.csv"),
    ).rejects.toMatchObject({ code: "file_too_large" });
    await writeFile(join(directory, "cells.csv"), at);
    expect(
      (
        await handlers.describe_workbook({
          filePath: "cells.csv",
          delimiter: "comma",
        })
      ).isError,
    ).not.toBe(true);
    await writeFile(join(directory, "cells-over.csv"), over);
    expect(
      body(
        await handlers.describe_workbook({
          filePath: "cells-over.csv",
          delimiter: "comma",
        }),
      ).error,
    ).toBe("file_too_large");
  }, 30000);
});

describe("numeric and predicate contracts (#4 #5 #6 #22 #23)", () => {
  it.each(["sum", "avg", "stddev"] as const)(
    "reports overflow for %s without JSON null",
    async (fn) => {
      const result = body(
        await handlers.aggregate_sheet({
          filePath: "overflow.xlsx",
          metrics: [{ fn, column: "value" }],
        }),
      );
      expect(result.error).toBe("numeric_overflow");
      expect(result.rows).toBeUndefined();
    },
  );
  it("rejects overflow text when coercion is requested", async () => {
    await writeFile(join(directory, "numeric.csv"), "value\n1e400\n");
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "numeric.csv",
        metrics: [{ fn: "sum", column: "value" }],
        coerceText: true,
      }),
    );
    expect(result.error).toBe("numeric_overflow");
  });
  it.each([true, false])(
    "rejects both mixed min/max orders, caseSensitive=%s",
    async (caseSensitive) => {
      for (const filePath of ["mixed.xlsx", "reverse.xlsx"])
        for (const fn of ["min", "max"] as const) {
          const result = body(
            await handlers.aggregate_sheet({
              filePath,
              metrics: [{ fn, column: "value" }],
              caseSensitive,
            }),
          );
          expect(result.error).toBe("invalid_argument");
          expect(String(result.message)).toContain("A3");
        }
    },
  );
  it("distinguishes empty sums and real zero", async () => {
    const base = {
      filePath: "overflow.xlsx",
      metrics: [{ fn: "sum" as const, column: "value" }],
    };
    const zero = body(
      await handlers.aggregate_sheet({
        ...base,
        where: [{ column: "group", op: "eq", value: "b" }],
      }),
    );
    const empty = body(
      await handlers.aggregate_sheet({
        ...base,
        where: [{ column: "group", op: "eq", value: "missing" }],
      }),
    );
    expect(zero.rows).toEqual([[0]]);
    expect(empty.rows).toEqual([[null]]);
  });
  it.each([
    ["5", 100],
    ["2024-01-01", "text"],
    [10, 1],
  ])(
    "validates incompatible or reversed bounds %j before scanning",
    (...values) => {
      expect(() =>
        validateCondition({ column: "A", op: "between", values }),
      ).toThrow(expect.objectContaining({ code: "invalid_argument" }));
    },
  );
  it("uses the requested case policy when validating text bounds", () => {
    expect(() =>
      validateCondition(
        { column: "A", op: "between", values: ["a", "Z"] },
        false,
      ),
    ).not.toThrow();
    expect(() =>
      validateCondition(
        { column: "A", op: "between", values: ["a", "Z"] },
        true,
      ),
    ).toThrow();
  });
  it("rejects an out-of-range metric index with multiple groups", async () => {
    expect(
      body(
        await handlers.aggregate_sheet({
          filePath: "groups.xlsx",
          groupBy: ["group"],
          metrics: [{ fn: "sum", column: "value" }],
          orderBy: "metric",
          orderByMetric: 2,
        }),
      ).error,
    ).toBe("invalid_argument");
  });
  it("makes returned and omitted row accounting explicit", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "groups.xlsx",
        groupBy: ["group"],
        metrics: [{ fn: "sum", column: "value" }],
        maxGroups: 1,
      }),
    );
    expect(result).toMatchObject({
      matchedRows: 3,
      returnedMatchedRows: 1,
      omittedMatchedRows: 2,
      returnedGroups: 1,
    });
    expect(result.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ counted: 1, skipped: 0 }),
      ]),
    );
  });
});

describe("snapshot and cursor contracts (#26 #27 #28 #33)", () => {
  it("revalidates bytes on a cache hit even after mtime and size are restored", async () => {
    const path = join(directory, "mutable.csv");
    await writeFile(path, "name\none\ntwo\n");
    const original = await stat(path);
    const cache = createDocumentCache(root.real);
    const resolved = await resolveWorkbookPath(root, "mutable.csv");
    const first = await cache.load(resolved);
    const page = body(
      await handlers.read_sheet({ filePath: "mutable.csv", maxCells: 1 }),
    );
    await writeFile(path, "name\nsix\nten\n");
    await utimes(path, original.atime, original.mtime);
    expect((await stat(path)).size).toBe(original.size);
    const second = await cache.load(resolved);
    expect(second.stamp).not.toBe(first.stamp);
    expect(
      readSheet(sheetSource(second), {
        maxCells: 10,
        headerRowSource: "default",
      }).values,
    ).toEqual([["six"], ["ten"]]);
    expect(
      body(
        await handlers.read_sheet({
          filePath: "mutable.csv",
          cursor: String(page.nextCursor),
        }),
      ).error,
    ).toBe("stale_cursor");
  });
  it.each([
    ["valueMode", "values", "formulas"],
    ["mergedCells", "master", "repeat"],
    ["headerRow", 1, 0],
    ["headerScan", false, true],
    ["includeHyperlinks", false, true],
  ] as const)(
    "inherits/repeats/rejects %s before defaults",
    async (key, initial, changed) => {
      const first = body(
        await handlers.read_sheet({
          filePath: "paging.xlsx",
          maxCells: 2,
          [key]: initial,
        }),
      );
      expect(typeof first.nextCursor).toBe("string");
      const cursor = String(first.nextCursor);
      expect(decodeCursor(cursor).v).toBe(2);
      expect(
        (
          await handlers.read_sheet({
            filePath: "paging.xlsx",
            cursor,
            maxCells: 4,
          })
        ).isError,
      ).not.toBe(true);
      expect(
        (
          await handlers.read_sheet({
            filePath: "paging.xlsx",
            cursor,
            [key]: initial,
          })
        ).isError,
      ).not.toBe(true);
      const conflict = body(
        await handlers.read_sheet({
          filePath: "paging.xlsx",
          cursor,
          [key]: changed,
        }),
      );
      expect(conflict.error).toBe("invalid_argument");
      expect(String(conflict.message)).toContain(key);
    },
  );
  it("inherits CSV parse options and rejects changed delimiter/encoding", async () => {
    await writeFile(join(directory, "options.csv"), "name;value\na;1\nb;2\n");
    const first = body(
      await handlers.read_sheet({
        filePath: "options.csv",
        delimiter: "semicolon",
        encoding: "utf-8",
        maxCells: 2,
      }),
    );
    const cursor = String(first.nextCursor);
    expect(
      (await handlers.read_sheet({ filePath: "options.csv", cursor })).isError,
    ).not.toBe(true);
    for (const options of [
      { delimiter: "comma" as const },
      { encoding: "windows-1252" as const },
    ])
      expect(
        body(
          await handlers.read_sheet({
            filePath: "options.csv",
            cursor,
            ...options,
          }),
        ).error,
      ).toBe("invalid_argument");
    expect(
      (
        await handlers.read_sheet({
          filePath: "options.csv",
          cursor,
          delimiter: "semicolon",
          encoding: "utf-8",
        })
      ).isError,
    ).not.toBe(true);
  });
  it("rejects old and malformed tokens", () => {
    for (const payload of [{ v: 1 }, { v: 2, r: NaN }, { v: 2, r: -1 }])
      expect(() =>
        decodeCursor(
          Buffer.from(JSON.stringify(payload)).toString("base64url"),
        ),
      ).toThrow(expect.objectContaining({ code: "invalid_cursor" }));
  });
  it("preserves exact case and detects both NFC-colliding names in a real file", async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Caf\u00e9").getCell("A1").value = "first";
    book.addWorksheet("Cafe\u0301").getCell("A1").value = "second";
    await book.xlsx.writeFile(join(directory, "collision.xlsx"));
    const loaded = await createDocumentCache(root.real).load(
      await resolveWorkbookPath(root, "collision.xlsx"),
    );
    expect(loaded.format).toBe("xlsx");
    if (loaded.format !== "xlsx") throw new Error("wrong format");
    expect(loaded.workbook.sheetNames).toEqual(["Caf\u00e9", "Cafe\u0301"]);
    for (const name of ["Caf\u00e9", "Cafe\u0301"]) {
      expect(() => selectSheetName(loaded.workbook, name)).toThrow(
        expect.objectContaining({ code: "ambiguous_sheet" }),
      );
      expect(
        body(
          await handlers.read_sheet({
            filePath: "collision.xlsx",
            sheetName: name,
          }),
        ).error,
      ).toBe("ambiguous_sheet");
    }
    const wrongCase = body(
      await handlers.read_sheet({
        filePath: "paging.xlsx",
        sheetName: "sales",
      }),
    );
    expect(wrongCase.error).toBe("unknown_sheet");
    expect(String(wrongCase.recovery)).toContain("Sales");
    expect(
      (
        await handlers.read_sheet({
          filePath: "paging.xlsx",
          sheetName: "Sales",
        })
      ).isError,
    ).not.toBe(true);
  });
});

describe("cell/header and metadata regressions", () => {
  it("selects the horizontally relevant table and preserves repeat headers (#12 #16)", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Headers");
    sheet.addTable({
      name: "Left",
      ref: "A1",
      headerRow: true,
      columns: [{ name: "left" }, { name: "amount" }],
      rows: [["a", 1]],
    });
    sheet.addTable({
      name: "Right",
      ref: "E2",
      headerRow: true,
      columns: [{ name: "right" }, { name: "amount" }],
      rows: [["b", 2]],
    });
    await book.xlsx.writeFile(join(directory, "tables-horizontal.xlsx"));
    const table = body(
      await handlers.read_sheet({
        filePath: "tables-horizontal.xlsx",
        range: "E1:F3",
        headerScan: true,
      }),
    );
    expect(table).toMatchObject({ headerRow: 2, values: [["b", 2]] });
    const vertical = new ExcelJS.Workbook();
    const v = vertical.addWorksheet("Vertical");
    v.mergeCells("A1:A2");
    v.getCell("A1").value = "name";
    v.getCell("B2").value = "amount";
    v.getCell("A3").value = "a";
    v.getCell("B3").value = 1;
    await vertical.xlsx.writeFile(join(directory, "vertical.xlsx"));
    const repeated = body(
      await handlers.read_sheet({
        filePath: "vertical.xlsx",
        range: "A2:B3",
        headerScan: true,
        mergedCells: "repeat",
      }),
    );
    expect(repeated).toMatchObject({ headerRow: 2, values: [["a", 1]] });
    expect(repeated.columns).toEqual(
      expect.arrayContaining([expect.objectContaining({ header: "name" })]),
    );
  });
  it("normalizes real rich-text hyperlinks and exposes incomplete OOXML metadata (#8 #9 #10 #25)", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Meta");
    book.addWorksheet("Other");
    sheet.addRow(["link", "amount"]);
    sheet.getCell("A2").value = {
      text: "LINK_PLACEHOLDER",
      hyperlink: "https://example.com",
    };
    sheet.getCell("B2").value = 1;
    const imageId = book.addImage({
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ZkAAAAASUVORK5CYII=",
      extension: "png",
    });
    sheet.addImage(imageId, {
      tl: { col: 0, row: 3 },
      ext: { width: 1, height: 1 },
    });
    sheet.addConditionalFormatting({
      ref: "B2:B3",
      rules: [
        {
          type: "colorScale",
          priority: 1,
          cfvo: [{ type: "formula", value: 1 }, { type: "max" }],
          color: [{ argb: "FFFF0000" }, { argb: "FF00FF00" }],
        },
      ],
    });
    const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
    const shared = await zip.file("xl/sharedStrings.xml")!.async("string");
    expect(shared).toContain("LINK_PLACEHOLDER");
    zip.file(
      "xl/sharedStrings.xml",
      shared.replace(
        /<si><t(?:[^>]*)>LINK_PLACEHOLDER<\/t><\/si>/,
        `<si><r><t>${"x".repeat(600)}</t></r><r><t>end</t></r></si>`,
      ),
    );
    const drawing = await zip.file("xl/drawings/drawing1.xml")!.async("string");
    expect(drawing).toContain("xdr:oneCellAnchor");
    zip.file(
      "xl/drawings/drawing1.xml",
      drawing
        .replaceAll("xdr:oneCellAnchor", "xdr:absoluteAnchor")
        .replace(/<xdr:from>[\s\S]*?<\/xdr:from>/, '<xdr:pos x="0" y="0"/>'),
    );
    const sourceSheet = await zip
      .file("xl/worksheets/sheet1.xml")!
      .async("string");
    expect(sourceSheet).toContain('type="formula" val="1"');
    zip.file(
      "xl/worksheets/sheet1.xml",
      sourceSheet.replace(
        'type="formula" val="1"',
        'type="formula" val="$A$1"',
      ),
    );
    const workbook = await zip.file("xl/workbook.xml")!.async("string");
    zip.file(
      "xl/workbook.xml",
      workbook.replace(
        "</workbook>",
        '<definedNames><definedName name="Shared" localSheetId="0">Meta!$B$2</definedName><definedName name="Shared" localSheetId="1">Other!$B$2</definedName><definedName name="Global">Meta!$A$2</definedName></definedNames></workbook>',
      ),
    );
    await writeFile(
      join(directory, "metadata-loss.xlsx"),
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    const read = body(
      await handlers.read_sheet({
        filePath: "metadata-loss.xlsx",
        includeHyperlinks: true,
      }),
    );
    expect(read.values).toEqual([["x".repeat(512), 1]]);
    expect(read.cellNotes).toMatchObject({
      A2: { kind: "hyperlink", truncatedFrom: 603 },
    });
    expect(
      body(
        await handlers.find_in_sheet({
          filePath: "metadata-loss.xlsx",
          query: "xxx",
        }),
      ).total,
    ).toBe(1);
    const images = body(
      await handlers.get_images({ filePath: "metadata-loss.xlsx" }),
    );
    expect(images).toMatchObject({ complete: false, count: 1 });
    const anchored = images.images as readonly Record<string, unknown>[];
    expect(anchored[0]).toMatchObject({ anchor: "absolute" });
    expect(anchored[0]?.["range"]).toBeUndefined();
    expect(images.limitations).toEqual([]);
    const formats = body(
      await handlers.get_conditional_formats({
        filePath: "metadata-loss.xlsx",
      }),
    );
    expect(formats.complete).toBe(false);
    expect(formats.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          thresholds: [{ type: "formula", formula: "$A$1" }, { type: "max" }],
        }),
      ]),
    );
    const description = body(
      await handlers.describe_workbook({ filePath: "metadata-loss.xlsx" }),
    );
    expect(description.definedNamesComplete).toBe(false);
    expect(JSON.stringify(description.limitations)).toContain("EXCEL-META-025");
  });
  it("retains formula and hyperlink truncation facts (#21)", () => {
    for (const valueMode of ["values", "both"] as const) {
      const result = normalizeCell(
        {
          merged: false,
          value: { value: null },
          formula: "A1",
          cached: { value: "x".repeat(900) },
        },
        { valueMode, mergePolicy: "master", includeHyperlinks: true },
      );
      expect(result.note).toMatchObject(
        valueMode === "both"
          ? { kind: "formula", truncatedFrom: 900 }
          : { kind: "truncated", length: 900 },
      );
    }
    expect(
      normalizeCell(
        {
          merged: false,
          value: { value: "x".repeat(900), href: "https://example.com" },
        },
        { valueMode: "values", mergePolicy: "master", includeHyperlinks: true },
      ).note,
    ).toMatchObject({ kind: "hyperlink", truncatedFrom: 900 });
  });
  it("keeps letter mode independent from duplicate headers (#13)", () => {
    const index = buildColumnIndex(
      "sheet",
      { top: 1, bottom: 3, left: 1, right: 3 },
      1,
      ["bad", "bad", "A"],
    );
    expect(resolveColumn(index, "A", "letter")).toBe(1);
    expect(() => resolveColumn(index, "bad", "letter")).toThrow(
      expect.objectContaining({ code: "unknown_column" }),
    );
  });
  it("preserves missing middle table-column positions through get_tables (#20)", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("T");
    sheet.addTable({
      name: "T",
      ref: "A1",
      headerRow: true,
      columns: [{ name: "one" }, { name: "two" }, { name: "three" }],
      rows: [[1, 2, 3]],
    });
    const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
    const tableXml = await zip.file("xl/tables/table1.xml")!.async("string");
    expect(tableXml).toContain('name="two"');
    zip.file("xl/tables/table1.xml", tableXml.replace(' name="two"', ""));
    await writeFile(
      join(directory, "missing-table-column.xlsx"),
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    const report = body(
      await handlers.get_tables({
        filePath: "missing-table-column.xlsx",
        sheetName: "T",
      }),
    );
    expect(report).toMatchObject({
      tables: [
        {
          columns: [
            { name: "one", letter: "A" },
            { name: null, letter: "B" },
            { name: "three", letter: "C" },
          ],
        },
      ],
      warnings: [expect.stringContaining("missing column names")],
    });
    const parsed = parseSheetJs(
      await readFile(join(directory, "missing-table-column.xlsx")),
      "missing-table-column.xlsx",
    );
    expect(declaredTablesOf(parsed.tables.get("T") ?? [])[0]?.columns).toEqual([
      "one",
      null,
      "three",
    ]);
  });
  it("counts validations exactly however many cells they cover (#24)", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("V");
    sheet.getCell("A1").value = "seed";
    for (let row = 1; row <= 5001; row += 1)
      sheet.getCell(`A${row}`).dataValidation = {
        type: "whole",
        operator: "between",
        formulae: [1, 9],
      };
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const report = collectValidations(
      "V",
      parseSheetJs(bytes, "v.xlsx").validations.get("V"),
    );
    expect(report.count).toBe(1);
    expect(report.coveredCellCount).toBe(5001);
    expect(report.rangesTruncated).toBe(false);
  });
  it("reports all errorStyle variants through the handler (#11)", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("V");
    for (const [index, errorStyle] of [
      "stop",
      "warning",
      "information",
    ].entries())
      sheet.getCell(`A${index + 1}`).dataValidation = {
        type: "whole",
        operator: "between",
        formulae: [1, 9],
        showErrorMessage: true,
        errorStyle,
      };
    await book.xlsx.writeFile(join(directory, "styles.xlsx"));
    const result = body(
      await handlers.get_data_validations({ filePath: "styles.xlsx" }),
    );
    expect(JSON.stringify(result)).toContain('"errorStyle":"stop"');
    expect(JSON.stringify(result)).toContain('"errorStyle":"warning"');
    expect(JSON.stringify(result)).toContain('"errorStyle":"information"');
  });
  it("uses independent serial date oracles for 1900/1904 (#35)", async () => {
    for (const date1904 of [false, true]) {
      const name = `date-${date1904 ? 1904 : 1900}.xlsx`;
      const book = new ExcelJS.Workbook();
      book.properties.date1904 = date1904;
      const sheet = book.addWorksheet("Dates");
      sheet.addRow(["date", "datetime"]);
      sheet.addRow([
        new Date("2024-01-01T00:00:00.000Z"),
        new Date("2024-01-01T12:00:00.000Z"),
      ]);
      sheet.getCell("A2").numFmt = "yyyy-mm-dd";
      sheet.getCell("B2").numFmt = "yyyy-mm-dd hh:mm:ss";
      await book.xlsx.writeFile(join(directory, name));
      const zip = await JSZip.loadAsync(await readFile(join(directory, name)));
      const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
      expect(xml).toContain(`<v>${date1904 ? 43830 : 45292}</v>`);
      expect(xml).toContain(`<v>${date1904 ? 43830.5 : 45292.5}</v>`);
      expect(
        (await zip.file("xl/workbook.xml")!.async("string")).includes(
          'date1904="1"',
        ),
      ).toBe(date1904);
      expect(
        body(await handlers.describe_workbook({ filePath: name })).dateSystem,
      ).toBe(date1904 ? "1904" : "1900");
      expect(
        body(await handlers.read_sheet({ filePath: name })).values,
      ).toEqual([["2024-01-01", "2024-01-01T12:00:00.000Z"]]);
    }
  });
});
