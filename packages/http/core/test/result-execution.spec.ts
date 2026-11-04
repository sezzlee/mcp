import { describe, expect, it, vi } from "vitest";
import { QuickJsExecutor } from "@sezzlee/compute-core";
import {
  emitGuarded,
  executeStoredResult,
  MemoryResultStore,
} from "../src/index.js";

describe("retained result execution authorization lifecycle", () => {
  it("does not publish or retain a success cancelled during the final visibility check", async () => {
    const store = new MemoryResultStore();
    const handle = "q7Vd2Zc0xTn4bQ1kLw9sYA";
    await store.put(
      "caller",
      handle,
      JSON.stringify({
        tool: "list_orders",
        body: { value: "x".repeat(20_000) },
      }),
    );
    const put = vi.spyOn(store, "put");
    const controller = new AbortController();
    let decisions = 0;
    try {
      const result = await emitGuarded(
        () => 2_048,
        () =>
          executeStoredResult({
            handle,
            code: "return data;",
            shelf: { store, partition: "caller" },
            executor: new QuickJsExecutor(),
            signal: controller.signal,
            visible: () => {
              decisions++;
              return decisions === 2
                ? new Promise<boolean>((resolve) =>
                    queueMicrotask(() => {
                      controller.abort();
                      resolve(true);
                    }),
                  )
                : Promise.resolve(true);
            },
          }),
        { store, partition: "caller" },
      );
      expect(decisions).toBe(2);
      expect(controller.signal.aborted).toBe(true);
      expect(put.mock.calls.length).toBe(0);
      expect(result.isError).toBe(true);
      const payload: unknown = JSON.parse(result.content[0]?.text ?? "{}");
      expect(payload).toMatchObject({
        error: "result_execution_failed",
        reason: "cancelled",
      });
    } finally {
      put.mockRestore();
    }
  });

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
