import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { limits } from "../src/host/platform/limits.js";
import { bodyOf, createHarness, type Harness } from "./fixtures/harness.js";

type ProjectArgs = Parameters<Harness["handlers"]["project_records"]>[0];
type AggregateArgs = Parameters<Harness["handlers"]["aggregate_document"]>[0];

interface Row {
  readonly occurrence: number;
  readonly cells: readonly {
    readonly status: string;
    readonly value?: string;
    readonly truncated?: true;
  }[];
}

const prefix = "p".repeat(limits.maxStringChars + 40);

const catalogue = {
  ancestors: [{ namespaceUri: "", localName: "catalogue" }],
  name: { namespaceUri: "", localName: "entry" },
};

const codeColumn = {
  label: "code",
  value: { from: "attribute", namespaceUri: "", localName: "code" },
};

const nameColumn = {
  label: "name",
  name: { namespaceUri: "", localName: "name" },
};

let directory: string;
let resident: Harness;
let chunked: Harness;

function entries(count: number, name: (index: number) => string): string {
  const parts = ["<catalogue>"];
  for (let index = 1; index <= count; index += 1) {
    parts.push(
      `<entry code="${String(index)}"><name>${name(index)}</name></entry>`,
    );
  }
  parts.push("</catalogue>");
  return parts.join("");
}

async function project(
  harness: Harness,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return bodyOf(await harness.handlers.project_records(args as ProjectArgs));
}

async function everyPage(
  harness: Harness,
  args: Record<string, unknown>,
): Promise<readonly Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1_000; page += 1) {
    const body = await project(harness, {
      ...args,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (typeof body["error"] === "string") {
      throw new Error(`${body["error"]}: ${String(body["message"])}`);
    }
    rows.push(...(body["rows"] as readonly Row[]));
    cursor = body["nextCursor"] as string | undefined;
    if (cursor === undefined) return rows;
  }
  throw new Error("the cursor never ran out");
}

const codesOf = (rows: readonly Row[]): readonly string[] =>
  rows.map((row) => String(row.cells[0]?.value));

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xml-record-paging-"));
  await writeFile(
    join(directory, "gaps.xml"),
    entries(60, (index) => (index % 10 === 0 ? "keep" : "skip")),
  );
  for (const count of [
    limits.maxItemVisits - 1,
    limits.maxItemVisits,
    limits.maxItemVisits + 1,
  ]) {
    await writeFile(
      join(directory, `last-${String(count)}.xml`),
      entries(count, (index) => (index === count ? "last" : "")),
    );
  }
  await writeFile(
    join(directory, "long.xml"),
    [
      "<catalogue>",
      `<entry code="${prefix}ALPHA"><name>${prefix}ALPHA</name></entry>`,
      `<entry code="${prefix}BETA"><name>${prefix}BETA</name></entry>`,
      "</catalogue>",
    ].join(""),
  );
  await writeFile(
    join(directory, "ledger.xml"),
    [
      "<ledger>",
      "<row><cur>A</cur><amount>60</amount></row>",
      "<row><cur>A</cur><amount>60</amount></row>",
      "<row><cur>B</cur><amount>100</amount></row>",
      "<row><cur>C</cur><amount>n/a</amount></row>",
      "</ledger>",
    ].join(""),
  );
  const pagingPool = { budgetMs: 30_000 };
  resident = await createHarness(directory, pagingPool);
  chunked = await createHarness(directory, pagingPool, 1);
});

afterAll(async () => {
  await resident.close();
  await chunked.close();
  await rm(directory, { recursive: true, force: true });
});

describe.each([
  ["resident", () => resident],
  ["chunked", () => chunked],
])("%s paging", (_mode, harnessOf) => {
  it("returns each filtered match once across one-row pages", async () => {
    const rows = await everyPage(harnessOf(), {
      filePath: "gaps.xml",
      itemAddress: catalogue,
      columns: [codeColumn, nameColumn],
      where: [{ column: "name", op: "eq", value: "keep" }],
      maxRows: 1,
    });
    expect(codesOf(rows)).toStrictEqual(["10", "20", "30", "40", "50", "60"]);
  });

  it("returns every record once across unfiltered pages", async () => {
    const rows = await everyPage(harnessOf(), {
      filePath: "gaps.xml",
      itemAddress: catalogue,
      columns: [codeColumn],
      maxRows: 7,
    });
    expect(codesOf(rows)).toStrictEqual(
      Array.from({ length: 60 }, (_, index) => String(index + 1)),
    );
  });

  /**
   * Guard: each case pages through about 50,000 records, measured at 5.00–5.02 s on GitHub's
   * darwin-x64 Node 24 runner against vitest's 5 s default, while every other target finishes well
   * under it.
   * The fixture pool also allows 30 s so these record-visit checks do not depend on CPU contention;
   * worker-lifecycle.spec.ts separately verifies deadline failure.
   */
  it.each([
    limits.maxItemVisits - 1,
    limits.maxItemVisits,
    limits.maxItemVisits + 1,
  ])(
    "reaches the last of %i records past the scan budget",
    async (count) => {
      const rows = await everyPage(harnessOf(), {
        filePath: `last-${String(count)}.xml`,
        itemAddress: catalogue,
        columns: [codeColumn, nameColumn],
        where: [{ column: "name", op: "eq", value: "last" }],
      });
      expect(codesOf(rows)).toStrictEqual([String(count)]);
    },
    30_000,
  );

  it("filters on the whole value and returns the shortened one", async () => {
    for (const column of ["code", "name"]) {
      const rows = await everyPage(harnessOf(), {
        filePath: "long.xml",
        itemAddress: catalogue,
        columns: [codeColumn, nameColumn],
        where: [{ column, op: "endsWith", value: "ALPHA" }],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.cells[0]).toMatchObject({ truncated: true });
      expect(rows[0]?.cells[0]?.value).toHaveLength(limits.maxStringChars);
    }
  });
});

describe("aggregate_document", () => {
  async function aggregate(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return bodyOf(
      await resident.handlers.aggregate_document(args as AggregateArgs),
    );
  }

  it("keeps long values apart in distinct counts and group keys", async () => {
    for (const column of ["code", "name"]) {
      const distinct = await aggregate({
        filePath: "long.xml",
        itemAddress: catalogue,
        columns: [codeColumn, nameColumn],
        metrics: [{ fn: "countDistinct", column }],
      });
      expect(distinct["groups"]).toMatchObject([
        { metrics: [{ kind: "count", value: 2 }] },
      ]);

      const grouped = await aggregate({
        filePath: "long.xml",
        itemAddress: catalogue,
        columns: [codeColumn, nameColumn],
        groupBy: [column],
        metrics: [{ fn: "count" }],
      });
      expect(grouped["groupCount"]).toBe(2);
    }
  });

  const ledger = {
    filePath: "ledger.xml",
    itemAddress: {
      ancestors: [{ namespaceUri: "", localName: "ledger" }],
      name: { namespaceUri: "", localName: "row" },
    },
    columns: [
      { label: "cur", name: { namespaceUri: "", localName: "cur" } },
      { label: "amount", name: { namespaceUri: "", localName: "amount" } },
    ],
    groupBy: ["cur"],
    metrics: [{ fn: "avg", column: "amount" }],
    numericMode: "binary64",
    orderBy: "metric",
  };

  const keysOf = (body: Record<string, unknown>): readonly string[] =>
    (body["groups"] as readonly { key: readonly { value: string }[] }[]).map(
      (group) => String(group.key[0]?.value),
    );

  it("orders by the average, not the running total", async () => {
    const top = await aggregate({ ...ledger, descending: true, maxGroups: 1 });
    expect(keysOf(top)).toStrictEqual(["B"]);
  });

  it("puts an undefined average last in either direction", async () => {
    expect(
      keysOf(await aggregate({ ...ledger, descending: true })),
    ).toStrictEqual(["B", "A", "C"]);
    expect(
      keysOf(await aggregate({ ...ledger, descending: false })),
    ).toStrictEqual(["A", "B", "C"]);
  });
});
