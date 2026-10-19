import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateTypedCorpus, verifyTypedCorpus } from "../src/typed-corpus.ts";

let out: string;
let first: string;
let second: string;
let legacy: string;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "excel-typed-corpus-"));
  first = await generateTypedCorpus(out, { seed: 0x6b8b4567, rows: 64 });
  second = await generateTypedCorpus(out, { seed: 0x6b8b4567, rows: 64 });
  legacy = join(out, "legacy");
  const directory = join(legacy, "typed-global-v1");
  await mkdir(join(directory, "files"), { recursive: true });
  await mkdir(join(directory, "expected"));
  const csv =
    "Group,Amount,Identifier,Date,Flag,Elapsed\r\nG0,10,001,13 March 2026,yes,PT1S\r\nG1,20,002,13 April 2026,no,PT2S\r\n";
  const expected = JSON.stringify({
    config: {
      id: "legacy",
      locale: "en-US",
      numberingSystem: "latn",
      trueText: "yes",
      falseText: "no",
      missingText: "missing",
    },
    raw: [
      ["G0", "10", "001", "13 March 2026", "yes", "PT1S"],
      ["G1", "20", "002", "13 April 2026", "no", "PT2S"],
    ],
    typed: [
      ["G0", 10, "001", "2026-03-13", true, { durationSeconds: 1 }],
      ["G1", 20, "002", "2026-04-13", false, { durationSeconds: 2 }],
    ],
    groups: [
      ["G0", 10, 1, 1],
      ["G1", 20, 2, 1],
    ],
    months: [
      ["2026-03", 1],
      ["2026-04", 1],
    ],
    trueCount: 1,
    trueSum: 10,
  });
  await writeFile(join(directory, "files", "legacy.csv"), csv);
  await writeFile(join(directory, "expected", "legacy.json"), expected);
  await writeFile(
    join(legacy, "run.json"),
    JSON.stringify({
      generator: "typed-global-v1",
      seed: 1,
      rows: 2,
      node: "independent legacy wire fixture",
      icu: "not used to author these bytes",
      cldr: "not used to author these bytes",
      unicode: "not used to author these bytes",
      fixtures: [
        {
          id: "legacy",
          bytes: Buffer.byteLength(csv),
          sha256: createHash("sha256").update(csv).digest("hex"),
          expectedSha256: createHash("sha256").update(expected).digest("hex"),
        },
      ],
    }),
  );
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

  it("checks whole Intl dates, numeric digit scripts, explicit-only boundaries and profile-reused civil dates through MCP", async () => {
    const result = await verifyTypedCorpus(first);
    expect(result).toMatchObject({
      status: "passed",
      generator: "typed-global-v2",
      fixtures: 37,
      rows: 2368,
      rawCellsChecked: 14208,
      typedCellsChecked: 14208,
      reusedProfiles: 37,
      inferredDateFixtures: 33,
      reusedDateProfiles: 33,
      profiledDateCellsChecked: 2368,
    });
    expect(result.automaticDateBoundaries).toHaveLength(4);
  }, 30_000);

  it("replays an independently authored v1 wire fixture without relabeling its source or requiring new metadata", async () => {
    expect(await verifyTypedCorpus(legacy)).toMatchObject({
      status: "passed",
      generator: "typed-global-v1",
      generatorSha256: null,
      fixtures: 1,
      rows: 2,
      inferredDateFixtures: 1,
      reusedDateProfiles: 1,
      profiledDateCellsChecked: 2,
      automaticDateBoundaries: [],
    });
  });

  it("refuses changed fixture bytes before invoking a tool and saves the replay failure", async () => {
    await writeFile(
      join(second, "typed-global-v2", "files", "en-US-latn.csv"),
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
