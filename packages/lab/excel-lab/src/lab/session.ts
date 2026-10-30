import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import type { repeatedErrorSchema } from "./diagnostics.ts";
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
  readonly preparedEdit?: {
    readonly source: { readonly filePath: string; readonly versionId: string };
    readonly changes: readonly unknown[];
  };
}

export interface Session {
  readonly directory: string;
  readonly client: Client;
  call(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ToolOutcome>;
  trace(event: unknown): Promise<void>;
  readonly verifiedOutput:
    { readonly filePath: string; readonly versionId: string } | undefined;
  recordVerifiedOutput(output: {
    readonly filePath: string;
    readonly versionId: string;
  }): Promise<void>;
  readonly repeatedErrors: readonly z.infer<typeof repeatedErrorSchema>[];
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
  let verifiedOutput: Session["verifiedOutput"];
  const errors = new Map<string, z.infer<typeof repeatedErrorSchema>>();
  const observedStates = new Set<string>();
  let sourceEpoch = 0;
  const stateSchema = z.object({
    version: z
      .object({ filePath: z.string(), versionId: z.string() })
      .optional(),
    resultId: z.string().optional(),
  });
  function normalized(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalized);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalized(item)]),
    );
  }
  const preparations = new Map<
    string,
    NonNullable<ToolOutcome["preparedEdit"]>
  >();
  const readySchema = z.object({
    kind: z.literal("ready"),
    preparationId: z.string(),
    source: z.object({ filePath: z.string(), versionId: z.string() }),
  });
  const trace = (event: unknown): Promise<void> =>
    appendFile(tracePath, JSON.stringify(event) + "\n");
  return {
    directory,
    client,
    trace,
    get verifiedOutput() {
      return verifiedOutput;
    },
    async recordVerifiedOutput(output) {
      verifiedOutput = output;
      await trace({ artifact: { status: "passed", output } });
    },
    get repeatedErrors() {
      return [...errors.values()].filter((entry) => entry.count > 1);
    },
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
      if (name === "prepare_edit" && response.isError !== true) {
        const ready = readySchema.safeParse(body);
        const changes = z.array(z.unknown()).safeParse(args["changes"]);
        if (ready.success && changes.success) {
          if (preparations.size >= 8) {
            const oldest = preparations.keys().next().value;
            if (oldest !== undefined) preparations.delete(oldest);
          }
          preparations.set(ready.data.preparationId, {
            source: ready.data.source,
            changes: changes.data,
          });
        }
      }
      const preparedEdit =
        name === "edit_workbook" && typeof args["preparationId"] === "string"
          ? preparations.get(args["preparationId"])
          : undefined;
      let errorRepetition: number | undefined;
      if (response.isError === true) {
        const failure = z
          .object({ error: z.string(), message: z.string() })
          .safeParse(body);
        const detail = failure.success ? failure.data.message : text;
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([name, normalized(args), sourceEpoch, detail]))
          .digest("hex");
        const previous = errors.get(fingerprint);
        errorRepetition = (previous?.count ?? 0) + 1;
        errors.set(fingerprint, {
          tool: name,
          fingerprint,
          error: detail,
          count: errorRepetition,
        });
      } else {
        const state = stateSchema.safeParse(body);
        if (
          state.success &&
          (state.data.version !== undefined ||
            state.data.resultId !== undefined)
        ) {
          const identity = JSON.stringify(state.data);
          if (!observedStates.has(identity)) {
            observedStates.add(identity);
            sourceEpoch += 1;
          }
        }
      }
      const outcome = {
        name,
        args,
        text,
        body,
        isError: response.isError === true,
        ...(preparedEdit === undefined ? {} : { preparedEdit }),
      };
      await trace({
        tool: name,
        args,
        result: body,
        isError: outcome.isError,
        ...(errorRepetition === undefined ? {} : { errorRepetition }),
      });
      return outcome;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
