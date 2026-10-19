import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { graderVersion } from "./grade.ts";
import { readRunSet } from "./runs.ts";
import { readCatalog } from "./task.ts";

const { positionals } = parseArgs({ allowPositionals: true, strict: true });
const [directory] = positionals;
if (directory === undefined)
  throw new Error("Usage: node src/agent/regrade-cli.ts <run directory>");
const set = await readRunSet(directory, await readCatalog());
const out = join(directory, `grades-${graderVersion}.jsonl`);
await writeFile(
  out,
  `${set.runs
    .map((run) =>
      JSON.stringify({
        task: run.task,
        language: run.language,
        repetition: run.repetition,
        grade: run.grade,
      }),
    )
    .join("\n")}\n`,
);
process.stdout.write(
  `${JSON.stringify({ runs: set.runs.length, correct: set.runs.filter((run) => run.correct).length, out })}\n`,
);
