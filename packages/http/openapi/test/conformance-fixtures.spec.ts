import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "@sezzlee/core";
import { describe, expect, it } from "vitest";
import { ingest, ingestionSeverities } from "../src/index.js";

type IngestionFixture = Extract<Fixture, { kind: "openapi-ingestion" }>;

const dir = fileURLToPath(
  new URL("../../conformance/openapi-ingestion/", import.meta.url),
);

describe("conformance: openapi-ingestion", () => {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  it("has fixtures", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    it(file, async () => {
      const fixture = JSON.parse(
        readFileSync(join(dir, file), "utf8"),
      ) as IngestionFixture;
      expect(fixture.kind).toBe("openapi-ingestion");
      for (const diagnostic of fixture.expected.diagnostics) {
        expect(Object.keys(ingestionSeverities)).toContain(diagnostic.code);
      }
      const result = await ingest(
        fixture.input.document as Parameters<typeof ingest>[0],
        fixture.input.options ?? {},
      );
      expect(result.diagnostics.map(({ code, at }) => ({ code, at }))).toEqual(
        fixture.expected.diagnostics,
      );
      expect(
        result.endpoints.map((endpoint) => ({
          key: endpoint.key,
          ...(endpoint.baseUrl === undefined
            ? {}
            : { baseUrl: endpoint.baseUrl }),
          ...(endpoint.selection === undefined
            ? {}
            : { selection: endpoint.selection }),
          descriptor: endpoint.descriptor,
        })),
      ).toEqual(fixture.expected.endpoints);
    });
  }
});
