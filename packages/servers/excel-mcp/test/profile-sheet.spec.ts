import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  toolDefinitions,
  type ToolHandlers,
} from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

let directory: string;
let handlers: ToolHandlers;

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return JSON.parse(content.text) as Record<string, unknown>;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-profile-"));
  handlers = createHandlers(await createWorkbookRoot(directory));
  await writeFile(
    join(directory, "profile.csv"),
    [
      "Id;Amount;Date;Flag;Clock;Missing;Name",
      "00123;1.234,50;31.01.2024;Evet;09:30;NULL;東京",
      "00456;2.000,00;29.02.2024;Hayır;01:30:00;N/A;München",
      "00789;N/A;15.03.2024;Evet;12:00:30;—;東京",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "late-identifiers.csv"),
    ["Amount", "10.50", "20.25", "00123", "9999999999999999999"].join("\n"),
  );
  await Promise.all([
    writeFile(
      join(directory, "distinct.csv"),
      [
        "Key",
        ...Array.from({ length: 1001 }, (_, at) => `K-${at}`),
        ...Array.from({ length: 30 }, () => "untracked frequent value"),
      ].join("\n"),
    ),
    writeFile(
      join(directory, "wide.csv"),
      [
        Array.from({ length: 65 }, (_, at) => `Value_${at}`).join(";"),
        ...Array.from({ length: 1005 }, () =>
          Array.from({ length: 65 }, (_, at) => at + 10).join(";"),
        ),
      ].join("\n"),
    ),
    writeFile(
      join(directory, "mixed.csv"),
      [
        "Value",
        "10",
        "20",
        "30",
        `${"X".repeat(1000)}A`,
        `${"X".repeat(1000)}B`,
      ].join("\n"),
    ),
    writeFile(
      join(directory, "ambiguous.csv"),
      "Date;Amount\n01/02/2024;1,234\n03/04/2024;2,345",
    ),
    writeFile(
      join(directory, "custom.csv"),
      "Amount;Flag\n999;activo\n15;inactivo\n20;ausente",
    ),
    writeFile(join(directory, "arabic.csv"), "Amount\n١٬٢٣٤٫٥٠\n٢٬٠٠٠٫٠٠"),
    writeFile(
      join(directory, "german-date.csv"),
      "Date;Amount\n31 Januar 2024;10\n29 Februar 2024;20",
    ),
    writeFile(
      join(directory, "temporal.csv"),
      "Clock;Elapsed\n09:30;25:00:00\n01:30:00;01:30:00",
    ),
  ]);
  const workbook = new ExcelJS.Workbook();
  const sparse = workbook.addWorksheet("Sparse");
  sparse.addRow(["Amount", "Flag", "Formula", "NativeError"]);
  sparse.addRow([10, true, { formula: "1+1" }, { error: "#N/A" }]);
  sparse.getCell("A4").value = 20;
  sparse.getCell("B4").value = false;
  sparse.getCell("C4").value = { formula: "2+3", result: 5 };
  sparse.getCell("D4").value = { error: "#DIV/0!" };
  workbook.addWorksheet("Colliding").addRows([
    ["B", "B", "Amount"],
    ["001", "002", "12.50"],
  ]);
  const table = workbook.addWorksheet("Table");
  table.addTable({
    name: "ProfileRows",
    ref: "B3",
    headerRow: true,
    columns: [{ name: "Region" }, { name: "Amount" }],
    rows: [
      ["West", 10],
      ["East", 20],
    ],
  });
  workbook.addWorksheet("HeaderOnly").addRow(["First", "Second"]);
  const merged = workbook.addWorksheet("Merged");
  merged.addRows([["Label"], ["Group One"], [], ["Group Two"]]);
  merged.mergeCells("A2:A3");
  await workbook.xlsx.writeFile(join(directory, "profiles.xlsx"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("bounded column profiling", () => {
  it("profiles numeric, date, boolean, time, missing and identifier text in one call", async () => {
    const result = await handlers.profile_sheet({ filePath: "profile.csv" });
    const profile = body(result);
    expect(result.isError).not.toBe(true);
    expect(profile).toMatchObject({
      columnMode: "letter",
      totalRows: 3,
      sampledRows: 3,
      omittedRows: 0,
      omittedColumns: 0,
      headerRow: 1,
    });
    expect(profile["profiles"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          letter: "A",
          inferredType: "text",
          identifiers: expect.objectContaining({
            likely: true,
            leadingZeros: true,
            fixedLength: 5,
          }),
        }),
        expect.objectContaining({
          letter: "B",
          inferredType: "number",
          confidence: 1,
          missing: 1,
          missingRatio: 1 / 3,
          min: 1234.5,
          max: 2000,
          distinct: { count: 2, exact: true },
        }),
        expect.objectContaining({
          letter: "C",
          inferredType: "date",
          min: "2024-01-31",
          max: "2024-03-15",
        }),
        expect.objectContaining({
          letter: "D",
          inferredType: "boolean",
          topValues: [
            { value: true, count: 2 },
            { value: false, count: 1 },
          ],
        }),
        expect.objectContaining({ letter: "E", inferredType: "time" }),
        expect.objectContaining({
          letter: "F",
          inferredType: "empty",
          missing: 3,
          confidence: 0,
        }),
      ]),
    );
    expect(profile["columns"]).toEqual(
      expect.arrayContaining([
        { column: "A", type: "text" },
        {
          column: "B",
          type: "number",
          decimal: ",",
          group: ".",
          identifiers: "refuse",
        },
      ]),
    );
  });

  it("keeps identifiers after the sampled prefix out of totals when profile columns are reused", async () => {
    const profile = body(
      await handlers.profile_sheet({
        filePath: "late-identifiers.csv",
        maxRows: 2,
      }),
    );
    expect(profile).toMatchObject({
      sampledRows: 2,
      totalRows: 4,
      omittedRows: 2,
    });
    expect(profile["columns"]).toEqual([
      expect.objectContaining({
        column: "A",
        type: "number",
        identifiers: "refuse",
      }),
    ]);
    const request = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "late-identifiers.csv",
      columns: profile["columns"],
      columnMode: profile["columnMode"],
      metrics: [{ fn: "sum", column: "A" }],
    });
    const result = await handlers.aggregate_sheet(request);
    expect(result.isError).not.toBe(true);
    expect(body(result)["rows"]).toEqual([[30.75]]);
    expect(body(result)["warnings"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("2 cells look like identifiers"),
      ]),
    );
  });

  it("reports a distinct lower bound and omits rankings after the tracking cap", async () => {
    const profile = body(
      await handlers.profile_sheet({
        filePath: "distinct.csv",
        maxRows: 2000,
      }),
    );
    expect(profile).toMatchObject({
      sampledRows: 1031,
      profiles: [
        expect.objectContaining({
          distinct: { lowerBound: 1001, exact: false },
          topValues: [],
          topValuesComplete: false,
        }),
      ],
    });
  });

  it("bounds rectangular samples by cells and produces 64 reusable column specifications", async () => {
    const profile = body(
      await handlers.profile_sheet({
        filePath: "wide.csv",
        maxRows: 5000,
        maxColumns: 64,
      }),
    );
    expect(profile).toMatchObject({
      totalRows: 1005,
      sampledRows: 1000,
      omittedRows: 5,
      totalColumns: 65,
      sampledColumns: 64,
      omittedColumns: 1,
      sampledCells: 64000,
      samplingLimit: "maxProfileCells",
    });
    expect(profile["columns"]).toHaveLength(64);
    const request = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "wide.csv",
      columns: profile["columns"],
      columnMode: profile["columnMode"],
      metrics: [{ fn: "sum", column: "A" }],
    });
    expect(body(await handlers.aggregate_sheet(request))["rows"]).toEqual([
      [10050],
    ]);
  });

  it("counts blank physical rows and uncached formulas without treating native errors as missing tokens", async () => {
    const profile = body(
      await handlers.profile_sheet({
        filePath: "profiles.xlsx",
        sheetName: "Sparse",
      }),
    );
    expect(profile).toMatchObject({
      totalRows: 3,
      sampledRows: 3,
      sampledCells: 12,
    });
    expect(profile["profiles"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          letter: "A",
          missing: 1,
          min: 10,
          max: 20,
          confidence: 1,
        }),
        expect.objectContaining({
          letter: "C",
          missing: 2,
          uncachedFormulas: 1,
          min: 5,
          max: 5,
        }),
        expect.objectContaining({
          letter: "D",
          missing: 1,
          inferredType: "error",
          distinct: { count: 2, exact: true },
        }),
      ]),
    );
  });

  it("uses stable letters when header labels duplicate or collide with letters", async () => {
    const profile = body(
      await handlers.profile_sheet({
        filePath: "profiles.xlsx",
        sheetName: "Colliding",
      }),
    );
    expect(profile["columnMode"]).toBe("letter");
    const request = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "profiles.xlsx",
      sheetName: "Colliding",
      columns: profile["columns"],
      columnMode: profile["columnMode"],
      metrics: [{ fn: "sum", column: "C" }],
    });
    expect(body(await handlers.aggregate_sheet(request))["rows"]).toEqual([
      [12.5],
    ]);
  });

  it("keeps full values distinct while clipping unreadable examples", async () => {
    const profile = body(
      await handlers.profile_sheet({ filePath: "mixed.csv" }),
    );
    expect(profile["profiles"]).toEqual([
      expect.objectContaining({
        inferredType: "number",
        confidence: 3 / 5,
        min: 10,
        max: 30,
        distinct: { count: 5, exact: true },
        valuesTruncated: true,
        unreadable: {
          count: 2,
          examples: [
            { value: "X".repeat(160), truncatedFrom: 1001 },
            { value: "X".repeat(160), truncatedFrom: 1001 },
          ],
        },
      }),
    ]);
  });

  it("keeps unresolved numeric separators and date orders mixed", async () => {
    const profile = body(
      await handlers.profile_sheet({ filePath: "ambiguous.csv" }),
    );
    expect(profile["profiles"]).toEqual([
      expect.objectContaining({ inferredType: "mixed", confidence: 0 }),
      expect.objectContaining({ inferredType: "mixed", confidence: 0 }),
    ]);
    expect(profile["columns"]).toEqual([
      { column: "A", type: "text" },
      { column: "B", type: "text" },
    ]);
  });

  it("carries custom missing and boolean vocabulary into the reusable recipe", async () => {
    const profile = body(
      await handlers.profile_sheet({
        filePath: "custom.csv",
        missingValues: ["999", "ausente"],
        trueValues: ["activo"],
        falseValues: ["inactivo"],
      }),
    );
    expect(profile["columns"]).toEqual([
      expect.objectContaining({
        column: "A",
        type: "number",
        missingValues: ["999", "ausente"],
      }),
      {
        column: "B",
        type: "boolean",
        missingValues: ["999", "ausente"],
        trueValues: ["activo"],
        falseValues: ["inactivo"],
      },
    ]);
    const request = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "custom.csv",
      columns: profile["columns"],
      columnMode: profile["columnMode"],
      metrics: [{ fn: "sum", column: "A" }],
    });
    expect(body(await handlers.aggregate_sheet(request))["rows"]).toEqual([
      [35],
    ]);
  });

  it("returns valid locale number recipes without mixing display separators into them", async () => {
    const profile = body(
      await handlers.profile_sheet({ filePath: "arabic.csv", locale: "ar-EG" }),
    );
    expect(profile["columns"]).toEqual([
      {
        column: "A",
        type: "number",
        locale: "ar-EG",
        numberingSystem: "arab",
        identifiers: "refuse",
      },
    ]);
    const request = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "arabic.csv",
      columns: profile["columns"],
      columnMode: profile["columnMode"],
      metrics: [{ fn: "sum", column: "A" }],
    });
    expect(body(await handlers.aggregate_sheet(request))["rows"]).toEqual([
      [3234.5],
    ]);
  });

  it("preserves localized month interpretation when date recipes are reused", async () => {
    const profile = body(
      await handlers.profile_sheet({
        filePath: "german-date.csv",
        locale: "de-DE",
      }),
    );
    expect(profile["columns"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "A", type: "date", locale: "de-DE" }),
      ]),
    );
    const request = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "german-date.csv",
      columns: profile["columns"],
      columnMode: profile["columnMode"],
      groupBy: [{ column: "A", by: "month" }],
      metrics: [{ fn: "sum", column: "B" }],
    });
    expect(body(await handlers.aggregate_sheet(request))["rows"]).toEqual([
      ["2024-01", 10],
      ["2024-02", 20],
    ]);
  });

  it.each([undefined, "tr-TR"])(
    "reuses unambiguous mixed date separators without imposing an order under locale %s",
    async (locale) => {
      const filePath = `date-recipe-unambiguous-${locale ?? "default"}.csv`;
      await writeFile(
        join(directory, filePath),
        "Date,Amount\n04/13/2026,10\n03.04.2026,20",
      );
      const language = locale === undefined ? {} : { locale };
      const profile = body(
        await handlers.profile_sheet({ filePath, ...language }),
      );
      expect(profile["columns"]).toEqual(
        expect.arrayContaining([{ column: "A", type: "date", ...language }]),
      );
      expect(profile["profiles"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            letter: "A",
            min: "2026-04-03",
            max: "2026-04-13",
            readAs: [{ type: "date", ...language }],
          }),
        ]),
      );
      const request = toolDefinitions.aggregate_sheet.inputSchema.parse({
        filePath,
        columns: profile["columns"],
        columnMode: profile["columnMode"],
        groupBy: [{ column: "A", by: "month" }],
        metrics: [{ fn: "sum", column: "B" }],
      });
      expect(body(await handlers.aggregate_sheet(request))["rows"]).toEqual([
        ["2026-04", 30],
      ]);
    },
  );

  it.each([undefined, "tr-TR"])(
    "keeps an unrepresentable date mixture as text with a truthful recipe warning under locale %s",
    async (locale) => {
      const filePath = `date-recipe-mixed-${locale ?? "default"}.csv`;
      await writeFile(
        join(directory, filePath),
        "Date,Amount\n04/13/2026,10\n03/04/2026,20\n03.04.2026,30",
      );
      const profile = body(
        await handlers.profile_sheet({
          filePath,
          ...(locale === undefined ? {} : { locale }),
        }),
      );
      expect(profile["columns"]).toEqual(
        expect.arrayContaining([{ column: "A", type: "text" }]),
      );
      expect(profile["profiles"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            letter: "A",
            inferredType: "date",
            readAs: [],
            warnings: expect.arrayContaining([
              expect.stringContaining("reusable date"),
            ]),
          }),
        ]),
      );
      const request = toolDefinitions.read_sheet.inputSchema.parse({
        filePath,
        columns: profile["columns"],
        columnMode: profile["columnMode"],
        includeTyped: true,
      });
      const read = body(await handlers.read_sheet(request));
      expect(read["values"]).toEqual([
        ["04/13/2026", "10"],
        ["03/04/2026", "20"],
        ["03.04.2026", "30"],
      ]);
      expect(read["typedValues"]).toEqual([
        ["04/13/2026", 10],
        ["03/04/2026", 20],
        ["03.04.2026", 30],
      ]);
    },
  );

  it.each([
    { separator: "/", format: "M/d/yyyy", filePath: "date-recipe-slash.csv" },
    { separator: "-", format: "M-d-yyyy", filePath: "date-recipe-dash.csv" },
  ])(
    "reuses a sampled $format recipe without changing a later dotted date",
    async ({ separator, format, filePath }) => {
      const first = `4${separator}13${separator}2026`;
      const second = `03${separator}04${separator}2026`;
      await writeFile(
        join(directory, filePath),
        `Date,Amount\n${first},10\n${second},20\n03.04.2026,30`,
      );
      const profile = body(
        await handlers.profile_sheet({ filePath, maxRows: 2 }),
      );
      expect(profile["columns"]).toEqual(
        expect.arrayContaining([{ column: "A", type: "date", format }]),
      );
      expect(profile["profiles"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            letter: "A",
            readAs: [{ type: "date", format }],
          }),
        ]),
      );
      const interpretation = {
        filePath,
        columns: profile["columns"],
        columnMode: profile["columnMode"],
      };
      const read = body(
        await handlers.read_sheet(
          toolDefinitions.read_sheet.inputSchema.parse({
            ...interpretation,
            includeTyped: true,
          }),
        ),
      );
      expect(read["values"]).toEqual([
        [first, "10"],
        [second, "20"],
        ["03.04.2026", "30"],
      ]);
      expect(read["typedValues"]).toEqual([
        ["2026-04-13", 10],
        ["2026-03-04", 20],
        [null, 30],
      ]);
      expect(read["typed"]).toMatchObject({
        columns: expect.arrayContaining([
          expect.objectContaining({
            column: "A",
            converted: 2,
            unreadable: 1,
            examples: [
              { cell: "A4", value: "03.04.2026", reason: "unreadable" },
            ],
          }),
        ]),
      });
      const aggregate = body(
        await handlers.aggregate_sheet(
          toolDefinitions.aggregate_sheet.inputSchema.parse({
            ...interpretation,
            groupBy: [{ column: "A", by: "month" }],
            metrics: [{ fn: "sum", column: "B" }],
          }),
        ),
      );
      expect(aggregate["rows"]).toEqual([
        ["2026-03", 20],
        ["2026-04", 10],
      ]);
      expect(aggregate["ungroupedRows"]).toBe(1);
    },
  );

  it("reports requested-date failures while retaining the observed text majority", async () => {
    const filePath = "date-recipe-explicit-invalid.csv";
    await writeFile(
      join(directory, filePath),
      "Date\n13.03.2026\n29.02.2026\n31.04.2026",
    );
    const explicit = {
      column: "Date",
      type: "date",
      format: "dd.MM.yyyy",
    };
    const profile = body(
      await handlers.profile_sheet(
        toolDefinitions.profile_sheet.inputSchema.parse({
          filePath,
          columns: [explicit],
        }),
      ),
    );
    expect(profile["columns"]).toEqual([{ ...explicit, column: "A" }]);
    expect(profile["profiles"]).toEqual([
      expect.objectContaining({
        inferredType: "text",
        confidence: 2 / 3,
        missing: 0,
        distinct: { count: 3, exact: true },
        min: "29.02.2026",
        max: "31.04.2026",
        topValues: [
          { value: "2026-03-13", count: 1 },
          { value: "29.02.2026", count: 1 },
          { value: "31.04.2026", count: 1 },
        ],
        unreadable: {
          count: 2,
          examples: [{ value: "29.02.2026" }, { value: "31.04.2026" }],
        },
        readAs: [{ type: "date", format: "dd.MM.yyyy" }],
      }),
    ]);
    const read = body(
      await handlers.read_sheet(
        toolDefinitions.read_sheet.inputSchema.parse({
          filePath,
          columns: profile["columns"],
          columnMode: profile["columnMode"],
          includeTyped: true,
        }),
      ),
    );
    expect(read["values"]).toEqual([
      ["13.03.2026"],
      ["29.02.2026"],
      ["31.04.2026"],
    ]);
    expect(read["typedValues"]).toEqual([["2026-03-13"], [null], [null]]);
    expect(read["typed"]).toMatchObject({
      columns: [
        {
          type: "date",
          readAs: [{ type: "date", format: "dd.MM.yyyy" }],
          converted: 1,
          missing: 0,
          unreadable: 2,
        },
      ],
    });
  });

  it.each([
    { name: "order", interpretation: { order: "mdy" as const } },
    { name: "format", interpretation: { format: "M.d.yyyy" } },
  ])(
    "preserves a caller's explicit date $name on dotted text",
    async ({ name, interpretation }) => {
      const filePath = `date-recipe-explicit-${name}.csv`;
      await writeFile(
        join(directory, filePath),
        "Date,Amount\n04.13.2026,10\n03.04.2026,20\nabsent,30",
      );
      const explicit = {
        column: "Date",
        type: "date",
        ...interpretation,
        locale: "tr-TR",
        missingValues: ["absent"],
      };
      const profile = body(
        await handlers.profile_sheet(
          toolDefinitions.profile_sheet.inputSchema.parse({
            filePath,
            columns: [explicit],
          }),
        ),
      );
      expect(profile["columns"]).toEqual(
        expect.arrayContaining([{ ...explicit, column: "A" }]),
      );
      const read = body(
        await handlers.read_sheet(
          toolDefinitions.read_sheet.inputSchema.parse({
            filePath,
            columns: profile["columns"],
            columnMode: profile["columnMode"],
            includeTyped: true,
          }),
        ),
      );
      expect(read["typedValues"]).toEqual([
        ["2026-04-13", 10],
        ["2026-03-04", 20],
        [null, 30],
      ]);
    },
  );

  it("distinguishes clocks from elapsed duration evidence", async () => {
    const profile = body(
      await handlers.profile_sheet({ filePath: "temporal.csv" }),
    );
    expect(profile["profiles"]).toEqual([
      expect.objectContaining({
        inferredType: "time",
        min: "01:30:00",
        max: "09:30:00",
      }),
      expect.objectContaining({
        inferredType: "duration",
        min: { durationSeconds: 5400 },
        max: { durationSeconds: 90000 },
      }),
    ]);
    expect(profile["columns"]).toEqual([
      { column: "A", type: "time" },
      { column: "B", type: "duration" },
    ]);
  });

  it("shares declared table headers and represents a header-only range without invented samples", async () => {
    const table = body(
      await handlers.profile_sheet({
        filePath: "profiles.xlsx",
        sheetName: "Table",
        range: "B3:C5",
        headerScan: true,
      }),
    );
    expect(table).toMatchObject({
      headerRow: 3,
      headerRowSource: "declared",
      sampledRows: 2,
    });
    const empty = body(
      await handlers.profile_sheet({
        filePath: "profiles.xlsx",
        sheetName: "HeaderOnly",
      }),
    );
    expect(empty["sampledRows"]).toBe(0);
    expect(empty["profiles"]).toEqual([
      expect.objectContaining({
        inferredType: "empty",
        confidence: 0,
        missingRatio: 0,
        distinct: { count: 0, exact: true },
      }),
      expect.objectContaining({
        inferredType: "empty",
        confidence: 0,
        missingRatio: 0,
        distinct: { count: 0, exact: true },
      }),
    ]);
  });

  it("honors the shared merged-cell policy in frequencies and missing ratios", async () => {
    const master = body(
      await handlers.profile_sheet({
        filePath: "profiles.xlsx",
        sheetName: "Merged",
      }),
    );
    const repeat = body(
      await handlers.profile_sheet({
        filePath: "profiles.xlsx",
        sheetName: "Merged",
        mergedCells: "repeat",
      }),
    );
    expect(master["profiles"]).toEqual([
      expect.objectContaining({ missing: 1 }),
    ]);
    expect(repeat["profiles"]).toEqual([
      expect.objectContaining({
        missing: 0,
        topValues: [
          { value: "Group One", count: 2 },
          { value: "Group Two", count: 1 },
        ],
      }),
    ]);
  });
});
