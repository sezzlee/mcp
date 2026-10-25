import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, inject, it } from "vitest";
import { writeCellSchema } from "../src/authoring/values.js";
import { parseExcelArgv } from "../src/platform/argv.js";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  createWorkbookOutput,
  versionReceiptSchema,
  workbookVersionIdSchema,
} from "../src/platform/versions.js";
import { createExcelMcpServer } from "../src/server.js";
import { createWritingHandlers } from "../src/tools/writing.js";

async function workspace(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "excel-write-"));
  try {
    await mkdir(join(directory, "out"));
    await copyFile(
      join(inject("fixtures").root, "q1", "sample.xlsx"),
      join(directory, "source.xlsx"),
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function connected(
  server: McpServer,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ name: "write-contract-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function textResult(result: { readonly content: readonly unknown[] }): unknown {
  const first = result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  )
    throw new Error("Expected a text result");
  return JSON.parse(first.text);
}

describe("explicit write cell contract K1-08", () => {
  it.each(["=SUM(A1:A2)", "2026-01-31", "00123", "", "emoji 😀"])(
    "keeps literal text %j unchanged",
    (value) => {
      expect(writeCellSchema.parse({ kind: "text", value })).toEqual({
        kind: "text",
        value,
      });
    },
  );

  it.each([
    {
      input: { kind: "number", value: "12" },
      issue: { code: "invalid_type", path: ["value"] },
    },
    {
      input: { kind: "boolean", value: "false" },
      issue: { code: "invalid_type", path: ["value"] },
    },
    {
      input: { kind: "blank", value: "" },
      issue: { code: "unrecognized_keys", keys: ["value"] },
    },
    {
      input: { kind: "date", value: "2026-02-30" },
      issue: { code: "invalid_format", path: ["value"] },
    },
    {
      input: { kind: "datetime", value: "2026-01-31T09:30:00Z" },
      issue: { code: "invalid_format", path: ["value"] },
    },
    {
      input: { kind: "formula", value: "=1+1" },
      issue: { code: "invalid_union", path: ["kind"] },
    },
    {
      input: { kind: "text", value: 123 },
      issue: { code: "invalid_type", path: ["value"] },
    },
    {
      input: { kind: "number", value: Infinity },
      issue: { code: "invalid_type", path: ["value"] },
    },
    {
      input: { kind: "number", value: 9_007_199_254_740_992 },
      issue: { code: "custom", path: ["value"] },
    },
    {
      input: { kind: "number", value: 1.234567890123456 },
      issue: { code: "custom", path: ["value"] },
    },
    {
      input: { kind: "number", value: 1e-310 },
      issue: { code: "custom", path: ["value"] },
    },
    {
      input: { kind: "date", value: "1899-12-31" },
      issue: { code: "custom", path: ["value"] },
    },
    {
      input: { kind: "text", value: "\ud800" },
      issue: { code: "custom", path: ["value"] },
    },
    {
      input: { kind: "text", value: "\udc00" },
      issue: { code: "custom", path: ["value"] },
    },
  ])("rejects mismatched or unsupported input $input", ({ input, issue }) => {
    const result = writeCellSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining(issue)]),
      );
  });

  it("distinguishes blank, false, zero, date and local datetime", () => {
    for (const input of [
      { kind: "blank" },
      { kind: "boolean", value: false },
      { kind: "number", value: 0 },
      { kind: "date", value: "2024-02-29" },
      { kind: "datetime", value: "2026-01-31T09:30:00.123" },
    ])
      expect(writeCellSchema.parse(input)).toEqual(input);
  });
});

it("requires explicit CLI opt-in and refuses malformed writing arguments", () => {
  expect(parseExcelArgv(["node", "cli", "root"])).toEqual({
    kind: "read",
    path: "root",
  });
  expect(parseExcelArgv(["node", "cli", "root", "--write", "out"])).toEqual({
    kind: "write",
    path: "root",
    directory: "out",
  });
  for (const args of [
    ["root", "--write"],
    ["root", "--write", "out", "extra"],
    ["root", "--other", "out"],
    ["root", "--write", "--other"],
  ])
    expect(parseExcelArgv(["node", "cli", ...args])).toEqual({ kind: "usage" });
});

it("keeps writing unavailable in the default server and declares output writes truthfully", async () => {
  await workspace(async (directory) => {
    const root = await createWorkbookRoot(directory);
    await connected(createExcelMcpServer(root), async (client) => {
      expect(
        (await client.listTools()).tools.every(
          (tool) => tool.annotations?.readOnlyHint === true,
        ),
      ).toBe(true);
      expect(
        (await client.listTools()).tools.find(
          (tool) => tool.name === "create_workbook_version",
        ),
      ).toBeUndefined();
      await expect(
        client.callTool({
          name: "create_workbook_version",
          arguments: { filePath: "source.xlsx" },
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        client.callTool({
          name: "create_workbook",
          arguments: { sheets: [{ name: "No" }] },
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        client.callTool({ name: "edit_workbook", arguments: {} }),
      ).rejects.toMatchObject({ code: -32602 });
    });
    const output = await createWorkbookOutput(root, "out");
    await connected(
      createExcelMcpServer(root, { mode: "write", output }),
      async (client) => {
        const tool = (await client.listTools()).tools.find(
          (entry) => entry.name === "create_workbook_version",
        );
        expect(tool?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        });
      },
    );
    expect(await readdir(join(directory, "out"))).toEqual([]);
  });
});

it("prepares an immutable version over MCP, reuses it on retry and continues from the returned source", async () => {
  await workspace(async (directory) => {
    const original = await readFile(join(directory, "source.xlsx"));
    const hash = createHash("sha256").update(original).digest("hex");
    const root = await createWorkbookRoot(directory);
    const output = await createWorkbookOutput(root, "out");
    await connected(
      createExcelMcpServer(root, { mode: "write", output }),
      async (client) => {
        const request = {
          name: "create_workbook_version",
          arguments: { filePath: "source.xlsx" },
        };
        const first = await client.callTool(request);
        expect(first.isError).toBeUndefined();
        const receipt = versionReceiptSchema.parse(textResult(first));
        expect(receipt).toEqual({
          kind: "complete",
          version: { filePath: `out/${hash}.xlsx`, versionId: hash },
          source: { filePath: "source.xlsx", versionId: hash },
          sizeBytes: original.length,
        });
        expect(
          first.content
            .filter((entry) => entry.type === "text")
            .map((entry) => entry.text)
            .join("").length,
        ).toBeLessThan(1000);
        const retried = await client.callTool(request);
        expect(textResult(retried)).toEqual(textResult(first));
        const continued = versionReceiptSchema.parse(
          textResult(
            await client.callTool({
              name: "create_workbook_version",
              arguments: {
                filePath: receipt.version.filePath,
                expectedVersion: receipt.version.versionId,
              },
            }),
          ),
        );
        expect(continued.source).toEqual(receipt.version);
        expect(continued.version).toEqual(receipt.version);
        const read = await client.callTool({
          name: "read_sheet",
          arguments: {
            filePath: receipt.version.filePath,
            sheetName: "Q1",
            maxCells: 8,
          },
        });
        expect(read.isError, JSON.stringify(textResult(read))).toBeUndefined();
      },
    );
    expect(await readFile(join(directory, "source.xlsx"))).toEqual(original);
    expect(await readFile(join(directory, "out", `${hash}.xlsx`))).toEqual(
      original,
    );
    expect(await readdir(join(directory, "out"))).toEqual([`${hash}.xlsx`]);
  });
});

it("refuses a changed source, invalid workbook and unknown arguments before publication", async () => {
  await workspace(async (directory) => {
    const root = await createWorkbookRoot(directory);
    const output = await createWorkbookOutput(root, "out");
    const original = await readFile(join(directory, "source.xlsx"));
    await writeFile(join(directory, "invalid.xlsx"), "not an Excel file");
    await connected(
      createExcelMcpServer(root, { mode: "write", output }),
      async (client) => {
        for (const { args, error } of [
          {
            args: {
              filePath: "source.xlsx",
              expectedVersion: workbookVersionIdSchema.parse("0".repeat(64)),
            },
            error: "file_changed",
          },
          { args: { filePath: "invalid.xlsx" }, error: "not_a_workbook" },
          {
            args: { filePath: "source.xlsx", overwrite: true },
            error: "invalid_argument",
          },
        ]) {
          const result = await client.callTool({
            name: "create_workbook_version",
            arguments: args,
          });
          expect(result.isError).toBe(true);
          expect(textResult(result)).toMatchObject({ error });
        }
      },
    );
    expect(await readdir(join(directory, "out"))).toEqual([]);
    expect(await readFile(join(directory, "source.xlsx"))).toEqual(original);
  });
});

it("never replaces different content occupying the expected output name", async () => {
  await workspace(async (directory) => {
    const original = await readFile(join(directory, "source.xlsx"));
    const hash = createHash("sha256").update(original).digest("hex");
    const destination = join(directory, "out", `${hash}.xlsx`);
    await writeFile(destination, "pre-existing content");
    const root = await createWorkbookRoot(directory);
    const output = await createWorkbookOutput(root, "out");
    await connected(
      createExcelMcpServer(root, { mode: "write", output }),
      async (client) => {
        const result = await client.callTool({
          name: "create_workbook_version",
          arguments: { filePath: "source.xlsx" },
        });
        expect(result.isError).toBe(true);
        expect(textResult(result)).toMatchObject({ error: "file_changed" });
      },
    );
    expect(await readFile(destination, "utf8")).toBe("pre-existing content");
    expect(await readFile(join(directory, "source.xlsx"))).toEqual(original);
    expect(await readdir(join(directory, "out"))).toEqual([`${hash}.xlsx`]);
  });
});

it("wires the explicit writing mode through the built CLI and stdio transport", async () => {
  await workspace(async (directory) => {
    for (const write of [false, true]) {
      const client = new Client({ name: "write-cli-test", version: "0.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
          directory,
          ...(write ? ["--write", "out"] : []),
        ],
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        const tool = (await client.listTools()).tools.find(
          (entry) => entry.name === "create_workbook_version",
        );
        expect(tool !== undefined).toBe(write);
        if (write) {
          const result = await client.callTool({
            name: "create_workbook_version",
            arguments: { filePath: "source.xlsx" },
          });
          expect(
            result.isError,
            JSON.stringify(textResult(result)),
          ).toBeUndefined();
          expect(
            versionReceiptSchema.parse(textResult(result)).source?.filePath,
          ).toBe("source.xlsx");
        }
      } finally {
        await client.close();
        await transport.close();
      }
    }
  });
});

it("bounds concurrent preparations before reading source bytes and allows a safe retry", async () => {
  await workspace(async (directory) => {
    const root = await createWorkbookRoot(directory);
    const output = await createWorkbookOutput(root, "out");
    const handlers = createWritingHandlers(root, output);
    const first = handlers.create_workbook_version({ filePath: "source.xlsx" });
    const second = await handlers.create_workbook_version({
      filePath: "source.xlsx",
    });
    expect(second.isError).toBe(true);
    expect(textResult(second)).toMatchObject({ error: "resource_limit" });
    const completed = await first;
    expect(completed.isError).toBeUndefined();
    const retried = await handlers.create_workbook_version({
      filePath: "source.xlsx",
    });
    expect(retried.isError).toBeUndefined();
    expect(textResult(retried)).toEqual(textResult(completed));
    expect((await readdir(join(directory, "out"))).length).toBe(1);
  });
});
