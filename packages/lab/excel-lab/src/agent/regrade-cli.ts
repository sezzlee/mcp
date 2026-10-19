import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { gradeSubmission } from "./grade.ts";
import { readCatalog } from "./task.ts";

const { positionals } = parseArgs({ allowPositionals: true, strict: true });
const [runsPath] = positionals;
if (runsPath === undefined)
  throw new Error("Usage: node src/agent/regrade-cli.ts <runs.jsonl>");
const catalog = await readCatalog();
const answers = new Map(catalog.tasks.map((task) => [task.id, task.answer]));
const lines = (await readFile(runsPath, "utf8")).trim().split("\n");
let changed = 0;
const regraded = lines.map((line) => {
  const record: Record<string, unknown> = JSON.parse(line);
  const answer = answers.get(String(record["task"]));
  const result =
    answer === undefined ? null : gradeSubmission(answer, record["submission"]);
  if (result === null) return record;
  if (result.correct !== record["correct"]) changed += 1;
  return { ...record, correct: result.correct, grade: result };
});
await writeFile(
  runsPath,
  `${regraded.map((record) => JSON.stringify(record)).join("\n")}\n`,
);
process.stdout.write(`${JSON.stringify({ runs: regraded.length, changed })}\n`);
