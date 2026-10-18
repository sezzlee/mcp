import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";

/**
 * Independent byte vectors exported once with Python's standard codecs.
 * Expected Unicode text is fixed here; no production decoder builds an oracle.
 */
const vectors = [
  { encoding: "windows-1251", hex: "cff0e8e2e5f2", text: "Привет" },
  { encoding: "windows-1256", hex: "e3d1cdc8c7", text: "مرحبا" },
  { encoding: "shift_jis", hex: "93fa967b8cea", text: "日本語" },
  { encoding: "gb18030", hex: "d6d0cec49439fc36", text: "中文😀" },
  { encoding: "big5", hex: "a4a4a4e5", text: "中文" },
  { encoding: "euc-kr", hex: "c7d1b1b9beee", text: "한국어" },
];
const truncated = [
  { encoding: "shift_jis", lead: 0x93 },
  { encoding: "gb18030", lead: 0xd6 },
  { encoding: "big5", lead: 0xa4 },
  { encoding: "euc-kr", lead: 0xc7 },
];
const readSchema = z.object({
  values: z.array(z.array(z.string())),
  csv: z.object({ encoding: z.string(), encodingSource: z.string() }),
});
const errorSchema = z.object({ error: z.string() });

describe("explicit global legacy encodings through MCP", () => {
  let root: string;
  let client: Client;
  let server: ReturnType<typeof createExcelMcpServer>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "excel-global-encoding-"));
    for (const vector of vectors) {
      await writeFile(
        join(root, `${vector.encoding}.csv`),
        Buffer.concat([
          Buffer.from("Name,Id\n"),
          Buffer.from(vector.hex, "hex"),
          Buffer.from(",00123\n"),
        ]),
      );
    }
    for (const vector of truncated) {
      await writeFile(
        join(root, `truncated-${vector.encoding}.csv`),
        Buffer.from([vector.lead]),
      );
    }
    server = createExcelMcpServer(await createWorkbookRoot(root));
    client = new Client({ name: "global-encoding-spec", version: "0.0.0" });
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

  it.each(vectors)(
    "decodes $encoding and preserves identifiers",
    async (vector) => {
      const answer = await client.callTool({
        name: "read_sheet",
        arguments: {
          filePath: `${vector.encoding}.csv`,
          delimiter: "comma",
          encoding: vector.encoding,
        },
      });
      const block = answer.content[0];
      expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
      if (block?.type !== "text")
        throw new Error("Expected an MCP text result.");
      const body = readSchema.parse(JSON.parse(block.text));
      expect(body.values).toEqual([[vector.text, "00123"]]);
      expect(body.csv).toMatchObject({
        encoding: vector.encoding,
        encodingSource: "explicit",
      });
    },
  );

  it.each(truncated)(
    "refuses a truncated $encoding sequence instead of inserting a replacement character",
    async ({ encoding }) => {
      const answer = await client.callTool({
        name: "read_sheet",
        arguments: {
          filePath: `truncated-${encoding}.csv`,
          encoding,
          delimiter: "comma",
        },
      });
      const block = answer.content[0];
      expect(answer.isError).toBe(true);
      if (block?.type !== "text")
        throw new Error("Expected an MCP text result.");
      expect(errorSchema.parse(JSON.parse(block.text)).error).toBe(
        "undecodable_text",
      );
    },
  );
});
