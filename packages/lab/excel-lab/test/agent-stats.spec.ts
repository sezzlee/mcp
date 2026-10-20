import { describe, expect, it } from "vitest";
import { pairRuns, type Run } from "../src/agent/runs.ts";
import { clusterBootstrap, mcnemarExact } from "../src/agent/stats.ts";

describe("paired statistics", () => {
  it("gives the exact two-sided McNemar p-value", () => {
    expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 10);
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(10, 10)).toBe(1);
  });

  it("resamples whole clusters reproducibly and refuses a single cluster", () => {
    const clusters = [[1, 1], [0], [1, 0, 1], [0, 0]];
    const once = clusterBootstrap({
      clusters,
      resamples: 500,
      seed: 7,
      level: 0.9,
    });
    expect(once).toEqual(
      clusterBootstrap({ clusters, resamples: 500, seed: 7, level: 0.9 }),
    );
    expect(
      clusterBootstrap({
        clusters: [[1, 0]],
        resamples: 500,
        seed: 7,
        level: 0.9,
      }),
    ).toBeNull();
  });
});

function runOf(input: {
  readonly task: string;
  readonly repetition?: number;
  readonly taskRevision?: string | null;
  readonly outcome?: string;
}): Run {
  return {
    trialId: null,
    taskRevision: input.taskRevision ?? "r1",
    repetition: input.repetition ?? 0,
    task: input.task,
    language: "tr",
    outcome: input.outcome ?? "answered",
    window: 65536,
    loadedWindow: 65536,
    submission: null,
    budgetReached: false,
    calls: 1,
    idealCalls: 1,
    excessCalls: 0,
    responseBytes: 0,
    inputTokens: null,
    peakInputTokens: null,
    failedRequests: 0,
    ms: 0,
    trace: [],
    callLog: [],
    correct: true,
    grade: null,
    eligibility:
      input.outcome === "hostError"
        ? { eligible: false, reason: "hostError" }
        : { eligible: true },
    family: input.task,
    sameQuestion: true,
    definition: undefined,
  };
}

describe("pairing two run sets", () => {
  it("pairs by task, language and repetition and lists what it leaves out", () => {
    const pairing = pairRuns(
      [
        runOf({ task: "a" }),
        runOf({ task: "b" }),
        runOf({ task: "c" }),
        runOf({ task: "d" }),
      ],
      [
        runOf({ task: "a" }),
        runOf({ task: "b", taskRevision: "r2" }),
        runOf({ task: "c", outcome: "hostError" }),
        runOf({ task: "e" }),
      ],
    );
    expect(pairing.pairs.map(([left]) => left.task)).toEqual(["a"]);
    expect(pairing.excluded).toEqual([
      { key: "b tr r0", reason: "task changed" },
      { key: "c tr r0", reason: "after hostError" },
      { key: "d tr r0", reason: "only before" },
      { key: "e tr r0", reason: "only after" },
    ]);
  });

  it("refuses a run set that holds the same trial twice", () => {
    expect(() =>
      pairRuns([runOf({ task: "a" }), runOf({ task: "a" })], []),
    ).toThrow("before holds a tr r0 twice");
  });
});
