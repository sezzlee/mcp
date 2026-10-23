import { json, measureJson } from "@sezzlee/file-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellScalar } from "../src/grid/cell-value.js";
import { limits } from "../src/platform/limits.js";
import {
  createResultCapture,
  createResultStore,
  type ResultMetadata,
} from "../src/tools/retained-results.js";

const budget = vi.hoisted(() => ({
  maxResultBytes: undefined as number | undefined,
}));

vi.mock("../src/platform/limits.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/platform/limits.js")>();
  return {
    ...original,
    limits: {
      ...original.limits,
      get maxResultBytes() {
        return budget.maxResultBytes ?? original.limits.maxResultBytes;
      },
    },
  };
});

function metadata(groupCount: number): ResultMetadata {
  return {
    sheet: "Payments",
    range: "A1:C10001",
    usedRange: "A1:C10001",
    headerRow: 1,
    headerRowSource: "declared",
    firstScannedRow: 2,
    scannedRows: 10_000,
    matchedRows: 5_000,
    blankRows: 0,
    groupCount,
    columns: [
      { label: "Customer", role: "group" },
      { label: "sum Amount", role: "metric", fn: "sum" },
    ],
    sourceVersion: "0123456789abcdef",
    sourcePolicy: "snapshot",
  };
}

function capture(rows: readonly (readonly CellScalar[])[]) {
  const captured = createResultCapture();
  rows.forEach((row, index) => captured.add(row, index + 1));
  return captured;
}

afterEach(() => {
  budget.maxResultBytes = undefined;
  vi.useRealTimers();
});

describe("retained result snapshots", () => {
  it("refuses oversized raw text before serializing plain or nested cells", () => {
    budget.maxResultBytes = 64;
    const large = "a".repeat(128);
    const cases: readonly (readonly CellScalar[])[] = [
      [large],
      ["東京".repeat(20)],
      [{ error: large }],
      [{ imageId: 1, altText: large }],
      [
        {
          linkedValue: {
            type: "_linkedentity2",
            displayText: "a".repeat(32),
            entityId: "b".repeat(32),
          },
        },
      ],
      ["a".repeat(32), { error: "b".repeat(32) }],
    ];
    for (const row of cases) {
      const captured = createResultCapture();
      const stringify = vi.spyOn(JSON, "stringify");
      let error: unknown;
      try {
        captured.add(row, 1);
      } catch (failure) {
        error = failure;
      }
      const calls = stringify.mock.calls.length;
      stringify.mockRestore();
      expect(error).toMatchObject({ code: "resource_limit" });
      expect(calls).toBe(0);
      expect(() => captured.snapshot()).toThrowError(
        expect.objectContaining({ code: "resource_limit" }),
      );
    }
  });

  it("queries unshortened keys with exact type-sensitive equality", () => {
    const store = createResultStore();
    const prefix = "q".repeat(limits.maxStringChars + 20);
    const first = store.retain(
      capture([
        [`${prefix}alpha`, 10],
        [`${prefix}beta`, 20],
        [1, 30],
        ["1", 40],
      ]),
      metadata(4),
      2,
    );
    expect(first.rows).toEqual([
      ["q".repeat(limits.maxStringChars), 10],
      ["q".repeat(limits.maxStringChars), 20],
    ]);
    expect(first.valueTruncation.cells).toBe(2);
    const found = store.query({
      resultId: first.resultId,
      where: [{ column: 1, equals: `${prefix}beta` }],
      columns: [2],
    });
    expect(found).toMatchObject({
      totalRows: 4,
      matchingRows: 1,
      matchingSourceRows: 2,
      returnedRows: 1,
      returnedMatchedRows: 2,
      rows: [[20]],
      columnNumbers: [2],
      valueTruncation: { cells: 0 },
    });
    expect(
      store.query({
        resultId: first.resultId,
        where: [{ column: 1, equals: 1 }],
      }).rows,
    ).toEqual([[1, 30]]);
    expect(
      store.query({
        resultId: first.resultId,
        where: [{ column: 1, equals: "1" }],
      }).rows,
    ).toEqual([["1", 40]]);
  });

  it("detaches retained rows and metadata from mutable calculation inputs", () => {
    const store = createResultStore();
    const row: CellScalar[] = ["A", 10];
    const captured = capture([row]);
    const details = metadata(1);
    const first = store.retain(captured, details, 1);
    row[1] = 999;
    captured.add(["B", 20], 2);
    Object.assign(details.columns[0] ?? {}, { label: "Changed" });
    const result = store.query({ resultId: first.resultId });
    expect(result.totalRows).toBe(1);
    expect(result.rows).toEqual([["A", 10]]);
    expect(result.columns[0]?.label).toBe("Customer");
  });

  it("pages after AND filtering in stable result order", () => {
    const store = createResultStore();
    const first = store.retain(
      capture([
        ["A", 1],
        ["B", 1],
        ["A", 1],
        ["A", 2],
        ["A", 1],
      ]),
      metadata(5),
      1,
    );
    const options = {
      resultId: first.resultId,
      where: [
        { column: 1, equals: "A" },
        { column: 2, equals: 1 },
      ],
      columns: [2, 1],
      maxRows: 2,
    };
    const page = store.query(options);
    expect(page).toMatchObject({
      matchingRows: 3,
      matchingSourceRows: 9,
      returnedRows: 2,
      returnedMatchedRows: 4,
      nextOffset: 2,
      rows: [
        [1, "A"],
        [1, "A"],
      ],
    });
    const last = store.query({ ...options, offset: page.nextOffset });
    expect(last).toMatchObject({
      offset: 2,
      returnedRows: 1,
      returnedMatchedRows: 5,
      rows: [[1, "A"]],
      hasMore: false,
    });
    expect(last.nextOffset).toBeUndefined();
    expect(store.query(options)).toEqual(page);
  });

  it("does not extend absolute expiry when queried and never shares IDs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = createResultStore();
    const first = store.retain(capture([["A", 1]]), metadata(1), 1);
    const other = createResultStore();
    expect(() => other.query({ resultId: first.resultId })).toThrowError(
      expect.objectContaining({ code: "result_unavailable" }),
    );
    vi.setSystemTime(Date.now() + limits.resultTtlMs - 1);
    expect(store.query({ resultId: first.resultId }).rows).toEqual([["A", 1]]);
    vi.setSystemTime(Date.now() + 1);
    expect(() => store.query({ resultId: first.resultId })).toThrowError(
      expect.objectContaining({ code: "result_unavailable" }),
    );
    const second = store.retain(capture([["B", 2]]), metadata(1), 1);
    store.clear();
    expect(() => store.query({ resultId: second.resultId })).toThrowError(
      expect.objectContaining({ code: "result_unavailable" }),
    );
  });

  it("counts JSON escaping and Unicode in the actual serialized page budget", () => {
    const store = createResultStore();
    const text = '\\"東京'.repeat(100);
    const rows = Array.from({ length: 40 }, (_item, index) => [text, index]);
    const first = store.retain(capture(rows), metadata(40), 40);
    expect(first.returnedRows).toBeGreaterThan(0);
    expect(first.returnedRows).toBeLessThan(40);
    expect(measureJson(json(first))).toBeLessThanOrEqual(
      limits.maxResultPageBytes,
    );
    const seen: number[] = [];
    let offset = 0;
    for (;;) {
      const page = store.query({
        resultId: first.resultId,
        offset,
        maxRows: 40,
      });
      expect(measureJson(json(page))).toBeLessThanOrEqual(
        limits.maxResultPageBytes,
      );
      seen.push(...page.rows.map((row) => Number(row[1])));
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(seen).toEqual(Array.from({ length: 40 }, (_item, index) => index));
  });

  it("distinguishes an empty complete filter from an out-of-range offset", () => {
    const store = createResultStore();
    const first = store.retain(capture([["A", 1]]), metadata(1), 1);
    expect(
      store.query({
        resultId: first.resultId,
        where: [{ column: 1, equals: "absent" }],
      }),
    ).toMatchObject({
      resultComplete: true,
      sampled: false,
      matchingRows: 0,
      returnedRows: 0,
      hasMore: false,
      rows: [],
    });
    expect(() =>
      store.query({ resultId: first.resultId, offset: 2 }),
    ).toThrowError(expect.objectContaining({ code: "invalid_argument" }));
  });
});
