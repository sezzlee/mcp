import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/manifest.ts";

const sourceDir = join("/corpus", "demo");
const digest = "a".repeat(64);

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({
    sha256: digest,
    bytes: 10,
    license: "CC0-1.0",
    ...fields,
  });
}

describe("parseManifest", () => {
  it("keeps supported formats and resolves them inside the source", () => {
    const scan = parseManifest({
      source: "demo",
      sourceDir,
      text: [
        line({ file: "files/a.xlsx", format: "xlsx" }),
        line({ file: "files/b.csv", format: "csv" }),
        line({ file: "files/c.xls", format: "xls" }),
        line({ file: "files/d.ods", format: "ods" }),
        "",
      ].join("\n"),
    });

    expect(scan.entries.map((entry) => [entry.file, entry.path])).toEqual([
      ["files/a.xlsx", join("/corpus", "demo", "files", "a.xlsx")],
      ["files/b.csv", join("/corpus", "demo", "files", "b.csv")],
    ]);
    expect(scan.unsupported).toBe(2);
    expect(scan.rejected).toEqual([]);
  });

  it.each([
    [
      "a parent escape",
      line({ file: "../other/x.xlsx", format: "xlsx" }),
      "outside_source",
    ],
    [
      "a nested escape",
      line({ file: "files/../../x.xlsx", format: "xlsx" }),
      "outside_source",
    ],
    [
      "an absolute path",
      line({ file: "/etc/x.xlsx", format: "xlsx" }),
      "outside_source",
    ],
    [
      "the source folder itself",
      line({ file: ".", format: "xlsx" }),
      "outside_source",
    ],
    ["broken JSON", '{"file":', "malformed"],
    [
      "a short digest",
      line({ file: "files/a.xlsx", format: "xlsx", sha256: "abc" }),
      "malformed",
    ],
    ["a missing file field", line({ format: "xlsx" }), "malformed"],
  ])("rejects %s", (_name, text, reason) => {
    const scan = parseManifest({ source: "demo", sourceDir, text });

    expect(scan.entries).toEqual([]);
    expect(scan.rejected).toEqual([{ source: "demo", line: 1, reason }]);
  });
});
