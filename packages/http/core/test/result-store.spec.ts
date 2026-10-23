import { describe, expect, it, vi } from "vitest";
import {
  emitGuarded,
  MemoryResultStore,
  readStoredResult,
  textResult,
  type InvokeStored,
  type MetaResponse,
  type ResultShelf,
  type ResultStore,
  type WireResult,
} from "../src/index.js";

function clock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("MemoryResultStore", () => {
  it("answers a handle only inside the partition it was put in", async () => {
    const store = new MemoryResultStore();
    expect(await store.put("alice", "h", "v")).toBe(600);
    expect(await store.get("alice", "h")).toBe("v");
    expect(await store.get("bob", "h")).toBeUndefined();
  });

  it("forgets a value once its lifetime has passed", async () => {
    const time = clock();
    const store = new MemoryResultStore({ lifetimeMs: 2_000, now: time.now });
    expect(await store.put("p", "h", "v")).toBe(2);
    time.advance(1_999);
    expect(await store.get("p", "h")).toBe("v");
    time.advance(1);
    expect(await store.get("p", "h")).toBeUndefined();
  });

  it("drops the partition's oldest values to fit a new one, and leaves other partitions alone", async () => {
    const store = new MemoryResultStore({ maxCallerBytes: 10 });
    await store.put("p", "first", "aaaa");
    await store.put("p", "second", "bbbb");
    await store.put("q", "other", "cccc");
    await store.put("p", "third", "dddd");
    expect(await store.get("p", "first")).toBeUndefined();
    expect(await store.get("p", "second")).toBe("bbbb");
    expect(await store.get("p", "third")).toBe("dddd");
    expect(await store.get("q", "other")).toBe("cccc");
  });

  it("drops the store's oldest value at its total cap", async () => {
    const store = new MemoryResultStore({ maxBytes: 8 });
    await store.put("p", "first", "aaaa");
    await store.put("q", "second", "bbbb");
    await store.put("r", "third", "cccc");
    expect(await store.get("p", "first")).toBeUndefined();
    expect(await store.get("q", "second")).toBe("bbbb");
    expect(await store.get("r", "third")).toBe("cccc");
  });

  it("counts a replaced value's bytes once", async () => {
    const store = new MemoryResultStore({ maxCallerBytes: 10 });
    await store.put("p", "h", "aaaa");
    await store.put("p", "other", "bbbb");
    await store.put("p", "h", "cc");
    await store.put("p", "third", "dddd");
    expect(await store.get("p", "other")).toBe("bbbb");
    expect(await store.get("p", "h")).toBe("cc");
    expect(await store.get("p", "third")).toBe("dddd");
  });

  it("keeps a value for its lifetime when the wall clock is set forward", async () => {
    const wall = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const store = new MemoryResultStore({ lifetimeMs: 2_000 });
      await store.put("p", "h", "v");
      wall.mockReturnValue(1_000_000 + 3_600_000);
      expect(await store.get("p", "h")).toBe("v");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuses a value over the partition cap without dropping what it holds", async () => {
    const store = new MemoryResultStore({ maxCallerBytes: 4 });
    await store.put("p", "kept", "aaaa");
    expect(await store.put("p", "large", "ççç")).toBeUndefined();
    expect(await store.get("p", "kept")).toBe("aaaa");
  });
});

const items = Array.from({ length: 200 }, (_, id) => ({
  id,
  status: "open",
}));

function overBudget(applied = false): MetaResponse<never> {
  const success = { status: 200, body: { total: 200, items } };
  return textResult(success, false, {
    summaryOf: success.body,
    applied,
    storable: { tool: "orders_list", success },
  });
}

function answerOf(wire: WireResult): unknown {
  return JSON.parse(wire.content[0]?.text ?? "null");
}

const budget = () => 1_000;

async function emitStored(shelf: ResultShelf): Promise<InvokeStored> {
  const wire = await emitGuarded(budget, async () => overBudget(), shelf);
  expect(wire.isError).toBe(false);
  return answerOf(wire) as InvokeStored;
}

async function read(
  shelf: ResultShelf,
  call: Parameters<typeof readStoredResult>[0],
  visible: (tool: string) => Promise<boolean> = async () => true,
): Promise<WireResult> {
  return emitGuarded(budget, () => readStoredResult(call, shelf, visible));
}

describe("storing an over-budget answer", () => {
  it("answers with a handle the same caller reads back in parts", async () => {
    const shelf = { store: new MemoryResultStore(), partition: "alice" };
    const answer = await emitStored(shelf);
    expect(answer.stored.handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(answer.stored.limit).toBe(1_000);

    const wire = await read(shelf, {
      handle: answer.stored.handle,
      path: "/items",
      select: ["id"],
      offset: 198,
    });
    expect(wire.isError).toBe(false);
    expect(answerOf(wire)).toEqual({
      path: "/items",
      kind: "array",
      total: 200,
      offset: 198,
      value: [{ id: 198 }, { id: 199 }],
    });
  });

  it("mints a different handle for every stored answer", async () => {
    const shelf = { store: new MemoryResultStore(), partition: "alice" };
    const first = await emitStored(shelf);
    const second = await emitStored(shelf);
    expect(first.stored.handle).not.toBe(second.stored.handle);
  });

  it("does not let another caller read the handle", async () => {
    const store = new MemoryResultStore();
    const answer = await emitStored({ store, partition: "alice" });
    const wire = await read(
      { store, partition: "bob" },
      { handle: answer.stored.handle },
    );
    expect(wire.isError).toBe(true);
    expect(answerOf(wire)).toMatchObject({ error: "result_unavailable" });
  });

  it("stops serving a result whose tool the reader may no longer see", async () => {
    const shelf = { store: new MemoryResultStore(), partition: "alice" };
    const answer = await emitStored(shelf);
    const asked: string[] = [];
    const wire = await read(
      shelf,
      { handle: answer.stored.handle },
      async (tool) => {
        asked.push(tool);
        return false;
      },
    );
    expect(asked).toEqual(["orders_list"]);
    expect(answerOf(wire)).toMatchObject({ error: "result_unavailable" });
  });

  it("refuses a read that is over the budget and names the read's own narrowing arguments", async () => {
    const shelf = { store: new MemoryResultStore(), partition: "alice" };
    const answer = await emitStored(shelf);
    const wire = await read(shelf, {
      handle: answer.stored.handle,
      path: "/items",
    });
    expect(wire.isError).toBe(true);
    expect(answerOf(wire)).toMatchObject({
      error: "response_too_large",
      fields: [
        { name: "limit" },
        { name: "offset" },
        { name: "select" },
        { name: "path" },
      ],
    });
  });

  it("answers a handle of the wrong shape as unavailable without asking the store", async () => {
    const asked: string[] = [];
    const store: ResultStore = {
      put: async () => 600,
      get: async (_partition, handle) => {
        asked.push(handle);
        return undefined;
      },
    };
    const wire = await read(
      { store, partition: "alice" },
      { handle: "../../etc" },
    );
    expect(asked).toEqual([]);
    expect(answerOf(wire)).toMatchObject({ error: "result_unavailable" });
  });

  it("falls back to the refusal and reports when the store fails", async () => {
    const reported: unknown[] = [];
    const failure = new Error("store down");
    const store: ResultStore = {
      put: async () => {
        throw failure;
      },
      get: async () => undefined,
    };
    const wire = await emitGuarded(budget, async () => overBudget(), {
      store,
      partition: "alice",
      report: (error) => reported.push(error),
    });
    expect(wire.isError).toBe(true);
    expect(answerOf(wire)).toMatchObject({ error: "response_too_large" });
    expect(reported).toEqual([failure]);
  });

  it.each<{ readonly name: string; readonly shelf: ResultShelf }>([
    {
      name: "the store does not keep the value",
      shelf: {
        store: { put: async () => undefined, get: async () => undefined },
        partition: "alice",
      },
    },
    {
      name: "the store and then its reporter fail",
      shelf: {
        store: {
          put: async () => {
            throw new Error("store down");
          },
          get: async () => undefined,
        },
        partition: "alice",
        report: () => {
          throw new Error("logger down");
        },
      },
    },
  ])("falls back to the refusal when $name", async ({ shelf }) => {
    const wire = await emitGuarded(budget, async () => overBudget(), shelf);
    expect(wire.isError).toBe(true);
    expect(answerOf(wire)).toMatchObject({ error: "response_too_large" });
  });

  it("checks a missing handle before the types of the other arguments", async () => {
    const shelf = { store: new MemoryResultStore(), partition: "alice" };
    const wire = await read(shelf, { handle: null, path: 42 });
    expect(answerOf(wire)).toMatchObject({ error: "unknown_argument" });
  });

  it("falls back to the refusal when the stored answer itself is over the budget", async () => {
    const wire = await emitGuarded(
      () => 300,
      async () => overBudget(true),
      {
        store: new MemoryResultStore(),
        partition: "alice",
      },
    );
    expect(answerOf(wire)).toMatchObject({
      error: "response_too_large",
      message: expect.stringContaining(
        "The backend already applied the operation",
      ),
    });
  });

  it("refuses an over-budget answer that is not marked storable", async () => {
    const success = { status: 200, body: { items } };
    const wire = await emitGuarded(
      budget,
      async () => textResult(success, false, { summaryOf: success.body }),
      { store: new MemoryResultStore(), partition: "alice" },
    );
    expect(answerOf(wire)).toMatchObject({ error: "response_too_large" });
  });
});
