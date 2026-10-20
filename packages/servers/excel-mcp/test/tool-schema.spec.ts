import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";

let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = createExcelMcpServer(
    await createWorkbookRoot(inject("fixtures").root),
  );
  client = new Client({ name: "tool-schema-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  close = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(async () => {
  await close();
});

async function errorOf(
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const response = await client.callTool({
    name: "read_sheet",
    arguments: args,
  });
  const content = response.content[0];
  if (content?.type !== "text") throw new Error("Missing text response");
  return response.isError === true
    ? (JSON.parse(content.text) as { error: string }).error
    : undefined;
}

/**
 * Guard: the tool list is sent with every model request; it was 67 KB before
 * nested descriptions were removed and the column specification flattened.
 */
it("serves the tool list within its byte budget", async () => {
  const { tools } = await client.listTools();
  expect(JSON.stringify(tools).length).toBeLessThanOrEqual(36_000);
});

it("accepts a column specification by its declared type and refuses a field that type does not take", async () => {
  const base = { filePath: "q1/sample.xlsx", maxCells: 4 };
  expect(
    await errorOf({
      ...base,
      columns: [{ column: "A", type: "number", decimal: "," }],
    }),
  ).toBeUndefined();
  expect(
    await errorOf({
      ...base,
      columns: [{ column: "A", type: "date", format: "dd.MM.yyyy" }],
    }),
  ).toBeUndefined();
  expect(
    await errorOf({
      ...base,
      columns: [{ column: "A", type: "date", decimal: "," }],
    }),
  ).toBe("invalid_argument");
  expect(
    await errorOf({
      ...base,
      columns: [{ column: "A", type: "text", trueValues: ["x"] }],
    }),
  ).toBe("invalid_argument");
});
