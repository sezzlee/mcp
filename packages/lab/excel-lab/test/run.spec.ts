import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileResult } from "../src/record.ts";
import { runCorpus, type RunSummary } from "../src/run.ts";

const sha256 = (data: string): string =>
  createHash("sha256").update(data).digest("hex");

const csv = "region,amount\nEMEA,1\nAPAC,2\n";
const notAZip = "this is plain text, not a zip container";

let root: string;
let summary: RunSummary;
let results: FileResult[];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sezzlee-excel-lab-"));
  const files = join(root, "corpus", "demo", "files");
  await mkdir(files, { recursive: true });
  await writeFile(join(files, "sales.csv"), csv);
  await writeFile(join(files, "broken.xlsx"), notAZip);
  await writeFile(join(files, "tampered.csv"), csv);
  const manifest = [
    { file: "files/sales.csv", sha256: sha256(csv), format: "csv" },
    { file: "files/broken.xlsx", sha256: sha256(notAZip), format: "xlsx" },
    { file: "files/tampered.csv", sha256: "0".repeat(64), format: "csv" },
    { file: "files/gone.xlsx", sha256: sha256("gone"), format: "xlsx" },
  ]
    .map((fields) =>
      JSON.stringify({ ...fields, bytes: 1, license: "CC0-1.0" }),
    )
    .join("\n");
  await writeFile(join(root, "corpus", "demo", "manifest.jsonl"), manifest);

  summary = await runCorpus({
    corpusRoot: join(root, "corpus"),
    outRoot: join(root, "out"),
    timeoutMs: 30_000,
    heapMiB: 512,
  });
  results = (await readFile(join(summary.runDir, "results.jsonl"), "utf8"))
    .trimEnd()
    .split("\n")
    .map((text): FileResult => JSON.parse(text));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function resultFor(file: string): FileResult | undefined {
  return results.find((result) => result.entry.file === file);
}

describe("runCorpus", () => {
  it("reads a valid file through describe_workbook and read_sheet", () => {
    const result = resultFor("files/sales.csv");

    expect(result?.kind).toBe("probed");
    if (result?.kind !== "probed") return;
    expect(result.calls.map((call) => [call.tool, call.outcome])).toEqual([
      ["describe_workbook", { kind: "ok" }],
      ["read_sheet", { kind: "ok" }],
    ]);
    expect(result.sheetsProbed).toBe(1);
  });

  it("records a refused file as a tool error code, not a crash", () => {
    const result = resultFor("files/broken.xlsx");

    expect(result?.kind).toBe("probed");
    if (result?.kind !== "probed") return;
    expect(result.calls.map((call) => [call.tool, call.outcome])).toEqual([
      ["describe_workbook", { kind: "error", code: "not_a_workbook" }],
    ]);
    expect(summary.toolErrors).toEqual({
      "describe_workbook:not_a_workbook": 1,
    });
  });

  it("does not probe bytes that differ from the manifest digest", () => {
    expect(resultFor("files/tampered.csv")).toMatchObject({
      kind: "sha_mismatch",
      actual: sha256(csv),
    });
    expect(resultFor("files/gone.xlsx")?.kind).toBe("missing");
  });

  it("keeps the verbatim responses only for probed files", async () => {
    const written = await readdir(join(summary.runDir, "responses"));

    expect(written.sort()).toEqual(
      [`${sha256(notAZip)}.json`, `${sha256(csv)}.json`].sort(),
    );
    const response = JSON.parse(
      await readFile(
        join(summary.runDir, "responses", `${sha256(csv)}.json`),
        "utf8",
      ),
    );
    expect(response.calls[1].text).toContain("EMEA");
  });

  it("refuses an output root inside the repository", async () => {
    const insideRepository = fileURLToPath(
      new URL("../out-refused", import.meta.url),
    );

    await expect(
      runCorpus({
        corpusRoot: join(root, "corpus"),
        outRoot: insideRepository,
        timeoutMs: 30_000,
        heapMiB: 512,
      }),
    ).rejects.toThrow(/inside the repository/);
    await expect(readdir(insideRepository)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
