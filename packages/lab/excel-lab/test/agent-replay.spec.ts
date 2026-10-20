import { describe, expect, it } from "vitest";
import { replayTrial } from "../src/agent/replay.ts";

describe("replaying recorded calls against a server", () => {
  it("finds a seeded change at its place and ignores the volatile fields", async () => {
    const calls = [
      {
        tool: "aggregate_sheet",
        args: { filePath: "a.csv" },
        text: JSON.stringify({
          rows: [[12816]],
          modifiedAt: "2026-10-19T10:00:00Z",
        }),
      },
      {
        tool: "read_sheet",
        args: { filePath: "a.csv" },
        text: JSON.stringify({ values: [["TOPLAM", 13786]] }),
      },
    ];
    const replayed = await replayTrial({
      calls,
      call: async (tool) => ({
        text:
          tool === "aggregate_sheet"
            ? JSON.stringify({
                rows: [[12816]],
                modifiedAt: "2026-10-20T08:00:00Z",
              })
            : JSON.stringify({ values: [["TOPLAM", 13787]] }),
      }),
    });
    expect(replayed).toEqual([
      { status: "same", tool: "aggregate_sheet" },
      {
        status: "changed",
        tool: "read_sheet",
        path: "/values/0/1",
        before: 13786,
        after: 13787,
      },
    ]);
  });

  it("follows the replayed server's cursor and blocks a continuation that lost its source", async () => {
    const sent: unknown[] = [];
    const calls = [
      {
        tool: "read_sheet",
        args: { filePath: "a.csv" },
        text: JSON.stringify({ truncated: true, nextCursor: "old" }),
      },
      {
        tool: "read_sheet",
        args: { cursor: "old" },
        text: JSON.stringify({ truncated: false }),
      },
    ];
    const followed = await replayTrial({
      calls,
      call: async (_tool, args) => {
        sent.push(args);
        return {
          text: JSON.stringify(
            "cursor" in args
              ? { truncated: false }
              : { truncated: true, nextCursor: "new" },
          ),
        };
      },
    });
    expect(sent).toEqual([{ filePath: "a.csv" }, { cursor: "new" }]);
    expect(followed.map((call) => call.status)).toEqual(["same", "same"]);
    const lost = await replayTrial({
      calls,
      call: async () => ({ text: JSON.stringify({ truncated: false }) }),
    });
    expect(lost.map((call) => call.status)).toEqual(["changed", "blocked"]);
  });
});
