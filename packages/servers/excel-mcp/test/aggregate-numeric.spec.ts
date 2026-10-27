import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";
import type { ToolInput } from "../src/tools/definitions.js";

type AggregateArguments = ToolInput<"aggregate_sheet">;
type DerivedMetric = NonNullable<AggregateArguments["derived"]>[number];

let directory: string;
let client: Client;
let server: ReturnType<typeof createExcelMcpServer>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-numeric-mcp-"));
  await writeFile(
    join(directory, "large.csv"),
    "Group,Amount,Divisor\nA,1e308,0.5\nB,1e308,0.5\n",
  );
  await writeFile(
    join(directory, "cancellation.csv"),
    "Group,Amount\nA,1e16\nB,1\nC,-1e16\n",
  );
  await writeFile(
    join(directory, "rounding.csv"),
    "Group,Amount,Divisor\nA,1.005,0\n",
  );
});

beforeEach(async () => {
  server = createExcelMcpServer(await createWorkbookRoot(directory));
  client = new Client({ name: "aggregate-numeric-spec", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function aggregate(arguments_: AggregateArguments) {
  const result = await client.callTool({
    name: "aggregate_sheet",
    arguments: arguments_,
  });
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  const payload: unknown = JSON.parse(content.text);
  return { result, payload };
}

const overflowCases = [
  {
    name: "a requested cross-group total",
    derived: {
      name: "share",
      numerator: [{ metric: 1 }],
      denominator: [{ metric: 1, scope: "total" }],
    },
  },
  {
    name: "a denominator term multiplication",
    derived: {
      name: "ratio",
      numerator: [{ metric: 2 }],
      denominator: [{ metric: 1, factor: 2 }],
    },
  },
  {
    name: "a denominator term sum",
    derived: {
      name: "ratio",
      numerator: [{ metric: 2 }],
      denominator: [{ metric: 1 }, { metric: 1 }],
    },
  },
  {
    name: "a numerator term sum before cancellation",
    derived: {
      name: "adjusted",
      numerator: [{ metric: 1 }, { metric: 1 }, { metric: 1, factor: -1 }],
    },
  },
  {
    name: "division",
    derived: {
      name: "ratio",
      numerator: [{ metric: 1 }],
      denominator: [{ metric: 2 }],
    },
  },
  {
    name: "scaling",
    derived: {
      name: "scaled",
      numerator: [{ metric: 1 }],
      scale: 2,
    },
  },
] satisfies readonly { name: string; derived: DerivedMetric }[];

describe.each(["inline", "retained"] as const)(
  "%s aggregate numerical finalization through MCP",
  (resultMode) => {
    const large: AggregateArguments = {
      filePath: "large.csv",
      groupBy: ["Group"],
      columns: [
        { column: "Amount", type: "number", decimal: "." },
        { column: "Divisor", type: "number", decimal: "." },
      ],
      metrics: [
        { fn: "sum", column: "Amount" },
        { fn: "sum", column: "Divisor" },
      ],
      resultMode,
    };

    it.each(overflowCases)("refuses overflow in $name", async ({ derived }) => {
      const { result, payload } = await aggregate({
        ...large,
        derived: [derived],
      });
      expect(result.isError).toBe(true);
      expect(payload).toMatchObject({ error: "numeric_overflow" });
      expect(payload).not.toHaveProperty("resultId");
    });

    it("keeps finite groups when no cross-group total is requested", async () => {
      const { result, payload } = await aggregate(large);
      expect(result.isError).not.toBe(true);
      expect(payload).toMatchObject({
        rows: [
          ["A", 1e308, 0.5],
          ["B", 1e308, 0.5],
        ],
      });
    });

    it("keeps group-only derived metrics without summing their groups", async () => {
      const { result, payload } = await aggregate({
        ...large,
        derived: [
          {
            name: "difference",
            numerator: [{ metric: 1 }, { metric: 1, factor: -1 }],
          },
        ],
      });
      expect(result.isError).not.toBe(true);
      expect(payload).toMatchObject({
        rows: [
          ["A", 1e308, 0.5, 0],
          ["B", 1e308, 0.5, 0],
        ],
      });
    });

    it("only accumulates metric slots referenced with total scope", async () => {
      const { result, payload } = await aggregate({
        ...large,
        metrics: [{ fn: "sum", column: "Amount" }, { fn: "count" }],
        derived: [
          {
            name: "share",
            numerator: [{ metric: 2 }],
            denominator: [{ metric: 2, scope: "total" }],
          },
        ],
      });
      expect(result.isError).not.toBe(true);
      expect(payload).toMatchObject({
        rows: [
          ["A", 1e308, 1, 0.5],
          ["B", 1e308, 1, 0.5],
        ],
      });
    });

    it("preserves the residual of a cancellation-heavy cross-group total", async () => {
      const { result, payload } = await aggregate({
        filePath: "cancellation.csv",
        groupBy: ["Group"],
        columns: [{ column: "Amount", type: "number", decimal: "." }],
        metrics: [{ fn: "sum", column: "Amount" }],
        derived: [
          { name: "total", numerator: [{ metric: 1, scope: "total" }] },
        ],
        resultMode,
      });
      expect(result.isError).not.toBe(true);
      expect(payload).toMatchObject({
        rows: [
          ["A", 1e16, 1],
          ["B", 1, 1],
          ["C", -1e16, 1],
        ],
      });
    });

    it("preserves ROUND boundaries and the zero-denominator warning", async () => {
      const { result, payload } = await aggregate({
        ...large,
        filePath: "rounding.csv",
        derived: [
          { name: "rounded", numerator: [{ metric: 1 }], round: 2 },
          {
            name: "ratio",
            numerator: [{ metric: 1 }],
            denominator: [{ metric: 2 }],
          },
        ],
      });
      expect(result.isError).not.toBe(true);
      expect(payload).toMatchObject({
        rows: [["A", 1.005, 0, 1.01, null]],
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "derived_division_by_zero" }),
        ]),
      });
    });
  },
);
