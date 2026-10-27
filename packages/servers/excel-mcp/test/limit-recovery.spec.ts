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
  client = new Client({ name: "limit-recovery-test", version: "0.0.0" });
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

it("keeps the maxGroups bound and points to retained continuation", async () => {
  const response = await client.callTool({
    name: "aggregate_sheet",
    arguments: {
      filePath: "title-band.xlsx",
      sheetName: "Faturalar",
      groupBy: ["Fatura No"],
      metrics: [{ fn: "count" }],
      maxGroups: 501,
    },
  });
  const content = response.content[0];
  if (content?.type !== "text") throw new Error("Missing text response");
  expect(response.isError).toBe(true);
  const failure = JSON.parse(content.text) as Record<string, string>;
  expect(failure["error"]).toBe("invalid_argument");
  expect(failure["message"]).toContain("maxGroups is at most 500");
  expect(failure["message"]).toContain(
    'resultMode "retained" and query_result',
  );
  expect(failure["message"]).toContain('orderBy "metric"');
});
