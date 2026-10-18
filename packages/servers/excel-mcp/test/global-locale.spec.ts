import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readDateText } from "../src/grid/date-text.js";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";

const answerSchema = z.object({ rows: z.array(z.array(z.number())) });

describe("explicit global column readings through MCP", () => {
  let root: string;
  let client: Client;
  let server: ReturnType<typeof createExcelMcpServer>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "excel-global-locale-"));
    await Promise.all([
      writeFile(join(root, "arabic.csv"), 'Amount\n"١٬٢٣٤٫٥٠"\n'),
      writeFile(join(root, "indian.csv"), 'Amount\n"12,34,567.75"\n'),
      writeFile(join(root, "french.csv"), "Date\n13 février 2026\n"),
    ]);
    server = createExcelMcpServer(await createWorkbookRoot(root));
    client = new Client({ name: "global-locale-spec", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    {
      filePath: "arabic.csv",
      locale: "ar-EG",
      numberingSystem: "arab",
      expected: 1234.5,
    },
    {
      filePath: "indian.csv",
      locale: "hi-IN",
      numberingSystem: "latn",
      expected: 1234567.75,
    },
  ])("sums $filePath with its explicit locale", async (input) => {
    const answer = await client.callTool({
      name: "aggregate_sheet",
      arguments: {
        filePath: input.filePath,
        delimiter: "comma",
        headerRow: 1,
        columns: [
          {
            column: "Amount",
            type: "number",
            locale: input.locale,
            numberingSystem: input.numberingSystem,
          },
        ],
        metrics: [{ fn: "sum", column: "Amount" }],
      },
    });
    const block = answer.content[0];
    expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
    if (block?.type !== "text") throw new Error("Expected an MCP text result.");
    expect(answerSchema.parse(JSON.parse(block.text)).rows).toEqual([
      [input.expected],
    ]);
  });

  it("filters a French month name with an explicit Gregorian format", async () => {
    const answer = await client.callTool({
      name: "aggregate_sheet",
      arguments: {
        filePath: "french.csv",
        delimiter: "comma",
        headerRow: 1,
        columns: [
          {
            column: "Date",
            type: "date",
            format: "d MMMM yyyy",
            locale: "fr-FR",
          },
        ],
        where: [{ column: "Date", op: "eq", value: "2026-02-13" }],
        metrics: [{ fn: "count" }],
      },
    });
    const block = answer.content[0];
    expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
    if (block?.type !== "text") throw new Error("Expected an MCP text result.");
    expect(answerSchema.parse(JSON.parse(block.text)).rows).toEqual([[1]]);
  });
});

it.each(["+99:99", "+24:00", "-00:60"])(
  "refuses an impossible ISO offset %s",
  (offset) => {
    expect(readDateText(`2026-02-13T12:30:00${offset}`, "dmy")).toEqual({
      kind: "text",
    });
  },
);
