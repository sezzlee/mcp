import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createExcelMcpServer, createWorkbookRoot } from "@sezzlee/excel-mcp";
import { prepareOutRoot } from "../run.ts";
import { toolResponses } from "./host.ts";
import { replayTrial, type CallReplay } from "./replay.ts";
import { readRunSet } from "./runs.ts";
import { readCatalog } from "./task.ts";
import { buildWorkspace } from "./workspace.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, corpus: { type: "string" } },
  strict: true,
});
const [directory] = positionals;
const corpusRoot = values.corpus ?? process.env["SEZZLEE_CORPUS"];
if (
  directory === undefined ||
  values.out === undefined ||
  corpusRoot === undefined
)
  throw new Error(
    "Usage: node src/agent/replay-cli.ts <run directory> --out <directory outside the repository> --corpus <root>",
  );
const catalog = await readCatalog();
const set = await readRunSet(directory, catalog);
const out = await prepareOutRoot(values.out);
const workspace = await buildWorkspace({
  files: catalog.files,
  corpusRoot,
  outRoot: out,
});
const server = createExcelMcpServer(await createWorkbookRoot(workspace));
const client = new Client({ name: "excel-agent-lab-replay", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([
  client.connect(clientTransport),
  server.connect(serverTransport),
]);

function argsOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

const trials: {
  readonly run: string;
  readonly calls: readonly CallReplay[];
}[] = [];
for (const run of set.runs) {
  const texts = toolResponses(run.trace);
  const recorded = run.callLog.flatMap((call, at) => {
    const text = texts[at];
    return text === undefined || call.error === "unknown_tool"
      ? []
      : [{ tool: call.tool, args: argsOf(call.args), text }];
  });
  const calls = await replayTrial({
    calls: recorded,
    call: async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args });
      return {
        text: result.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n"),
      };
    },
  });
  trials.push({ run: `${run.task} ${run.language} r${run.repetition}`, calls });
}
await client.close();
await server.close();

const all = trials.flatMap((trial) => trial.calls);
const count = (status: CallReplay["status"]): number =>
  all.filter((call) => call.status === status).length;
const tools = [...new Set(all.map((call) => call.tool))].sort();
const excerpt = (value: unknown): string => {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};
const lines = [
  "# Replay",
  "",
  `Replayed the recorded calls of \`${directory}\` against the current server build: ${all.length} calls, ${count("same")} the same, ${count("changed")} changed, ${count("blocked")} blocked by an earlier change.`,
  "",
  "| tool | same | changed | blocked |",
  "| --- | --- | --- | --- |",
  ...tools.map((tool) => {
    const of = all.filter((call) => call.tool === tool);
    return `| ${tool} | ${of.filter((call) => call.status === "same").length} | ${of.filter((call) => call.status === "changed").length} | ${of.filter((call) => call.status === "blocked").length} |`;
  }),
  "",
  "## First change in each run",
  "",
  "| run | call | tool | at | before | after |",
  "| --- | --- | --- | --- | --- | --- |",
  ...trials.flatMap((trial) => {
    const at = trial.calls.findIndex((call) => call.status !== "same");
    const first = trial.calls[at];
    if (first === undefined) return [];
    return [
      first.status === "changed"
        ? `| ${trial.run} | ${at + 1} | ${first.tool} | \`${first.path}\` | \`${excerpt(first.before).replace(/\|/g, "\\|")}\` | \`${excerpt(first.after).replace(/\|/g, "\\|")}\` |`
        : first.status === "blocked"
          ? `| ${trial.run} | ${at + 1} | ${first.tool} | blocked | ${first.reason} | |`
          : "",
    ];
  }),
  "",
];
await writeFile(join(out, "replay.md"), lines.join("\n"));
await writeFile(
  join(out, "replay.jsonl"),
  `${trials.map((trial) => JSON.stringify(trial)).join("\n")}\n`,
);
process.stdout.write(
  `${JSON.stringify({ calls: all.length, same: count("same"), changed: count("changed"), blocked: count("blocked"), out })}\n`,
);
