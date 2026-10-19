import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createExcelMcpServer, createWorkbookRoot } from "@sezzlee/excel-mcp";
import { z } from "zod";
import { matchesAnswer } from "./grade.ts";
import {
  catalogFilesSchema,
  catalogPath,
  taskSchema,
  type Field,
  type Task,
} from "./task.ts";
import { buildWorkspace } from "./workspace.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string" },
    only: { type: "string" },
    bodies: { type: "boolean", default: false },
  },
  strict: true,
});
const corpusRoot = values.corpus ?? process.env["SEZZLEE_CORPUS"];
if (values.out === undefined || corpusRoot === undefined)
  throw new Error(
    "Pass --out <directory outside the repository> and --corpus <root> (or SEZZLEE_CORPUS).",
  );
const raw = z
  .looseObject({ files: catalogFilesSchema, tasks: z.array(taskSchema) })
  .parse(JSON.parse(await readFile(catalogPath, "utf8")));
const only = values.only?.split(",");
const workspace = await buildWorkspace({
  files: raw.files,
  corpusRoot,
  outRoot: values.out,
});
const server = createExcelMcpServer(await createWorkbookRoot(workspace));
const client = new Client({ name: "excel-agent-lab", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([
  client.connect(clientTransport),
  server.connect(serverTransport),
]);

function escape(part: string): string {
  return part.replace(/~/g, "~0").replace(/\//g, "~1");
}

function* leaves(
  value: unknown,
  path: string,
): Generator<readonly [string, unknown]> {
  if (Array.isArray(value))
    for (const [index, item] of value.entries())
      yield* leaves(item, `${path}/${index}`);
  else if (typeof value === "object" && value !== null)
    for (const [key, item] of Object.entries(value))
      yield* leaves(item, `${path}/${escape(key)}`);
  else yield [path, value];
}

function candidates(
  field: Field,
  bodies: readonly unknown[],
): readonly (readonly [number, string])[] {
  return bodies.flatMap((body, step) =>
    [...leaves(body, "")]
      .filter(([, value]) => matchesAnswer(field, value).same)
      .map(([path]) => [step, path] as const),
  );
}

async function propose(task: Task): Promise<unknown> {
  const bodies: unknown[] = [];
  for (const planned of task.plan.steps) {
    const result = await client.callTool({
      name: planned.tool,
      arguments: planned.args,
    });
    const text = result.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    try {
      bodies.push(result.isError === true ? null : JSON.parse(text));
    } catch {
      bodies.push(null);
    }
  }
  if (values.bodies)
    process.stdout.write(
      `${JSON.stringify({ task: task.id, steps: task.plan.steps.map((planned, at) => ({ tool: planned.tool, role: planned.role, args: planned.args, body: bodies[at] })) })}\n`,
    );
  const { answer } = task;
  switch (answer.kind) {
    case "integer":
    case "decimal":
    case "percent":
    case "text":
    case "date":
    case "month":
    case "localDateTime":
      return { value: candidates(answer, bodies).slice(0, 6) };
    case "record":
      return Object.fromEntries(
        Object.entries(answer.fields).map(([key, field]) => [
          key,
          candidates(field, bodies).slice(0, 6),
        ]),
      );
    case "list":
    case "set":
      return answer.items.map((item) => candidates(item, bodies).slice(0, 4));
    case "refusal":
      return { refusal: answer.reason };
    default: {
      const exhaustive: never = answer;
      return exhaustive;
    }
  }
}

for (const task of raw.tasks) {
  if (only !== undefined && !only.includes(task.id)) continue;
  process.stdout.write(
    `${JSON.stringify({ task: task.id, has: task.plan.derive !== undefined, candidates: await propose(task) })}\n`,
  );
}
await client.close();
await server.close();
