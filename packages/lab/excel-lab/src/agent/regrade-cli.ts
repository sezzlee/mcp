import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { RunRecord } from "./agent-run.ts";
import { gradeSubmission, graderVersion } from "./grade.ts";
import { readCatalog } from "./task.ts";

const { positionals } = parseArgs({ allowPositionals: true, strict: true });
const [runsPath] = positionals;
if (runsPath === undefined)
  throw new Error("Usage: node src/agent/regrade-cli.ts <runs.jsonl>");
const catalog = await readCatalog();
const answers = new Map(catalog.tasks.map((task) => [task.id, task.answer]));
const runs: RunRecord[] = (await readFile(runsPath, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const grades = runs.map((run) => {
  const answer = answers.get(run.task);
  return {
    task: run.task,
    language: run.language,
    grade:
      answer === undefined ? null : gradeSubmission(answer, run.submission),
  };
});
const out = join(dirname(runsPath), `grades-${graderVersion}.jsonl`);
await writeFile(
  out,
  `${grades.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
);
process.stdout.write(
  `${JSON.stringify({ runs: runs.length, correct: grades.filter((entry) => entry.grade?.correct === true).length, out })}\n`,
);
