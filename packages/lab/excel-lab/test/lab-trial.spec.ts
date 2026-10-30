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
import { calcScenarios } from "../src/lab/suites/calc.ts";
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
  readonly #answer: (request: ChatRequest) => ChatResult;

  constructor(answer: (request: ChatRequest) => ChatResult) {
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

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.requests += 1;
    return this.#answer(request);
  }

  async loadedWindow() {
    return null;
  }
}

function claiming(
  id: string,
  verifiedOutput?: { filePath: string; versionId: string },
): LabScenario {
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
    async grade({ final, session }) {
      if (verifiedOutput !== undefined)
        await session.recordVerifiedOutput(verifiedOutput);
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
  expect(trial).toMatchObject({
    passed: false,
    termination: "output_limit",
    finalAnswer: "missing",
  });
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
  expect(trial.termination).toBe("malformed_tool_call");
  expect(trial.failure).toBe(
    "The model sent a malformed tool call: Ollama: error parsing tool call: raw='[1,]'",
  );
});

it("keeps the grader's verified artifact when the final answer hits the output limit", async () => {
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
  const output = {
    filePath: "out/verified.xlsx",
    versionId: "oracle-verified-version",
  };
  const trial = await claiming("test/verified-but-silent", output).run({
    mode: "model",
    language: "en",
    directory: await temporary(),
    fixtures: { corpus: undefined },
    host,
  });
  expect(trial).toMatchObject({
    passed: false,
    termination: "output_limit",
    artifact: { status: "passed", output },
    output,
    finalAnswer: "missing",
  });
});

it("verifies the real calculation file even when the model omits its final answer", async () => {
  let turn = 0;
  const host = new FixedHost((request) => {
    const brief = request.messages.find(
      (entry) => entry.role === "user",
    )?.content;
    const source =
      typeof brief === "string" ? brief.match(/\{[^}]+\}/)?.[0] : undefined;
    assert(source !== undefined, "The task must supply a source version.");
    return {
      kind: "reply",
      content: "",
      thinking: "",
      toolCalls:
        turn++ === 0
          ? [
              {
                function: {
                  name: "calculate_workbook",
                  arguments: { source: JSON.parse(source) },
                },
              },
            ]
          : [],
      estimatedTokens: 1,
      usage: null,
      timing: null,
      doneReason: "stop",
      ms: 0,
    };
  });
  const calculation = calcScenarios.find(
    (entry) => entry.id === "calc/calculate",
  );
  assert(calculation !== undefined);
  const trial = await calculation.run({
    mode: "model",
    language: "en",
    directory: await temporary(),
    fixtures: { corpus: undefined },
    host,
  });
  expect(trial).toMatchObject({
    passed: false,
    termination: "empty_reply",
    artifact: { status: "passed" },
    finalAnswer: "missing",
  });
});

it.each(["correct", "wrong", "tool"] as const)(
  "reserves finalization inside the original request budget and still grades a %s answer",
  async (answer) => {
    const host = new FixedHost((request) => {
      const calculation = request.messages.find(
        (entry) =>
          entry.role === "tool" && entry.tool_name === "calculate_workbook",
      );
      const filePath = calculation?.content.match(/"filePath":"([^"]+)"/)?.[1];
      const brief = request.messages.find(
        (entry) => entry.role === "user",
      )?.content;
      const source = brief?.match(/\{[^}]+\}/)?.[0];
      assert(source !== undefined);
      const finalizing = request.tools.length === 0;
      return {
        kind: "reply",
        content:
          finalizing && answer !== "tool"
            ? JSON.stringify({
                filePath,
                total: answer === "correct" ? 40 : 41,
              })
            : "",
        thinking: "",
        toolCalls:
          calculation === undefined
            ? [
                {
                  function: {
                    name: "calculate_workbook",
                    arguments: { source: JSON.parse(source) },
                  },
                },
              ]
            : !finalizing || answer === "tool"
              ? [
                  {
                    function: {
                      name: "read_sheet",
                      arguments: {
                        filePath,
                        sheetName: "Budget",
                        range: "C3",
                        headerRow: 0,
                      },
                    },
                  },
                ]
              : [],
        estimatedTokens: 1,
        usage: null,
        timing: null,
        doneReason: "stop",
        ms: 0,
      };
    });
    const calculation = calcScenarios.find(
      (entry) => entry.id === "calc/calculate",
    );
    assert(calculation !== undefined);
    const trial = await calculation.run({
      mode: "model",
      language: "en",
      directory: await temporary(),
      fixtures: { corpus: undefined },
      host,
      condition: { finalization: "reserve_last" },
    });
    expect(host.requests).toBe(calculation.policy.requests);
    expect(trial.calls.dispatched).toBe(calculation.policy.requests - 1);
    expect(trial.passed).toBe(answer === "correct");
    expect(trial.artifact?.status).toBe("passed");
    expect(trial.finalAnswer).toBe(
      answer === "tool"
        ? "missing"
        : answer === "correct"
          ? "passed"
          : "failed",
    );
    expect(trial.calls.refusedCatalog).toBe(answer === "tool" ? 1 : 0);
  },
);

it("uses a remaining request to finalize an empty reply after publication without accepting the silence", async () => {
  let turn = 0;
  const host = new FixedHost((request) => {
    const brief = request.messages.find(
      (entry) => entry.role === "user",
    )?.content;
    const source = brief?.match(/\{[^}]+\}/)?.[0];
    assert(source !== undefined);
    const calculation = request.messages.find(
      (entry) =>
        entry.role === "tool" && entry.tool_name === "calculate_workbook",
    );
    const filePath = calculation?.content.match(/"filePath":"([^"]+)"/)?.[1];
    const current = turn++;
    if (current === 2) expect(request.tools).toEqual([]);
    return {
      kind: "reply",
      content: current === 2 ? JSON.stringify({ filePath, total: 40 }) : "",
      thinking: "",
      toolCalls:
        current === 0
          ? [
              {
                function: {
                  name: "calculate_workbook",
                  arguments: { source: JSON.parse(source) },
                },
              },
            ]
          : [],
      estimatedTokens: 1,
      usage: null,
      timing: null,
      doneReason: "stop",
      ms: 0,
    };
  });
  const calculation = calcScenarios.find(
    (entry) => entry.id === "calc/calculate",
  );
  assert(calculation !== undefined);
  const trial = await calculation.run({
    mode: "model",
    language: "en",
    directory: await temporary(),
    fixtures: { corpus: undefined },
    host,
    condition: { finalization: "reserve_last" },
  });
  expect(host.requests).toBe(3);
  expect(trial).toMatchObject({
    passed: true,
    calls: { dispatched: 1 },
    artifact: { status: "passed" },
    finalAnswer: "passed",
  });
});

it("marks a published workbook as unverified when the host fails before grading", async () => {
  let turn = 0;
  const host = new FixedHost(() => {
    if (turn++ > 0) throw new HostRequestError("host disconnected", "fatal");
    return {
      kind: "reply",
      content: "",
      thinking: "",
      toolCalls: [
        {
          function: {
            name: "create_workbook",
            arguments: { sheets: [{ name: "S" }] },
          },
        },
      ],
      estimatedTokens: 1,
      usage: null,
      timing: null,
      doneReason: "stop",
      ms: 0,
    };
  });
  const directory = await temporary();
  const trial = await defineScenario<null, null>({
    id: "test/unverified-output",
    scriptedLanguages: ["en"],
    policy: { ...policy, catalog: ["create_workbook"] },
    setup: async () => null,
    brief: () => ({ system: "system", user: "user" }),
    start: () => null,
    observe() {},
    scripted: async () => "",
    grade: async () => ({}),
  }).run({
    mode: "model",
    language: "en",
    directory,
    fixtures: { corpus: undefined },
    host,
  });
  expect(await readdir(join(directory, "out"))).toHaveLength(1);
  expect(trial).toMatchObject({
    passed: false,
    termination: "host_failure",
    artifact: { status: "not_verified" },
    output: null,
  });
});

it("overrides only thinking history through an explicit condition", async () => {
  class ThinkingHost extends ScriptedHost {
    override async chat(request: ChatRequest): Promise<ChatResult> {
      const result = await super.chat(request);
      return result.kind === "reply"
        ? { ...result, thinking: "private reasoning" }
        : result;
    }
  }
  const host = new ThinkingHost([[offeredCall], []]);
  await scenario("test/history", async () => "").run({
    mode: "model",
    language: "en",
    directory: await temporary(),
    fixtures: { corpus: undefined },
    host,
    condition: { thinking: "field" },
  });
  const assistant = host.requests[1]?.messages.find(
    (message) => message.role === "assistant",
  );
  expect(assistant).toMatchObject({
    content: "",
    thinking: "private reasoning",
  });
  expect(host.requests[0]?.numPredict).toBeNull();
  expect(host.requests[0]?.window).toBe(8192);
});
