import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";
import {
  linkedWorkbook,
  richErrorsWorkbook,
} from "./fixtures/rich-workbook.js";

const linkedValue = {
  type: "_linkedentity2",
  displayText: "Seattle",
  entityId: "5fbba6b8-85e1-4d41-9444-d9055436e473",
  entityCulture: "en-US",
  serviceId: 536870912,
};
let directory: string;
let client: Client;
let server: ReturnType<typeof createExcelMcpServer>;

async function request(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content[0];
  if (content?.type !== "text") throw new Error("Missing text response");
  return {
    ...(JSON.parse(content.text) as Record<string, unknown>),
    isError: response.isError === true,
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-rich-linked-"));
  await writeFile(join(directory, "linked.xlsx"), linkedWorkbook());
  await writeFile(join(directory, "errors.xlsx"), richErrorsWorkbook());
  server = createExcelMcpServer(await createWorkbookRoot(directory));
  client = new Client({ name: "rich-linked-errors-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
});

afterAll(async () => {
  await client.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

describe("independently verified linked values and rich errors", () => {
  it("reads the SDK Seattle display and identifier fields through nondefault part names", async () => {
    const result = await request("read_sheet", {
      filePath: "linked.xlsx",
      headerRow: 0,
    });
    expect(result["isError"]).toBe(false);
    expect(result["values"]).toEqual([[{ linkedValue }]]);
  });

  it("searches the saved linked display without expanding unreferenced geography records", async () => {
    const result = await request("find_in_sheet", {
      filePath: "linked.xlsx",
      query: "Seattle",
      matchMode: "exact",
    });
    expect(result["isError"]).toBe(false);
    expect(result["total"]).toBe(1);
    expect(result["matches"]).toEqual([
      { address: "A1", row: 1, column: 1, value: { linkedValue } },
    ]);
  });

  it("profiles and counts linked values as their own native kind", async () => {
    const profile = await request("profile_sheet", {
      filePath: "linked.xlsx",
      headerRow: 0,
    });
    expect(profile["isError"]).toBe(false);
    expect(JSON.stringify(profile)).toContain('"inferredType":"linkedValue"');
    const report = await request("aggregate_sheet", {
      filePath: "linked.xlsx",
      headerRow: 0,
      columnMode: "letter",
      metrics: [
        { fn: "countValues", column: "A" },
        { fn: "countDistinct", column: "A" },
        { fn: "sum", column: "A" },
      ],
    });
    expect(report["isError"]).toBe(false);
    expect(report["rows"]).toEqual([[1, 1, null]]);
    expect(report["columnStats"]).toMatchObject({ A: { linkedValues: 1 } });
    expect(report["errorDistribution"]).toBeUndefined();
  });

  it("resolves rich error types8/13 and explains stored SPILL/CALC caches", async () => {
    const result = await request("read_sheet", {
      filePath: "errors.xlsx",
      sheetName: "Rich",
      range: "E5:F6",
      headerRow: 0,
    });
    expect(result["isError"]).toBe(false);
    expect(result["values"]).toEqual([
      [{ error: "#SPILL!" }, { error: "#SPILL!" }],
      [{ error: "#CALC!" }, { error: "#CALC!" }],
    ]);
    expect(result["cellNotes"]).toEqual({
      E5: {
        kind: "error",
        explanation: expect.stringContaining("does not calculate"),
      },
      F5: {
        kind: "error",
        explanation: expect.stringContaining("does not calculate"),
      },
      E6: {
        kind: "error",
        explanation: expect.stringContaining("does not recalculate"),
      },
      F6: {
        kind: "error",
        explanation: expect.stringContaining("does not recalculate"),
      },
    });
  });
});
