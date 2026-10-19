import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runBaseline } from "./baseline.ts";
import { readCatalog } from "./task.ts";
import { buildWorkspace } from "./workspace.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string" },
    only: { type: "string" },
  },
  strict: true,
});
const corpusRoot = values.corpus ?? process.env["SEZZLEE_CORPUS"];
if (values.out === undefined || corpusRoot === undefined)
  throw new Error(
    "Pass --out <directory outside the repository> and --corpus <root> (or SEZZLEE_CORPUS).",
  );
const full = await readCatalog();
const only = values.only?.split(",");
const catalog =
  only === undefined
    ? full
    : { ...full, tasks: full.tasks.filter((task) => only.includes(task.id)) };
const workspace = await buildWorkspace({
  catalog: full,
  corpusRoot,
  outRoot: values.out,
});
const results = await runBaseline({
  catalog,
  workspace,
  onTask: (result) =>
    process.stdout.write(
      `${result.outcome.padEnd(16)} ${String(result.calls).padStart(2)} calls ${String(result.bytes).padStart(7)} B ${result.id}${result.missing.length > 0 ? ` missing ${result.missing.join(", ")}` : ""}${result.steps
        .filter((step) => step.error !== null)
        .map((step) => ` [${step.tool}: ${step.error}]`)
        .join("")}\n`,
    ),
});
const counts: Record<string, number> = {};
for (const result of results)
  counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
const summary = {
  tasks: results.length,
  outcomes: counts,
  calls: results.reduce((sum, result) => sum + result.calls, 0),
  bytes: results.reduce((sum, result) => sum + result.bytes, 0),
  node: process.version,
};
await writeFile(
  join(values.out, "baseline.json"),
  `${JSON.stringify({ summary, results }, null, 1)}\n`,
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
