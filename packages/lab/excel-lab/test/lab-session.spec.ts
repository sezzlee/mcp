import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openSession } from "../src/lab/session.ts";

it("counts identical failures without merging failures after a newly observed source version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lab-session-"));
  const session = await openSession(directory);
  try {
    await session.call("describe_workbook", { filePath: "missing.csv" });
    await session.call("describe_workbook", { filePath: "missing.csv" });
    expect(session.repeatedErrors).toMatchObject([
      { tool: "describe_workbook", count: 2 },
    ]);
    await writeFile(join(directory, "data.csv"), "A\n1\n");
    expect(
      (await session.call("describe_workbook", { filePath: "data.csv" }))
        .isError,
    ).toBe(false);
    await session.call("describe_workbook", { filePath: "missing.csv" });
    expect(session.repeatedErrors).toMatchObject([
      { tool: "describe_workbook", count: 2 },
    ]);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});
