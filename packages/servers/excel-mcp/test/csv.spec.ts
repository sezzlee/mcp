import { describe, expect, inject, it } from "vitest";
import {
  loadDocument,
  sheetSource,
  type LoadedCsv,
} from "../src/format/document.js";
import type { SezzleeExcelError } from "../src/platform/errors.js";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
} from "../src/platform/paths.js";
import { readSheet, type ReadSheetOptions } from "../src/grid/read-sheet.js";
import { parseCsv } from "../src/format/csv.js";

const base: ReadSheetOptions = {
  maxCells: 2000,
  valueMode: "values",
  mergedCells: "master",
  headerRow: 1,
  headerRowSource: "default",
  includeHyperlinks: false,
};

async function open(
  name: string,
  options:
    { delimiter?: never; encoding?: never } | Record<string, unknown> = {},
): Promise<LoadedCsv> {
  const fixtures = inject("fixtures");
  const root = await createWorkbookRoot(fixtures.root);
  const loaded = await loadDocument(
    await resolveWorkbookPath(root, `csv/${name}`),
    options,
  );
  if (loaded.format !== "csv") {
    throw new Error("expected a csv fixture");
  }
  return loaded;
}

async function codeOf(
  action: () => Promise<unknown> | unknown,
): Promise<string> {
  try {
    await action();
  } catch (error) {
    return (error as SezzleeExcelError).code;
  }
  return "no-error";
}

async function openSource(
  name: string,
  options:
    { delimiter?: never; encoding?: never } | Record<string, unknown> = {},
) {
  return sheetSource(await open(name, options));
}

describe("no type inference", () => {
  it("keeps every field a string", async () => {
    const result = readSheet(await openSource("simple.csv"), base);
    expect(result.values[0]).toEqual([
      "03-04-2024",
      "01234",
      "007",
      "true",
      "#N/A",
    ]);
    expect(result.values[1]?.[2]).toBe("1e5");
  });

  it("reports no number formats", async () => {
    const result = readSheet(await openSource("simple.csv"), base);
    expect(result.columns.every((column) => column.numberFormat === null)).toBe(
      true,
    );
    expect(result.merges).toBeUndefined();
  });
});

describe("delimiter", () => {
  it("sniffs a semicolon file and echoes the source", async () => {
    const loaded = await open("turkce.csv", { encoding: "windows-1254" });
    expect(loaded.table.report.delimiter).toBe("semicolon");
    expect(loaded.table.report.delimiterSource).toBe("sniffed");
    expect(
      readSheet(sheetSource(loaded), base).columns.map(
        (column) => column.header,
      ),
    ).toEqual(["Şehir", "İlçe", "Posta"]);
  });

  it("refuses to guess when two delimiters tie", async () => {
    expect(await codeOf(() => open("ambiguous.csv"))).toBe(
      "ambiguous_delimiter",
    );
  });

  it("accepts an explicit delimiter for the ambiguous file", async () => {
    const loaded = await open("ambiguous.csv", { delimiter: "semicolon" });
    expect(loaded.table.report.delimiterSource).toBe("explicit");
    expect(loaded.table.rows[0]).toEqual(["a", "b,c"]);
  });

  it("defaults when the delimiter is unobservable", async () => {
    const loaded = await open("single-column.csv");
    expect(loaded.table.report).toMatchObject({
      delimiter: "comma",
      delimiterSource: "default",
      columnCount: 1,
    });
  });
});

describe("encoding", () => {
  it("rejects windows-1254 bytes read as utf-8", async () => {
    expect(await codeOf(() => open("turkce.csv"))).toBe("undecodable_text");
  });

  it("decodes windows-1254 when told, and echoes the canonical label", async () => {
    const loaded = await open("turkce.csv", { encoding: "iso-8859-9" });
    expect(loaded.table.report.encoding).toBe("windows-1254");
    expect(loaded.table.report.encodingSource).toBe("explicit");
    expect(loaded.table.rows[1]?.[0]).toBe("İSTANBUL");
  });

  it("strips a byte-order mark instead of leaking it into the header", async () => {
    const loaded = await open("bom.csv");
    expect(loaded.table.report).toMatchObject({
      hadBom: true,
      encodingSource: "bom",
    });
    expect(loaded.table.rows[0]?.[0]).toBe("kod");
  });

  it("refuses an encoding that contradicts the byte-order mark", async () => {
    expect(
      await codeOf(() => open("bom.csv", { encoding: "windows-1254" })),
    ).toBe("invalid_argument");
  });

  it("refuses UTF-16 without a byte-order mark instead of returning NUL-laced text", async () => {
    expect(await codeOf(() => open("utf16.csv"))).toBe("undecodable_text");
  });

  it("decodes windows-1252 punctuation that Excel writes", async () => {
    const bytes = Buffer.from([
      0x93, 0x61, 0x94, 0x2c, 0x96, 0x2c, 0x80, 0x35, 0x2c, 0x85, 0x2c, 0x99,
    ]);
    const table = await parseCsv(
      bytes,
      bytes.length,
      { encoding: "windows-1252" },
      "punctuation.csv",
    );
    expect(table.rows).toEqual([["“a”", "–", "€5", "…", "™"]]);
  });

  it("decodes every windows-1252 byte from 0x80 to 0x9F as the WHATWG index does", async () => {
    const whatwg = [
      0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
      0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018,
      0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161,
      0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
    ];
    const bytes = Buffer.from(whatwg.map((_, index) => 0x80 + index));
    const table = await parseCsv(
      bytes,
      bytes.length,
      { encoding: "windows-1252", delimiter: "comma" },
      "high.csv",
    );
    expect(table.rows).toEqual([[String.fromCodePoint(...whatwg)]]);
  });

  it("decodes UTF-16 when told", async () => {
    const loaded = await open("utf16.csv", { encoding: "utf-16le" });
    expect(loaded.table.rows[1]).toEqual(["1", "2"]);
  });
});

describe("record shape", () => {
  it("tolerates ragged records and reports them", async () => {
    const loaded = await open("ragged.csv");
    expect(loaded.table.report.raggedRecordCount).toBe(2);
    const result = readSheet(sheetSource(loaded), { ...base, headerRow: 0 });
    expect(result.values[1]).toEqual(["1", "2", null, null]);
    expect(result.values[2]).toEqual(["3", "4", "5", "6"]);
  });

  it("treats a quoted newline as one record", async () => {
    const loaded = await open("quoted.csv");
    expect(loaded.table.report.recordCount).toBe(3);
    expect(loaded.table.rows[1]).toEqual(["iki\nsatir", 'o "dedi"']);
  });

  it("keeps blank records addressable", async () => {
    const loaded = await open("blank-lines.csv");
    expect(loaded.table.report.blankRecordCount).toBe(1);
    const result = readSheet(sheetSource(loaded), { ...base, headerRow: 0 });
    expect(result.values[2]).toEqual([null, null]);
    expect(result.values[3]).toEqual(["3", "4"]);
  });

  it("reports duplicate headers without resolving them", async () => {
    const loaded = await open("dupes.csv");
    expect(loaded.table.report.duplicateHeaders).toEqual(["tutar"]);
    expect(
      readSheet(sheetSource(loaded), base).columns.map(
        (column) => column.header,
      ),
    ).toEqual(["tutar", "ad", "tutar"]);
  });

  it("counts formula-like cells without changing them", async () => {
    const loaded = await open("formulas.csv");
    expect(loaded.table.report.formulaLikeCellCount).toBe(1);
    expect(readSheet(sheetSource(loaded), base).values[0]?.[0]).toBe(
      "=SUM(A1:A2)",
    );
  });

  it("reports the line break form", async () => {
    expect((await open("crlf.csv")).table.report.lineBreak).toBe("crlf");
    expect((await open("simple.csv")).table.report.lineBreak).toBe("lf");
  });

  it("reports the record breaks, not the line breaks inside quoted fields", async () => {
    const bytes = Buffer.from('ad,not\r\n1,"iki\nsatır"\r\n2,x\r\n');
    const table = await parseCsv(bytes, bytes.length, {}, "alt-enter.csv");
    expect(table.report.lineBreak).toBe("crlf");
  });

  it("hoists a header-only file into columns and returns no rows", async () => {
    const result = readSheet(await openSource("header-only.csv"), base);
    expect(result.columns.map((column) => column.header)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(result.values).toEqual([]);
  });

  it("treats an empty file as an empty sheet", async () => {
    const loaded = await open("empty.csv");
    expect(await codeOf(() => readSheet(sheetSource(loaded), base))).toBe(
      "empty_sheet",
    );
  });
});

describe("sheet identity", () => {
  it("names the single table 'csv'", async () => {
    expect(readSheet(await openSource("simple.csv"), base).sheet).toBe("csv");
    expect(
      readSheet(await openSource("simple.csv"), { ...base, sheetName: "csv" })
        .sheet,
    ).toBe("csv");
  });

  it("rejects any other sheet name", async () => {
    const loaded = await open("simple.csv");
    expect(
      await codeOf(() =>
        readSheet(sheetSource(loaded), { ...base, sheetName: "Sheet1" }),
      ),
    ).toBe("unknown_sheet");
  });
});

describe("pagination parity", () => {
  it("pages a csv the same way it pages a workbook", async () => {
    const loaded = await open("big.csv");
    let page = readSheet(sheetSource(loaded), { ...base, maxCells: 30 });
    expect(page.truncated).toBe(true);
    expect(page.truncationReason).toBe("maxCells");

    const seen: number[] = [];
    let guard = 0;
    while (page.nextCursor !== undefined && guard < 4) {
      for (const line of page.values) {
        seen.push(Number(line[0]));
      }
      page = readSheet(sheetSource(loaded), {
        ...base,
        cursor: page.nextCursor,
        maxCells: 30,
      });
      guard += 1;
    }
    expect(seen[0]).toBe(1);
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBe((seen[index - 1] ?? 0) + 1);
    }
  });

  it("keeps a separate cache entry per parse option", async () => {
    const first = await open("ambiguous.csv", { delimiter: "semicolon" });
    const second = await open("ambiguous.csv", { delimiter: "comma" });
    expect(first.table.rows[0]).toEqual(["a", "b,c"]);
    expect(second.table.rows[0]).toEqual(["a;b", "c"]);
  });
});
