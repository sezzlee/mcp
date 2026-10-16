import { performance } from "node:perf_hooks";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createExcelMcpServer, createWorkbookRoot } from "@sezzlee/excel-mcp";
import { z } from "zod";
import {
  probeArgvSchema,
  sha256Of,
  type CallOutcome,
  type CallRecord,
  type ProbeFormat,
  type ProbeReport,
  type ToolArgs,
} from "./record.ts";

const maxSheets = 25;

const errorEnvelope = z.object({ error: z.string() });
const description = z.object({
  sheets: z.array(z.object({ name: z.string() })),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function outcomeOf(isError: boolean, text: string): CallOutcome {
  if (!isError) return { kind: "ok" };
  const envelope = errorEnvelope.safeParse(parseJson(text));
  return {
    kind: "error",
    code: envelope.success ? envelope.data.error : "unparsable_error",
  };
}

async function probe({
  root,
  filePath,
  format,
}: {
  readonly root: string;
  readonly filePath: string;
  readonly format: ProbeFormat;
}): Promise<ProbeReport> {
  const started = performance.now();
  const server = createExcelMcpServer(await createWorkbookRoot(root));
  const client = new Client({ name: "excel-lab", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const calls: CallRecord[] = [];
  const call = async (tool: string, args: ToolArgs): Promise<CallRecord> => {
    const before = performance.now();
    const result = await client.callTool({ name: tool, arguments: args });
    const ms = performance.now() - before;
    const text = result.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    const record: CallRecord = {
      tool,
      args,
      ms,
      bytes: Buffer.byteLength(text, "utf8"),
      digest: sha256Of(text),
      outcome: outcomeOf(result.isError === true, text),
      text,
    };
    calls.push(record);
    return record;
  };

  const described = await call("describe_workbook", { filePath });
  const sheets = description.safeParse(parseJson(described.text));
  const names = sheets.success
    ? sheets.data.sheets.map((sheet) => sheet.name)
    : [];
  const probed = names.slice(0, maxSheets);
  for (const sheetName of probed) {
    if (format === "csv") {
      await call("read_sheet", { filePath, sheetName });
      continue;
    }
    await call("read_sheet", { filePath, sheetName, valueMode: "both" });
    await call("get_merged_ranges", { filePath, sheetName });
  }

  await client.close();
  await server.close();
  return {
    calls,
    sheetsTotal: names.length,
    sheetsProbed: probed.length,
    ms: performance.now() - started,
    maxRssKiB: process.resourceUsage().maxRSS,
  };
}

const [root, filePath, format] = probeArgvSchema.parse(process.argv.slice(2));
const report = await probe({ root, filePath, format });
process.stdout.write(`${JSON.stringify(report)}\n`);
