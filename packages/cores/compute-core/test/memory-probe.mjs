import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { log } from "node:console";
import { clearInterval, setImmediate, setInterval } from "node:timers";
import { QuickJsExecutor } from "@sezzlee/compute-core";

const require = createRequire(import.meta.url);
const { AbortController } = globalThis;
const variant = JSON.parse(
  readFileSync(
    require.resolve("@jitl/quickjs-wasmfile-release-sync/package.json"),
    "utf8",
  ),
);
assert.equal(variant.version, "0.32.0");

const executor = new QuickJsExecutor({ maxConcurrent: 1 });
const healthy = async () =>
  assert.deepEqual(
    await executor.execute({ json: "null", code: "return 42;" }),
    { kind: "success", json: "42" },
  );
await healthy();
globalThis.gc?.();
await new Promise((resolve) => setImmediate(resolve));
const baselineRssBytes = process.memoryUsage().rss;
let peakRssBytes = baselineRssBytes;
let active;
const maxPeakGrowthBytes = 128 * 1024 * 1024;
const maxRetainedGrowthBytes = 64 * 1024 * 1024;
const sample = () => {
  const rss = process.memoryUsage().rss;
  peakRssBytes = Math.max(peakRssBytes, rss);
  if (rss - baselineRssBytes > maxPeakGrowthBytes) active?.abort();
};
const sampler = setInterval(sample, 10);
const workloads = [
  {
    kind: "strings",
    code: "const chunks = []; for (let i = 0; i < 48; i++) chunks.push(String(i) + 'x'.repeat(1024 * 1024)); return chunks.length;",
  },
  {
    kind: "array_buffers",
    code: "const chunks = []; for (let i = 0; i < 48; i++) { const chunk = new ArrayBuffer(1024 * 1024); new Uint8Array(chunk).fill(97); chunks.push(chunk); } return chunks.length;",
  },
];
const results = [];
try {
  for (let round = 1; round <= 2; round++)
    for (const workload of workloads) {
      active = new AbortController();
      const result = await executor.execute({
        json: "null",
        code: workload.code,
        signal: active.signal,
      });
      active = undefined;
      sample();
      const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      results.push({ round, kind: workload.kind, result, resultBytes });
      assert.deepEqual(result, { kind: "failure", reason: "program_failed" });
      assert.ok(
        resultBytes <= 128,
        "Allocation failures must have a bounded error result",
      );
      await healthy();
      globalThis.gc?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
} finally {
  clearInterval(sampler);
}
globalThis.gc?.();
await new Promise((resolve) => setImmediate(resolve));
const afterRssBytes = process.memoryUsage().rss;
log(
  JSON.stringify({
    variant: variant.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    guestMemoryBytes: executor.limits.maxMemoryBytes,
    perProgramAllocationCeilingBytes: 48 * 1024 * 1024 + 96,
    maxPeakGrowthBytes,
    maxRetainedGrowthBytes,
    baselineRssBytes,
    peakRssBytes,
    afterRssBytes,
    results,
  }),
);
assert.ok(
  peakRssBytes - baselineRssBytes <= maxPeakGrowthBytes,
  "The bounded probe exceeded its peak RSS growth envelope",
);
assert.ok(
  afterRssBytes - baselineRssBytes <= maxRetainedGrowthBytes,
  "Memory remained outside the probe envelope after worker termination",
);
