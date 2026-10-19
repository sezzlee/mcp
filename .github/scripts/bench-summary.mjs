import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const lines = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sides = Object.fromEntries(
  ["base", "head"].map((side) => [
    side,
    lines(join(root, side, "aggregate-results.jsonl")),
  ]),
);
const metrics = [
  ["First call (ms)", "firstCallMs", 1],
  ["Cached call (ms)", "cachedCallMs", 1],
  ["Peak RSS (MiB)", "maxRssKiB", 1024],
];
const cell = (records, key, scale) => {
  const values = records.map((record) => record[key] / scale);
  return `${median(values).toFixed(0)} (${Math.min(...values).toFixed(0)}–${Math.max(...values).toFixed(0)})`;
};
const out = [
  "## Excel aggregate benchmark",
  "",
  `2,000,000 cells, ${sides.head.length} alternating trials per side, median (min–max).`,
  `Base \`${sides.base[0].revision.slice(0, 8)}\`${sides.base[0].legacyCoerceText ? " with coerceText" : ""}, head \`${sides.head[0].revision.slice(0, 8)}\`, ${sides.head[0].cpu}, Node ${sides.head[0].node}.`,
  "",
  "| | Base | Head | Head / base |",
  "| --- | --- | --- | --- |",
  ...metrics.map(([label, key, scale]) => {
    const ratio =
      median(sides.head.map((record) => record[key])) /
      median(sides.base.map((record) => record[key]));
    return `| ${label} | ${cell(sides.base, key, scale)} | ${cell(sides.head, key, scale)} | ${ratio.toFixed(2)} |`;
  }),
];
const typed = lines(join(root, "typed.jsonl")).find(
  (record) => record.status !== undefined,
);
if (typed !== undefined)
  out.push(
    "",
    `Typed corpus: ${typed.status}, ${typed.fixtures} locale fixtures, ${typed.typedCellsChecked} typed cells, ${typed.mcpCalls} MCP calls in ${Math.round(typed.ms)} ms (ICU ${typed.icu}, CLDR ${typed.cldr}).`,
  );
process.stdout.write(`${out.join("\n")}\n`);
