import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createExcelMcpServer,
  createWorkbookOutput,
  createWorkbookRoot,
} from "@sezzlee/excel-mcp";

export interface ToolOutcome {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly body: unknown;
  readonly isError: boolean;
}

export interface Session {
  readonly directory: string;
  readonly client: Client;
  call(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ToolOutcome>;
  trace(event: unknown): Promise<void>;
}

/**
 * Opens one trial's workspace: an `out` directory and a fresh write-mode
 * server, so retained results, copy-refusal state and outputs never carry
 * over from another trial.
 * @param directory the trial's own empty directory
 */
export async function openSession(
  directory: string,
): Promise<Session & { close(): Promise<void> }> {
  await mkdir(join(directory, "out"), { recursive: true });
  const root = await createWorkbookRoot(directory);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({ name: "excel-lab", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(left), server.connect(right)]);
  const tracePath = join(directory, "trace.jsonl");
  const trace = (event: unknown): Promise<void> =>
    appendFile(tracePath, JSON.stringify(event) + "\n");
  return {
    directory,
    client,
    trace,
    async call(name, args) {
      const response = await client.callTool({ name, arguments: { ...args } });
      const text = response.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      const outcome = {
        name,
        args,
        text,
        body,
        isError: response.isError === true,
      };
      await trace({ tool: name, args, result: body, isError: outcome.isError });
      return outcome;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
