import { describe, expect, it } from "vitest";
import { outlineJsonValue, readJsonValue } from "@sezzlee/compute-core";

describe("RFC 6901 exact JSON windows", () => {
  const json =
    '{"a/b":{"~key":[{"id":1,"note":"one"},{"id":2,"note":"two"},{"id":3,"note":"three"}]},"":"empty member","text":"A😀B"}';
  it("decodes escaped member names and projects a stable array window", () => {
    expect(
      readJsonValue(json, {
        path: "/a~1b/~0key",
        select: ["id"],
        offset: 1,
        limit: 1,
      }),
    ).toEqual({
      kind: "array",
      path: "/a~1b/~0key",
      total: 3,
      offset: 1,
      nextOffset: 2,
      value: [{ id: 2 }],
    });
    expect(readJsonValue(json, { path: "/", limit: 5 })).toMatchObject({
      value: "empty",
      total: 12,
      nextOffset: 5,
    });
  });
  it.each(["a/b", "/a~2b", "/a~1b/~0key/01", "/a~1b/~0key/-", "/toString"])(
    "refuses invalid or nonexistent pointer %s",
    (path) => {
      expect(readJsonValue(json, { path })).toMatchObject({ kind: "invalid" });
    },
  );
  it("refuses projection mistakes and pages strings in UTF-16 code units", () => {
    expect(
      readJsonValue(json, { path: "/text", select: ["id"] }),
    ).toMatchObject({ kind: "invalid" });
    expect(
      readJsonValue(json, { path: "/a~1b/~0key", select: ["missing"] }),
    ).toMatchObject({ kind: "invalid" });
    expect(
      readJsonValue(json, { path: "/text", offset: 1, limit: 2 }),
    ).toMatchObject({ value: "😀", total: 4, nextOffset: 3 });
  });
  it("outlines containers without returning their contents", () => {
    expect(outlineJsonValue('{"rows":[{"secret":"not-a-shape"}]}')).toEqual([
      { path: "", kind: "object", count: 1, fields: ["rows"] },
      { path: "/rows", kind: "array", count: 1 },
    ]);
  });
});
