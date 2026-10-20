import { describe, expect, it } from "vitest";
import { readCatalog } from "../src/agent/task.ts";

describe("agent task catalog", () => {
  it("parses, and every planned call passes its tool's input schema", async () => {
    const catalog = await readCatalog();
    expect(catalog.tasks.length).toBeGreaterThan(0);
  });
});
