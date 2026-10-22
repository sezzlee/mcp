import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoot } from "../index.js";

test(
  "special files and filesystem races are bounded by an external watchdog",
  { timeout: 35000 },
  () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./watchdog.mjs", import.meta.url))],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.secretReads, 0);
    console.log(JSON.stringify(report));
  },
);

test("traversal budgets count unsupported entries and bound depth/time", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "native-scan-")));
  try {
    for (let i = 0; i < 12; i += 1)
      await writeFile(join(path, `${i}.unsupported`), "x");
    const root = openRoot(path);
    const limited = await root.scan("", 10, 64, 1000);
    assert.equal(limited.visited, 10);
    assert.equal(limited.reason, "entries");
    assert.equal((await root.scan("", 20, 64, 1000)).visited, 12);
    assert.equal((await root.scan("", 20, 64, 1000)).reason, null);
    const parallel = await Promise.all(
      Array.from({ length: 8 }, () => root.scan("", 20, 64, 1000)),
    );
    const expected = Array.from(
      { length: 12 },
      (_, i) => `${i}.unsupported`,
    ).sort();
    for (const scan of parallel) {
      assert.equal(scan.reason, null);
      assert.deepEqual(
        scan.entries.map((entry) => entry.path).sort(),
        expected,
      );
    }
    assert.equal((await root.scan("", 20, 64, 0)).reason, "time");
    await mkdir(join(path, "a"));
    await mkdir(join(path, "a", "b"));
    assert.equal((await root.scan("", 20, 0, 1000)).reason, "depth");
    for (let start = 12; start < 5001; start += 128) {
      await Promise.all(
        Array.from({ length: Math.min(128, 5001 - start) }, (_, offset) =>
          writeFile(join(path, `${start + offset}.unsupported`), "x"),
        ),
      );
    }
    const large = await root.scan("", 5000, 64, 1000);
    assert.ok(large.visited <= 5000);
    assert.ok(["entries", "time"].includes(large.reason));
    assert.ok(process.resourceUsage().maxRSS < 256 * 1024);
    console.log(
      JSON.stringify({
        scanVisited: large.visited,
        scanReason: large.reason,
        peakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("a whole read peaks at one file-sized buffer, not two", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "native-peak-")));
  try {
    const size = 40 * 1024 * 1024;
    await writeFile(join(path, "warm"), "x");
    await writeFile(join(path, "large"), randomBytes(size));
    const probe = `
      const { openRoot } = await import(${JSON.stringify(new URL("../index.js", import.meta.url).href)});
      const root = openRoot(${JSON.stringify(path)});
      await root.read("warm", 1);
      const before = process.resourceUsage().maxRSS;
      const snapshot = await root.read("large", ${size});
      const after = process.resourceUsage().maxRSS;
      console.log(JSON.stringify({ grownKiB: after - before, length: snapshot.bytes.length }));
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", probe],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.length, size);
    /**
     * A copy into a fresh JS Buffer while the native vector is still alive
     * peaks at twice the file (measured 96 MiB for a 48 MiB read on darwin-arm64);
     * 1.5x separates one buffer from two with room for allocator slack.
     */
    assert.ok(
      report.grownKiB < (1.5 * size) / 1024,
      `peak grew ${report.grownKiB} KiB for a ${size / 1024} KiB file`,
    );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("a digest keeps pace with a whole read hashed by createHash", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "native-pace-")));
  try {
    const size = 16 * 1024 * 1024;
    await writeFile(join(path, "large"), randomBytes(size));
    const root = openRoot(path);
    const elapsed = async (operation) => {
      const start = process.hrtime.bigint();
      await operation();
      return Number(process.hrtime.bigint() - start);
    };
    const digests = [];
    const reads = [];
    for (let round = 0; round < 9; round += 1) {
      digests.push(await elapsed(() => root.digest("large", size)));
      reads.push(
        await elapsed(async () =>
          createHash("sha256")
            .update((await root.read("large", size)).bytes)
            .digest(),
        ),
      );
    }
    const median = (samples) => samples.sort((a, b) => a - b)[4];
    /**
     * A digest-checked cache hit replaces a whole read plus createHash, so it
     * must not be slower than that. The portable fallback measured 4-5x the
     * reference on darwin-arm64 and the host's OpenSSL about 1x; 2.5x fails
     * the first with room for scheduler noise.
     */
    assert.ok(
      median(digests) < 2.5 * median(reads),
      `digest ${median(digests)} ns, read and hash ${median(reads)} ns`,
    );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("ranged reads and digests agree with the whole-file reference", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "native-range-")));
  try {
    const root = openRoot(path);
    const budget = 1024 * 1024;
    /**
     * The sizes straddle the SHA-256 padding edges (55/56/63/64) and the
     * 64 KiB read window: a hand-written hash or a short pread passes every
     * other size and fails only here.
     */
    for (const size of [
      0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65535, 65536,
      65537, 131072, 200000,
    ]) {
      const bytes = randomBytes(size);
      const name = `f${size}`;
      await writeFile(join(path, name), bytes);
      const whole = await root.read(name, budget);
      assert.deepEqual(whole.bytes, bytes);
      const hashed = await root.digest(name, budget);
      assert.deepEqual(
        hashed.digest,
        createHash("sha256").update(bytes).digest(),
      );
      assert.equal(hashed.size, size);
      assert.equal(hashed.modifiedMs, whole.modifiedMs);
      for (const [offset, length] of [
        [0, size],
        [0, 0],
        [0, 1],
        [Math.floor(size / 2), 7],
        [size, 10],
        [size + 100, 10],
        [0, size + 50],
        [1, size],
      ]) {
        const start = Math.min(offset, size);
        const range = await root.readRange(name, offset, length, budget);
        assert.deepEqual(
          range.bytes,
          bytes.subarray(start, Math.min(start + length, size)),
        );
        assert.equal(range.offset, start);
        assert.equal(range.size, size);
        assert.equal(range.modifiedMs, whole.modifiedMs);
      }
    }
    await mkdir(join(path, "directory"));
    for (const read of [
      (target, max) => root.read(target, max),
      (target, max) => root.readRange(target, 0, 10, max),
      (target, max) => root.digest(target, max),
    ]) {
      await assert.rejects(read("f1000", 100), { code: "file_too_large" });
      await assert.rejects(read("absent", 100), { code: "file_not_found" });
      await assert.rejects(read("directory", 100), { code: "not_a_file" });
      await assert.rejects(read("../escape", 100), {
        code: "path_outside_root",
      });
    }
    await assert.rejects(
      root.readRange("f0", 50 * 1024 * 1024 + 1, 1, 100),
      TypeError,
    );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
