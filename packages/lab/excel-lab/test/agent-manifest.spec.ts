import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  identityOf,
  manifestDifferences,
  type Manifest,
} from "../src/agent/manifest.ts";

const manifest: Manifest = {
  schemaVersion: 2,
  catalog: "a".repeat(64),
  oracle: "b".repeat(64),
  graderVersion: "v2",
  lab: { sources: "c".repeat(64) },
  server: { version: "0.9.1", dist: "d".repeat(64) },
  tools: "e".repeat(64),
  systemPrompt: "f".repeat(64),
  host: {
    provider: "ollama",
    model: "qwen3.8:latest",
    digest: "1".repeat(64),
    version: "0.35.0",
    details: null,
  },
  generation: {
    window: 65536,
    temperature: 0,
    thinking: "product",
    keepAlive: "10m",
    callBudget: 15,
    timeoutMs: 600000,
  },
  node: "v24.12.0",
  provenance: { labCommit: "abc" },
};

describe("a run condition's identity", () => {
  it("names the nested fields two conditions differ in and ignores where the lab was committed", () => {
    const other: Manifest = {
      ...manifest,
      generation: { ...manifest.generation, thinking: "field" },
      server: { ...manifest.server, dist: "9".repeat(64) },
      provenance: { labCommit: "def" },
    };
    expect(manifestDifferences(manifest, other)).toEqual([
      "generation.thinking",
      "server.dist",
    ]);
    expect(
      canonicalHash(
        identityOf({ ...manifest, provenance: { labCommit: "def" } }),
      ),
    ).toBe(canonicalHash(identityOf(manifest)));
  });
});
