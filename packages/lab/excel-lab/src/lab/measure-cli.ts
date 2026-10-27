import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createExcelMcpServer,
  createWorkbookOutput,
  createWorkbookRoot,
} from "@sezzlee/excel-mcp";
import { z } from "zod";
import { toolSpecsOf } from "../agent/agent-run.ts";
import type { ToolSpec } from "../agent/host.ts";
import { prepareOutRoot } from "../run.ts";
import { catalogCost } from "./measure.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    condition: { type: "string", multiple: true },
  },
});
const options = z
  .object({
    out: z.string().min(1),
    condition: z
      .array(z.string().regex(/^[a-z0-9_-]+=[a-z_]+(?:,[a-z_]+)*$/))
      .default([]),
  })
  .parse(values);

const out = await prepareOutRoot(options.out);
const workspace = join(out, "workspace");
await mkdir(join(workspace, "out"), { recursive: true });

async function listed(mode: "read" | "write"): Promise<readonly ToolSpec[]> {
  const root = await createWorkbookRoot(workspace);
  const server =
    mode === "read"
      ? createExcelMcpServer(root)
      : createExcelMcpServer(root, {
          mode: "write",
          output: await createWorkbookOutput(root, "out"),
        });
  const client = new Client({ name: "excel-lab-measure", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    return await toolSpecsOf(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const read = await listed("read");
const write = await listed("write");
const named = options.condition.map((entry) => {
  const [condition = "", list = ""] = entry.split("=");
  const names = list.split(",");
  const specs = names.map((name) => {
    const spec = write.find((tool) => tool.function.name === name);
    if (spec === undefined)
      throw new Error(`Condition ${condition} names unknown tool ${name}.`);
    return spec;
  });
  return catalogCost(condition, specs);
});
const report = {
  conditions: [
    catalogCost("read", read),
    catalogCost("write", write),
    ...named,
  ],
};
await writeFile(join(out, "tools-read.json"), JSON.stringify(read, null, 2));
await writeFile(join(out, "tools-write.json"), JSON.stringify(write, null, 2));
await writeFile(
  join(out, "catalog-cost.json"),
  JSON.stringify(report, null, 2),
);
for (const condition of report.conditions)
  process.stdout.write(
    `${condition.condition.padEnd(20)} ${String(condition.tools.length).padStart(3)} tools ${String(condition.specBytes).padStart(7)} B ~${condition.estimatedTokens} tokens\n`,
  );
