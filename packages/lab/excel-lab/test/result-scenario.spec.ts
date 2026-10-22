import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateResultScenario,
  runResultScenario,
} from "../src/result-scenario.ts";

let out: string;
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "excel-result-scenario-test-"));
});
afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

describe("retained aggregation scenario through MCP", () => {
  it("retains complete overdue balances, finds a customer beyond the preview and projects every page", async () => {
    const fixture = await generateResultScenario(out);
    const report = await runResultScenario({ ...fixture, outRoot: out });
    expect(report).toMatchObject({
      status: "passed",
      sourceRows: 6000,
      matchedRows: 2400,
      resultRows: 1200,
      previewRows: 50,
      verifiedRows: 1201,
    });
    const aggregate = report.calls.filter(
      (call) => call.name === "aggregate_sheet",
    );
    expect(aggregate).toHaveLength(2);
    expect(
      report.calls.some(
        (call) => call.name === "query_result" && call.returnedRows === 1,
      ),
    ).toBe(true);
    expect(
      report.calls.every((call) => call.responseBytes > call.textBytes),
    ).toBe(true);
    expect(
      JSON.parse(await readFile(join(report.runDir, "report.json"), "utf8")),
    ).toMatchObject({ status: "passed" });
  });

  it("generates identical fixture bytes and independent expectations for replay", async () => {
    const first = await generateResultScenario(out);
    const second = await generateResultScenario(out);
    expect(await readFile(first.scenario, "utf8")).toBe(
      await readFile(second.scenario, "utf8"),
    );
    expect(await readFile(join(first.root, "payments.csv"), "utf8")).toBe(
      await readFile(join(second.root, "payments.csv"), "utf8"),
    );
  });

  it("uses configured CSV encoding and delimiter during discovery before a custom retained calculation", async () => {
    const root = await mkdtemp(join(out, "custom-csv-"));
    await writeFile(
      join(root, "payments.csv"),
      Buffer.from(
        "Customer,Code;Amount\nCafé,X;12.5\nCafé,X;7.5\nOther,Y;9\n",
        "latin1",
      ),
    );
    const scenario = join(root, "scenario.json");
    await writeFile(
      scenario,
      JSON.stringify({
        schemaVersion: 1,
        label: "configured-csv",
        aggregate: {
          filePath: "payments.csv",
          delimiter: "semicolon",
          encoding: "windows-1252",
          headerRow: 1,
          columnMode: "header",
          columns: [
            { column: "Customer,Code", type: "text" },
            {
              column: "Amount",
              type: "number",
              decimal: ".",
              group: "none",
            },
          ],
          groupBy: ["Customer,Code"],
          metrics: [{ fn: "sum", column: "Amount" }, { fn: "count" }],
        },
        expected: {
          scannedRows: 3,
          matchedRows: 3,
          resultRows: 2,
          previewMaxRows: 50,
        },
        queries: [
          {
            arguments: { where: [{ column: 1, equals: "Café,X" }] },
            rows: [["Café,X", 20, 2]],
            matchingSourceRows: 2,
          },
        ],
      }),
    );
    const report = await runResultScenario({ root, scenario, outRoot: out });
    expect(report).toMatchObject({
      status: "passed",
      sourceRows: 3,
      resultRows: 2,
      verifiedRows: 1,
    });
  });
});
