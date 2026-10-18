import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createWorkbookRoot } from "../src/platform/paths.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

vi.mock("../src/platform/limits.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/platform/limits.js")>();
  return {
    ...original,
    limits: {
      ...original.limits,
      maxAggregateCellVisits: 200,
      maxAggregateGroups: 3,
    },
  };
});

let directory: string;
let handlers: ToolHandlers;

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return JSON.parse(content.text) as Record<string, unknown>;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-aggregate-budget-"));
  handlers = createHandlers(await createWorkbookRoot(directory));
  const rows = Array.from(
    { length: 100 },
    (_, index) => `g${String(index % 2)},${String(index)},x`,
  );
  await writeFile(
    join(directory, "wide.csv"),
    ["group,value,note", ...rows].join("\n"),
  );
  await writeFile(
    join(directory, "many.csv"),
    ["group", "a", "b", "c", "d"].join("\n"),
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("aggregate_sheet bounds the work, not only the answer", () => {
  it("refuses once the cells it reads pass the visit budget", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "wide.csv",
      groupBy: ["group"],
      metrics: [{ fn: "sum", column: "value" }],
    });
    expect(result.isError).toBe(true);
    expect(body(result)["error"]).toBe("resource_limit");
  });

  it("refuses once the groups it holds pass the group budget", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "many.csv",
      groupBy: ["group"],
      metrics: [{ fn: "count" }],
    });
    expect(result.isError).toBe(true);
    expect(body(result)["error"]).toBe("resource_limit");
  });
});
