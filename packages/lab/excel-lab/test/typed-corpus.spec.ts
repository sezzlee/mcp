import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateTypedCorpus, verifyTypedCorpus } from "../src/typed-corpus.ts";

let out: string;
let first: string;
let second: string;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "excel-typed-corpus-"));
  first = await generateTypedCorpus(out, { seed: 0x6b8b4567, rows: 64 });
  second = await generateTypedCorpus(out, { seed: 0x6b8b4567, rows: 64 });
});
afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

describe("original global typed corpus", () => {
  it("reproduces all input and oracle digests for the same seed and ICU", async () => {
    expect(await readFile(join(first, "run.json"), "utf8")).toBe(
      await readFile(join(second, "run.json"), "utf8"),
    );
  });

  it("checks raw text, typed values, totals, predicates, months and reusable profiles through MCP", async () => {
    expect(await verifyTypedCorpus(first)).toMatchObject({
      status: "passed",
      fixtures: 19,
      rows: 1216,
      rawCellsChecked: 7296,
      typedCellsChecked: 7296,
      reusedProfiles: 19,
      mcpCalls: 171,
    });
  }, 30_000);

  it("refuses changed fixture bytes before invoking a tool and saves the replay failure", async () => {
    await writeFile(
      join(second, "typed-global-v1", "files", "en-US-latn.csv"),
      "changed\n",
    );
    await expect(verifyTypedCorpus(second)).rejects.toThrow(
      /byte length changed/,
    );
    expect(
      JSON.parse(await readFile(join(second, "typed-results.json"), "utf8")),
    ).toMatchObject({
      status: "failed",
      fixtures: 0,
      mcpCalls: 0,
      seed: 0x6b8b4567,
    });
  });
});
