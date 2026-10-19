import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import { limits } from "../src/platform/limits.js";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";

it("pages parallel raw, typed, and source-row arrays within the complete response budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "excel-visible-budget-"));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Rows");
  sheet.addRow(["Label"]);
  const label = "x".repeat(50);
  for (let row = 0; row < 10_000; row += 1) sheet.addRow([label]);
  await writeFile(
    join(directory, "rows.xlsx"),
    Buffer.from(await workbook.xlsx.writeBuffer()),
  );
  const server = createExcelMcpServer(await createWorkbookRoot(directory));
  const client = new Client({ name: "visible-budget-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    for (const { visibleOnly, includeTyped } of [
      { visibleOnly: false, includeTyped: false },
      { visibleOnly: true, includeTyped: false },
      { visibleOnly: false, includeTyped: true },
      { visibleOnly: true, includeTyped: true },
    ]) {
      const response = await client.callTool({
        name: "read_sheet",
        arguments: {
          filePath: "rows.xlsx",
          visibleOnly,
          includeTyped,
          columns: [{ column: "A", type: "text" }],
          columnMode: "letter",
          maxCells: 10_000,
        },
      });
      const content = response.content[0];
      if (content?.type !== "text") throw new Error("Missing text response");
      expect(response.isError, content.text).not.toBe(true);
      expect(Buffer.byteLength(content.text, "utf8")).toBeLessThanOrEqual(
        limits.maxPayloadBytes,
      );
      const result = JSON.parse(content.text) as {
        values: unknown[][];
        rowNumbers?: number[];
        typedValues?: unknown[][];
        truncated: boolean;
        nextCursor?: string;
      };
      expect(result.truncated).toBe(true);
      expect(result.values.length).toBeGreaterThan(0);
      expect(result.nextCursor).toEqual(expect.any(String));
      expect(result.values).toEqual(result.values.map(() => [label]));
      if (visibleOnly) {
        expect(result.rowNumbers).toEqual(
          result.values.map((_, index) => index + 2),
        );
      } else {
        expect(result.rowNumbers).toBeUndefined();
      }
      if (includeTyped) expect(result.typedValues).toEqual(result.values);
      else expect(result.typedValues).toBeUndefined();
    }
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
