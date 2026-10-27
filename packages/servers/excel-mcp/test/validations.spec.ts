import { describe, expect, inject, it } from "vitest";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
  type SandboxedPath,
} from "../src/platform/paths.js";
import {
  collectValidations,
  compressAddresses,
} from "../src/metadata/validations.js";
import { loadDocument, type LoadedWorkbook } from "../src/format/document.js";

function addresses(column: string, from: number, to: number): string[] {
  const list: string[] = [];
  for (let row = from; row <= to; row += 1) {
    list.push(`${column}${row}`);
  }
  return list;
}

async function loadXlsx(path: SandboxedPath): Promise<LoadedWorkbook> {
  const loaded = await loadDocument(path);
  if (loaded.format !== "xlsx") {
    throw new Error("expected an xlsx fixture");
  }
  return loaded;
}

describe("compressAddresses", () => {
  it("collapses a single column run", () => {
    expect(compressAddresses(addresses("A", 2, 100))).toEqual(["A2:A100"]);
  });

  it("keeps a lone cell short", () => {
    expect(compressAddresses(["B7"])).toEqual(["B7"]);
  });

  it("merges adjacent columns with identical runs", () => {
    expect(
      compressAddresses([...addresses("A", 2, 5), ...addresses("B", 2, 5)]),
    ).toEqual(["A2:B5"]);
  });

  it("keeps non-adjacent columns apart", () => {
    expect(
      compressAddresses([...addresses("A", 2, 5), ...addresses("C", 2, 5)]),
    ).toEqual(["A2:A5", "C2:C5"]);
  });

  it("splits a column with a gap into two runs", () => {
    expect(
      compressAddresses([...addresses("A", 2, 4), ...addresses("A", 8, 9)]),
    ).toEqual(["A2:A4", "A8:A9"]);
  });

  it("is order independent", () => {
    const shuffled = ["A4", "A2", "A3"];
    expect(compressAddresses(shuffled)).toEqual(["A2:A4"]);
  });
});

describe("collectValidations", () => {
  it("reports each stored rule as its own entry with its sqref ranges", async () => {
    const fixtures = inject("fixtures");
    const root = await createWorkbookRoot(fixtures.root);
    const loaded = await loadXlsx(
      await resolveWorkbookPath(root, "validations.xlsx"),
    );
    const report = collectValidations(
      "Data",
      loaded.workbook.facts("Data").validations,
    );

    expect(report.coveredCellCount).toBeGreaterThan(5000);
    expect(report.count).toBe(3);
    expect(report.rangesTruncated).toBe(false);

    const lists = report.rules.filter((rule) => rule.type === "list");
    expect(lists.map((rule) => rule.ranges)).toEqual([
      ["A2:A5000"],
      ["C2:C10"],
    ]);
    expect(lists.every((rule) => rule.allowBlank === true)).toBe(true);

    const whole = report.rules.find((rule) => rule.type === "whole");
    expect(whole?.ranges).toEqual(["E2:E10"]);
    expect(whole?.operator).toBe("greaterThan");
  });
});
