import { describe, expect, it, vi } from "vitest";
import { QuickJsExecutor } from "@sezzlee/compute-core";

describe("published synchronous JSON executor contract", () => {
  it("filters and totals the complete supplied body without exposing its rows", async () => {
    const executor = new QuickJsExecutor();
    const result = await executor.execute({
      json: '{"items":[{"paid":true,"total":12},{"paid":false,"total":7},{"paid":true,"total":22},{"paid":true,"total":50}]}',
      code: "const rows = data.items.filter(x => x.paid); return {count: rows.length, total: rows.reduce((n, x) => n + x.total, 0)};",
    });
    expect(result).toEqual({ kind: "success", json: '{"count":3,"total":84}' });
  });

  it("keeps code-like strings inert and gives each execution its own input", async () => {
    const executor = new QuickJsExecutor();
    const json =
      '{"value":"\\\"}); throw new Error(\\\"injected\\\"); //", "code":"00123"}';
    expect(
      await executor.execute({
        json,
        code: "data.value = 'changed'; return data.code;",
      }),
    ).toEqual({ kind: "success", json: '"00123"' });
    expect(
      await executor.execute({ json, code: "return data.value;" }),
    ).toEqual({
      kind: "success",
      json: '"\\\"}); throw new Error(\\\"injected\\\"); //"',
    });
  });

  it("provides no host capabilities, including through a function constructor", async () => {
    const executor = new QuickJsExecutor();
    expect(
      await executor.execute({
        json: "null",
        code: "return [typeof process, typeof require, typeof fetch, typeof console, typeof setTimeout, Function('return typeof process')()];",
      }),
    ).toEqual({
      kind: "success",
      json: '["undefined","undefined","undefined","undefined","undefined","undefined"]',
    });
  });

  it("captures its JSON serializer before the program can replace globals", async () => {
    expect(
      await new QuickJsExecutor().execute({
        json: "null",
        code: "JSON.stringify = () => 'forged'; Number.isFinite = () => true; return {value: 7};",
      }),
    ).toEqual({ kind: "success", json: '{"value":7}' });
  });

  it.each([
    ["return undefined;", "invalid_result"],
    ["return {lost: undefined};", "invalid_result"],
    ["return NaN;", "invalid_result"],
    ["return Infinity;", "invalid_result"],
    ["return 1n;", "invalid_result"],
    ["return Promise.resolve(1);", "invalid_result"],
    ["return {nested: Promise.resolve(1)};", "invalid_result"],
    ["return new Map([['lost', 1]]);", "invalid_result"],
    ["const x = {}; x.self = x; return x;", "invalid_result"],
    ["return (;", "invalid_program"],
    ["throw new Error(data.secret);", "program_failed"],
  ])("refuses non-JSON or failed programs: %s", async (code, reason) => {
    const result = await new QuickJsExecutor().execute({
      json: '{"secret":"source-secret-must-not-escape"}',
      code,
    });
    expect(result).toEqual({ kind: "failure", reason });
    expect(JSON.stringify(result)).not.toContain(
      "source-secret-must-not-escape",
    );
  });

  it.each([
    [{ maxInputBytes: 3 }, '"😀"', "return data;", "input_limit"],
    [{ maxCodeBytes: 4 }, "null", "return 1;", "code_limit"],
    [{ maxOutputBytes: 5 }, "null", "return '😀';", "output_limit"],
  ])(
    "enforces UTF-8 byte budgets before returning any value",
    async (limits, json, code, reason) => {
      expect(await new QuickJsExecutor(limits).execute({ json, code })).toEqual(
        { kind: "failure", reason },
      );
    },
  );

  it("interrupts an infinite program and can execute another job afterwards", async () => {
    const executor = new QuickJsExecutor();
    expect(
      await executor.execute({ json: "null", code: "while (true) {}" }),
    ).toEqual({ kind: "failure", reason: "timeout" });
    expect(
      await executor.execute({ json: "null", code: "return 42;" }),
    ).toEqual({ kind: "success", json: "42" });
  }, 10_000);

  it("enforces a short wall-clock budget without requiring the worker to start within it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const executor = new QuickJsExecutor({ timeoutMs: 500 });
      const running = executor.execute({
        json: "null",
        code: "while (true) {}",
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(await running).toEqual({ kind: "failure", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the deadline to user code invoked during serialization", async () => {
    expect(
      await new QuickJsExecutor().execute({
        json: "null",
        code: "return {toJSON() { while (true) {} }};",
      }),
    ).toEqual({ kind: "failure", reason: "timeout" });
  });

  it("refuses concurrent admission and waits for a cancelled worker before reusing its slot", async () => {
    const executor = new QuickJsExecutor({ maxConcurrent: 1 });
    const controller = new AbortController();
    const first = executor.execute({
      json: "null",
      code: "while (true) {}",
      signal: controller.signal,
    });
    expect(await executor.execute({ json: "null", code: "return 1;" })).toEqual(
      { kind: "failure", reason: "busy" },
    );
    controller.abort();
    expect(await first).toEqual({ kind: "failure", reason: "cancelled" });
    expect(await executor.execute({ json: "null", code: "return 2;" })).toEqual(
      { kind: "success", json: "2" },
    );
  });

  it("refuses malformed JSON and a previously cancelled request", async () => {
    const executor = new QuickJsExecutor();
    expect(await executor.execute({ json: "{", code: "return 1;" })).toEqual({
      kind: "failure",
      reason: "invalid_input",
    });
    expect(
      await executor.execute({
        json: "null",
        code: "return 1;",
        signal: AbortSignal.abort(),
      }),
    ).toEqual({ kind: "failure", reason: "cancelled" });
  });

  it.each([
    [
      { maxMemoryBytes: 1_048_576 },
      "return new Array(10_000_000).fill(1).length;",
    ],
    [
      { maxStackBytes: 16_384 },
      "function recurse() { return recurse() + 1; } return recurse();",
    ],
  ])(
    "bounds guest allocation and recursive execution",
    async (limits, code) => {
      const executor = new QuickJsExecutor(limits);
      expect(await executor.execute({ json: "null", code })).toEqual({
        kind: "failure",
        reason: "program_failed",
      });
      expect(
        await executor.execute({ json: "null", code: "return 7;" }),
      ).toEqual({ kind: "success", json: "7" });
    },
  );

  it("refuses configuration that relaxes the published ceilings", () => {
    expect(() => new QuickJsExecutor({ timeoutMs: 2_001 })).toThrow();
    expect(() => new QuickJsExecutor({ maxConcurrent: 3 })).toThrow();
    expect(() => new QuickJsExecutor({ maxInputBytes: 0 })).toThrow();
  });
});
