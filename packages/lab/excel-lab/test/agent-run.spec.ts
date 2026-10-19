import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createExcelMcpServer, createWorkbookRoot } from "@sezzlee/excel-mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runTask,
  toolSpecsOf,
  type TrialEvent,
} from "../src/agent/agent-run.ts";
import {
  HostRequestError,
  type ChatRequest,
  type ChatResult,
  type HostIdentity,
  type ModelHost,
  type ThinkingPolicy,
  type ToolSpec,
} from "../src/agent/host.ts";
import {
  catalogFilesSchema,
  type Catalog,
  type Task,
} from "../src/agent/task.ts";

const task: Task = {
  id: "count-rows",
  level: "L1",
  knowledge: "K1",
  cases: ["Q2"],
  files: ["sample"],
  question: { tr: "Kaç satır var?", en: "How many rows are there?" },
  answer: { kind: "integer", value: 3 },
  plan: {
    steps: [
      { tool: "read_sheet", args: { filePath: "a.csv" }, role: "answer" },
    ],
    derive: { const: 3 },
  },
};

const catalog: Catalog = {
  files: catalogFilesSchema.parse({
    sample: {
      source: "test",
      file: "a.csv",
      sha256: "0".repeat(64),
      bytes: 8,
      license: "CC0-1.0",
      language: "en",
      as: "a.csv",
    },
  }),
  tasks: [task],
  uncovered: {},
};

type Step = (request: ChatRequest) => ChatResult;

class ScriptedHost implements ModelHost {
  readonly model = "scripted";
  readonly requests: ChatRequest[] = [];
  readonly #steps: Step[];

  constructor(steps: readonly Step[]) {
    this.#steps = [...steps];
  }

  async identity(): Promise<HostIdentity> {
    return {
      provider: "scripted",
      model: this.model,
      digest: null,
      version: null,
      details: null,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(request);
    const step = this.#steps.shift();
    if (step === undefined) throw new Error("the script has no more replies");
    return step(request);
  }

  async loadedWindow(): Promise<number | null> {
    return 8192;
  }
}

function reply(input: {
  readonly content?: string;
  readonly thinking?: string;
  readonly calls?: readonly (readonly [string, Record<string, unknown>])[];
}): Step {
  return () => ({
    kind: "reply",
    content: input.content ?? "",
    thinking: input.thinking ?? "",
    toolCalls: (input.calls ?? []).map(([name, args]) => ({
      function: { name, arguments: args },
    })),
    estimatedTokens: 100,
    usage: { input: 100, cachedInput: 0, output: 10 },
    ms: 1,
  });
}

function fail(failure: "retryable" | "context"): Step {
  return () => {
    throw new HostRequestError("host failed", failure);
  };
}

let directory: string;
let client: Client;
let close: () => Promise<void>;
let tools: readonly ToolSpec[];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-run-"));
  await writeFile(join(directory, "a.csv"), "n\n1\n2\n3\n");
  const server = createExcelMcpServer(await createWorkbookRoot(directory));
  client = new Client({ name: "agent-run-spec", version: "0.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(left), server.connect(right)]);
  tools = await toolSpecsOf(client);
  close = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(async () => {
  await close();
  await rm(directory, { recursive: true, force: true });
});

async function run(input: {
  readonly host: ScriptedHost;
  readonly callBudget?: number;
  readonly thinking?: ThinkingPolicy;
}) {
  const events: TrialEvent[] = [];
  const record = await runTask({
    task,
    key: { task: task.id, taskRevision: "r", language: "en", repetition: 0 },
    trialId: "t",
    manifestHash: "m",
    language: "en",
    catalog,
    host: input.host,
    client,
    tools,
    window: 8192,
    temperature: 0,
    thinking: input.thinking ?? "product",
    callBudget: input.callBudget ?? 15,
    timeoutMs: 10_000,
    retryDelayMs: 0,
    onEvent: async (event) => {
      events.push(event);
    },
  });
  return { record, events };
}

const read: readonly [string, Record<string, unknown>] = [
  "read_sheet",
  { filePath: "a.csv" },
];

describe("running one task against a model host", () => {
  it("stops a batch at the call budget and offers submit_answer alone for one last turn", async () => {
    const host = new ScriptedHost([
      reply({ calls: [read, read] }),
      reply({ calls: [["submit_answer", { value: 3 }]] }),
    ]);
    const { record } = await run({ host, callBudget: 1 });
    expect(record.calls).toBe(1);
    expect(record.budgetReached).toBe(true);
    expect(host.requests[1]?.tools.map((tool) => tool.function.name)).toEqual([
      "submit_answer",
    ]);
    expect(record.outcome).toBe("answered");
    expect(record.correct).toBe(true);
  });

  it("ends as callBudget when the last turn does not submit", async () => {
    const host = new ScriptedHost([
      reply({ calls: [read, read] }),
      reply({ calls: [read] }),
    ]);
    const { record } = await run({ host, callBudget: 1 });
    expect(record.outcome).toBe("callBudget");
    expect(host.requests).toHaveLength(2);
  });

  it("retries a failed request on its own and keeps the failure", async () => {
    const host = new ScriptedHost([
      fail("retryable"),
      reply({ calls: [["submit_answer", { value: 3 }]] }),
    ]);
    const { record, events } = await run({ host });
    expect(record.outcome).toBe("answered");
    expect(record.failedRequests).toBe(1);
    expect(events.map((event) => event.kind)).toEqual([
      "trialStarted",
      "requestFailed",
      "requestFinished",
      "submitted",
      "trialFinished",
    ]);
  });

  it("does not retry a request the host refused for its context window", async () => {
    const host = new ScriptedHost([fail("context")]);
    const { record } = await run({ host });
    expect(record.outcome).toBe("providerContextError");
    expect(host.requests).toHaveLength(1);
  });

  it("carries the model's thinking the way the product's provider does", async () => {
    const steps = [
      reply({
        content: "Reading.",
        thinking: "Count the rows.",
        calls: [read],
      }),
      reply({ calls: [["submit_answer", { value: 3 }]] }),
    ];
    const product = new ScriptedHost(steps);
    await run({ host: product, thinking: "product" });
    expect(product.requests[1]?.messages[2]).toEqual({
      role: "assistant",
      content: "Reading.\nCount the rows.",
      tool_calls: [
        { function: { name: "read_sheet", arguments: { filePath: "a.csv" } } },
      ],
    });
    const field = new ScriptedHost(steps);
    await run({ host: field, thinking: "field" });
    expect(field.requests[1]?.messages[2]).toMatchObject({
      content: "Reading.",
      thinking: "Count the rows.",
    });
  });
});
