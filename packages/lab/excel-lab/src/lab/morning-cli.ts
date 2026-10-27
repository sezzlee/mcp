import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { lines } from "./jsonl.ts";
import { compare, render, summarize, type NightTrial } from "./morning.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { against: { type: "string" } },
});
const night = z.string().min(1).parse(positionals[0]);

const recordSchema = z.object({
  id: z.string(),
  language: z.string(),
  passed: z.boolean(),
  failure: z.string().nullable(),
  directory: z.string(),
  calls: z.object({
    dispatched: z.number(),
    refusedCatalog: z.number(),
    refusedBudget: z.number(),
  }),
});
const keySchema = z.object({
  key: z.object({ repetition: z.number() }),
});
const toolLine = z.object({
  tool: z.string(),
  isError: z.boolean(),
  result: z.unknown(),
});
const chainSchema = z.object({
  writes: z.array(z.object({ tool: z.string(), sourced: z.boolean() })),
});

async function tools(directory: string): Promise<NightTrial["tools"]> {
  const calls: { tool: string; error: string | null }[] = [];
  for await (const line of lines(join(directory, "trace.jsonl"))) {
    const parsed = toolLine.safeParse(JSON.parse(line));
    if (!parsed.success) continue;
    const error = z.object({ error: z.string() }).safeParse(parsed.data.result);
    calls.push({
      tool: parsed.data.tool,
      error: parsed.data.isError
        ? error.success
          ? error.data.error
          : "unparsed"
        : null,
    });
  }
  return calls;
}

async function conditionTrials(
  directory: string,
  model: string,
): Promise<NightTrial[]> {
  const records: z.infer<typeof recordSchema>[] = [];
  for await (const line of lines(join(directory, "results.jsonl")))
    records.push(recordSchema.parse(JSON.parse(line)));
  const keys: number[] = [];
  for await (const line of lines(join(directory, "trials.jsonl")))
    keys.push(keySchema.parse(JSON.parse(line)).key.repetition);
  const trials: NightTrial[] = [];
  for (const [index, record] of records.entries()) {
    const chain = await readFile(
      join(record.directory, "chain.json"),
      "utf8",
    ).catch(() => null);
    trials.push({
      model,
      id: record.id,
      language: record.language,
      repetition: keys[index] ?? 0,
      passed: record.passed,
      failure: record.failure,
      dispatched: record.calls.dispatched,
      refusedCatalog: record.calls.refusedCatalog,
      refusedBudget: record.calls.refusedBudget,
      tools: await tools(record.directory),
      writes: chain === null ? [] : chainSchema.parse(JSON.parse(chain)).writes,
    });
  }
  return trials;
}

async function trialsOf(root: string): Promise<NightTrial[]> {
  const trials: NightTrial[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "scripted") continue;
    const modelDirectory = join(root, entry.name);
    const host = await readFile(
      join(modelDirectory, "host.json"),
      "utf8",
    ).catch(() => null);
    if (host === null) continue;
    const model =
      z.object({ model: z.string() }).safeParse(JSON.parse(host)).data?.model ??
      entry.name;
    for (const condition of await readdir(modelDirectory, {
      withFileTypes: true,
    }))
      if (condition.isDirectory())
        trials.push(
          ...(await conditionTrials(
            join(modelDirectory, condition.name),
            `${model} ${condition.name}`,
          )),
        );
  }
  return trials;
}

const status = z
  .object({ gate: z.string(), stopped: z.boolean() })
  .parse(JSON.parse(await readFile(join(night, "night.json"), "utf8")));
const trials = await trialsOf(night);
const morning = summarize(trials);
const comparison =
  values.against === undefined
    ? undefined
    : compare(await trialsOf(values.against), trials);
await writeFile(
  join(night, "report.json"),
  JSON.stringify(
    { ...status, morning, comparison: comparison ?? null },
    null,
    2,
  ),
);
const report = render({
  night: basename(night),
  gate: status.gate,
  stopped: status.stopped,
  morning,
  ...(comparison === undefined ? {} : { comparison }),
});
await writeFile(join(night, "report.md"), report);
process.stdout.write(report + "\n");
