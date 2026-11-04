import { describe, expect, it } from "vitest";
import { QuickJsExecutor } from "@sezzlee/compute-core";
import { executeStoredResult, MemoryResultStore } from "../src/index.js";

describe("retained result execution authorization lifecycle", () => {
  it("rechecks the producing tool after execution and withholds a newly revoked result", async () => {
    const store = new MemoryResultStore();
    const handle = "q7Vd2Zc0xTn4bQ1kLw9sYA";
    await store.put(
      "caller",
      handle,
      '{"tool":"list_orders","body":{"secret":"must-not-escape"}}',
    );
    let decisions = 0;
    const result = await executeStoredResult({
      handle,
      code: "return data;",
      shelf: { store, partition: "caller" },
      executor: new QuickJsExecutor(),
      visible: async () => ++decisions === 1,
    });
    expect(decisions).toBe(2);
    expect(result.isError).toBe(true);
    expect(result.payload).toMatchObject({ error: "result_unavailable" });
    expect(result.storable).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it("does not claim upstream completeness when the complete stored body is only a page", async () => {
    const store = new MemoryResultStore();
    const handle = "q7Vd2Zc0xTn4bQ1kLw9sYA";
    await store.put(
      "caller",
      handle,
      '{"tool":"list_orders","body":{"items":[3,5],"nextPage":2}}',
    );
    const result = await executeStoredResult({
      handle,
      code: "return data.items.reduce((n, x) => n + x, 0);",
      shelf: { store, partition: "caller" },
      executor: new QuickJsExecutor(),
      visible: async () => true,
    });
    expect(result.payload).toEqual({
      source: { handle, tool: "list_orders", scope: "stored_body" },
      value: 8,
    });
    expect(result.storable?.tool).toBe("list_orders");
  });
});
