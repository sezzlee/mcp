import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  budgetNotice,
  HostRequestError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ModelHost,
  type ToolCall,
} from "../src/agent/host.ts";
import { runLab } from "../src/lab/runner.ts";
import {
  defineScenario,
  notOffered,
  type LabScenario,
  type ModelPolicy,
} from "../src/lab/trial.ts";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lab-trial-"));
  directories.push(directory);
  return directory;
}

class ScriptedHost implements ModelHost {
  readonly model = "stub";
  readonly endpoint = "stub://host";
  readonly requests: ChatRequest[] = [];
  readonly #replies: ToolCall[][];

  constructor(replies: ToolCall[][]) {
    this.#replies = replies;
  }

  async identity() {
    return {
      provider: "stub",
      model: this.model,
      digest: null,
      version: null,
      details: null,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(request);
    const toolCalls = this.#replies.shift() ?? [];
    return {
      kind: "reply",
      content: toolCalls.length === 0 ? "done" : "",
      thinking: "",
      toolCalls,
      estimatedTokens: 1,
      usage: null,
      timing: null,
      doneReason: "stop",
      ms: 0,
    };
  }

  async loadedWindow() {
    return null;
  }
}

const policy: ModelPolicy = {
  catalog: ["describe_workbook"],
  requests: 4,
  calls: 2,
  window: 8192,
  numPredict: null,
  timeoutMs: 1000,
  thinking: "drop",
};

function scenario(
  id: string,
  scripted: (
    call: Parameters<
      Parameters<typeof defineScenario<null, null>>[0]["scripted"]
    >[0],
  ) => Promise<string>,
): LabScenario {
  return defineScenario<null, null>({
    id,
    scriptedLanguages: ["en"],
    policy,
    async setup(session) {
      await writeFile(
        join(session.directory, "data.csv"),
        "Region,Amount\nNorth,10\nSouth,12\nNorth,5\n",
      );
      return null;
    },
    brief: () => ({ system: "system", user: "user" }),
    start: () => null,
    observe() {},
    scripted: (call) => scripted(call),
    async grade() {
      return {};
    },
  });
}

const offeredCall: ToolCall = {
  function: { name: "describe_workbook", arguments: { filePath: "data.csv" } },
};

it("refuses a tool outside the offered catalog and calls past the budget without reaching the server", async () => {
  const directory = await temporary();
  const host = new ScriptedHost([
    [
      {
        function: {
          name: "create_workbook",
          arguments: {
            sheets: [
              {
                name: "S",
                blocks: [
                  { startCell: "A1", values: [[{ kind: "number", value: 1 }]] },
                ],
              },
            ],
          },
        },
      },
      offeredCall,
      offeredCall,
      offeredCall,
    ],
    [],
  ]);
  const trial = await scenario("test/limits", async () => "").run({
    mode: "model",
    language: "en",
    directory,
    fixtures: { corpus: undefined },
    host,
  });
  expect(trial).toMatchObject({
    passed: true,
    turns: 2,
    final: "done",
    calls: { requested: 4, dispatched: 2, refusedCatalog: 1, refusedBudget: 1 },
  });
  expect(await readdir(join(directory, "out"))).toEqual([]);
  const replies = (host.requests[1]?.messages ?? []).filter(
    (message): message is Extract<ChatMessage, { role: "tool" }> =>
      message.role === "tool",
  );
  expect(replies.map((message) => message.content)).toEqual([
    notOffered,
    expect.stringContaining('"sheets"'),
    expect.stringContaining('"sheets"'),
    budgetNotice,
  ]);
  expect(host.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
    "describe_workbook",
  ]);
});

it("sends a model host no request while a scripted baseline fails", async () => {
  let built = 0;
  const run = await runLab({
    out: await temporary(),
    scenarios: [
      scenario("test/broken", async () => {
        throw new Error("fixture broken");
      }),
    ],
    languages: ["en"],
    fixtures: { corpus: undefined },
    model: true,
    hostOf() {
      built += 1;
      return new ScriptedHost([]);
    },
    async onRecord() {},
  });
  expect(built).toBe(0);
  expect(run).toMatchObject({ gate: "failed", modelTrials: false });
  expect(run.records.map((trial) => [trial.mode, trial.failure])).toEqual([
    ["scripted", "fixture broken"],
  ]);
});

it("gives every trial its own server, so a retained result does not leak into the next", async () => {
  let retained = "";
  const run = await runLab({
    out: await temporary(),
    scenarios: [
      scenario("test/retain", async (call) => {
        const result = await call("aggregate_sheet", {
          filePath: "data.csv",
          groupBy: ["Region"],
          metrics: [{ fn: "sum", column: "Amount" }],
          resultMode: "retained",
        });
        assert(!result.isError, result.text);
        const body = result.body as { resultId?: unknown };
        assert(typeof body.resultId === "string");
        retained = body.resultId;
        assert(!(await call("query_result", { resultId: retained })).isError);
        return "";
      }),
      scenario("test/later", async (call) => {
        const result = await call("query_result", { resultId: retained });
        assert(result.isError);
        assert.equal(
          (result.body as { error?: unknown }).error,
          "result_unavailable",
        );
        return "";
      }),
    ],
    languages: ["en"],
    fixtures: { corpus: undefined },
    model: false,
    hostOf: () => new ScriptedHost([]),
    async onRecord() {},
  });
  expect(run.records.map((trial) => [trial.id, trial.failure])).toEqual([
    ["test/retain", null],
    ["test/later", null],
  ]);
});

class FixedHost implements ModelHost {
  readonly model = "stub";
  readonly endpoint = "stub://host";
  requests = 0;
  readonly #answer: () => ChatResult;

  constructor(answer: () => ChatResult) {
    this.#answer = answer;
  }

  async identity() {
    return {
      provider: "stub",
      model: this.model,
      digest: null,
      version: null,
      details: null,
    };
  }

  async chat(): Promise<ChatResult> {
    this.requests += 1;
    return this.#answer();
  }

  async loadedWindow() {
    return null;
  }
}

function claiming(id: string): LabScenario {
  return defineScenario<null, null>({
    id,
    scriptedLanguages: ["en"],
    policy,
    async setup() {
      return null;
    },
    brief: () => ({ system: "system", user: "user" }),
    start: () => null,
    observe() {},
    scripted: async () => "",
    async grade({ final }) {
      assert.match(
        final,
        /calculat/,
        "Final answer must disclose calculation.",
      );
      return {};
    },
  });
}

it("names an empty final answer instead of the claim it lacks", async () => {
  const host = new FixedHost(() => ({
    kind: "reply",
    content: "",
    thinking: "long",
    toolCalls: [],
    estimatedTokens: 1,
    usage: null,
    timing: null,
    doneReason: "length",
    ms: 0,
  }));
  const trial = await claiming("test/silent").run({
    mode: "model",
    language: "en",
    directory: await temporary(),
    fixtures: { corpus: undefined },
    host,
  });
  expect(trial.failure).toBe(
    "No final answer: the output limit ended the reply. Final answer must disclose calculation.",
  );
});

it("fails a malformed tool call once as the model's, not the host's", async () => {
  const host = new FixedHost(() => {
    throw new HostRequestError(
      "Ollama: error parsing tool call: raw='[1,]'",
      "malformed",
    );
  });
  const trial = await claiming("test/malformed").run({
    mode: "model",
    language: "en",
    directory: await temporary(),
    fixtures: { corpus: undefined },
    host,
    retryDelayMs: 0,
  });
  expect(host.requests).toBe(1);
  expect(trial.failure).toBe(
    "The model sent a malformed tool call: Ollama: error parsing tool call: raw='[1,]'",
  );
});
