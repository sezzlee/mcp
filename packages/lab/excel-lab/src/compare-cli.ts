import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareRuns } from "./compare.ts";

const [baselineDir, candidateDir] = process.argv.slice(2);
if (baselineDir === undefined || candidateDir === undefined) {
  process.stderr.write(
    "Usage: node src/compare-cli.ts <baseline run dir> <candidate run dir>\n",
  );
  process.exit(2);
}

const comparison = await compareRuns({ baselineDir, candidateDir });
const report = join(candidateDir, "compare.json");
await writeFile(report, `${JSON.stringify(comparison, null, 2)}\n`);
const { comparisons: _comparisons, ...summary } = comparison;
process.stdout.write(`${JSON.stringify({ ...summary, report }, null, 2)}\n`);
