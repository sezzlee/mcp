import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createOoxmlWriter } from "../src/index.js";
import { expectRefusal, TestError } from "./fixtures/harness.js";

const fail = (
  code: ConstructorParameters<typeof TestError>[0],
  message: string,
): Error => new TestError(code, message);

it("produces deterministic ZIP bytes readable by the independent platform inflater", () => {
  const writer = createOoxmlWriter({ fail });
  const parts = new Map([
    ["part.xml", Buffer.from("<root>known value</root>")],
  ]);
  const first = Buffer.from(writer.zip(parts, 10_000));
  expect(Buffer.from(writer.zip(parts, 10_000))).toEqual(first);
  expect(first.readUInt32LE(0)).toBe(0x04034b50);
  expect(first.readUInt16LE(8)).toBe(8);
  const start = 30 + first.readUInt16LE(26) + first.readUInt16LE(28);
  expect(
    inflateRawSync(
      first.subarray(start, start + first.readUInt32LE(18)),
    ).toString(),
  ).toBe("<root>known value</root>");
});

describe("archive production budgets", () => {
  it.each([
    { limits: { maxPartBytes: 2 }, maxBytes: 10_000, code: "part_too_large" },
    {
      limits: { maxDecodedPackageBytes: 2 },
      maxBytes: 10_000,
      code: "package_too_large",
    },
    {
      limits: { maxPartCount: 0 },
      maxBytes: 10_000,
      code: "package_too_large",
    },
    { limits: {}, maxBytes: 2, code: "package_too_large" },
    {
      limits: { ratioFloorBytes: 1, maxExpansionRatio: 1 },
      maxBytes: 10_000,
      code: "part_too_large",
    },
  ] as const)(
    "refuses $code with $limits and compressed limit $maxBytes",
    ({ limits, maxBytes, code }) => {
      const writer = createOoxmlWriter({ fail, limits });
      expectRefusal(
        () =>
          writer.zip(
            new Map([["a.xml", Buffer.from("x".repeat(1_000))]]),
            maxBytes,
          ),
        code,
      );
    },
  );

  it.each([
    "../secret.xml",
    "/absolute.xml",
    "bad\\name.xml",
    "tr-ş.xml",
    "directory/",
  ])("refuses unsafe part name %s", (name) => {
    expectRefusal(
      () =>
        createOoxmlWriter({ fail }).zip(
          new Map([[name, Buffer.from("value")]]),
          10_000,
        ),
      "malformed_part_name",
    );
  });
});
