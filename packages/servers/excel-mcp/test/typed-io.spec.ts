import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";

const columns = [
  { column: "A", type: "text" },
  {
    column: "B",
    type: "number",
    decimal: ",",
    group: ".",
    identifiers: "refuse",
  },
  { column: "C", type: "date", format: "dd.MM.yyyy" },
  { column: "D", type: "boolean" },
  { column: "E", type: "time" },
  { column: "F", type: "duration" },
];

let directory: string;
let client: Client;
let server: ReturnType<typeof createExcelMcpServer>;

async function request(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({
    name,
    arguments: { filePath: "typed.csv", ...args },
  });
  const content = response.content[0];
  if (content?.type !== "text") throw new Error("Missing text response");
  return {
    ...(JSON.parse(content.text) as Record<string, unknown>),
    isError: response.isError === true,
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-typed-io-"));
  await writeFile(
    join(directory, "typed.csv"),
    [
      "Code;Amount;Date;Active;Clock;Elapsed",
      "00123;1.234,50;31.01.2026;Evet;8:15;25:30",
      "00456;N/A;29.02.2026;Hayır;00:00:00;PT2H",
      "00789;00123;02.02.2026;perhaps;99:99;P1M",
    ].join("\n"),
  );
  server = createExcelMcpServer(await createWorkbookRoot(directory));
  client = new Client({ name: "typed-io-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
});

afterAll(async () => {
  await client.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

describe("shared columns across reading and searching", () => {
  it("preserves raw values and adds typed values with reproducible cursor options", async () => {
    const first = await request("read_sheet", {
      columns,
      columnMode: "letter",
      includeTyped: true,
      maxCells: 6,
    });
    expect(first["isError"]).toBe(false);
    expect(first["values"]).toEqual([
      ["00123", "1.234,50", "31.01.2026", "Evet", "8:15", "25:30"],
    ]);
    expect(first["typedValues"]).toEqual([
      [
        "00123",
        1234.5,
        "2026-01-31",
        true,
        "08:15:00",
        { durationSeconds: 91800 },
      ],
    ]);
    expect(typeof first["nextCursor"]).toBe("string");
    const second = await request("read_sheet", {
      cursor: first["nextCursor"],
      maxCells: 6,
      columns: JSON.parse(JSON.stringify(columns)),
    });
    expect(second["isError"]).toBe(false);
    expect(second["typedValues"]).toEqual([
      ["00456", null, null, false, "00:00:00", { durationSeconds: 7200 }],
    ]);
    expect(second["typed"]).toMatchObject({
      scope: "returnedRows",
      columns: expect.arrayContaining([
        expect.objectContaining({ column: "B", missing: 1, unreadable: 0 }),
        expect.objectContaining({ column: "C", unreadable: 1 }),
      ]),
    });
    const conflicting = await request("read_sheet", {
      cursor: first["nextCursor"],
      columns: [{ column: "B", type: "number", decimal: "." }],
    });
    expect(conflicting["isError"]).toBe(true);
  });

  it("searches an explicit canonical number and returns both representations", async () => {
    const result = await request("find_in_sheet", {
      query: "1234.5",
      matchMode: "exact",
      columns,
      columnMode: "letter",
    });
    expect(result["isError"]).toBe(false);
    expect(result["total"]).toBe(1);
    expect(result["matches"]).toEqual([
      {
        address: "B2",
        row: 2,
        column: 2,
        value: "1.234,50",
        typedValue: 1234.5,
      },
    ]);
    expect(result["typed"]).toMatchObject({
      scope: "scannedCells",
      columns: expect.arrayContaining([
        expect.objectContaining({
          column: "B",
          missing: 1,
          unreadable: 1,
          identifiers: 1,
        }),
        expect.objectContaining({ column: "D", unreadable: 1 }),
      ]),
    });
  });

  it("does not infer or rewrite default reads and searches", async () => {
    expect((await request("read_sheet", {}))["typedValues"]).toBeUndefined();
    expect(
      (await request("find_in_sheet", { query: "N/A", matchMode: "exact" }))[
        "total"
      ],
    ).toBe(1);
  });

  it("refuses typed output without a stable column plan", async () => {
    expect(
      (await request("read_sheet", { includeTyped: true }))["isError"],
    ).toBe(true);
  });
});
