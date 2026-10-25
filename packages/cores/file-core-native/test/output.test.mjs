import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoot, openOutputRoot } from "../index.js";

async function workspace(run) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "native-output-")),
  );
  try {
    await mkdir(join(directory, "root"));
    await mkdir(join(directory, "root", "out"));
    await mkdir(join(directory, "outside"));
    await run(directory, join(directory, "root"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("output capability is separate from source reads and never replaces an existing file", async () => {
  await workspace(async (_directory, rootPath) => {
    const source = openRoot(rootPath);
    assert.equal("publish" in source, false);
    const output = openOutputRoot(source, "out");
    const original = Buffer.from("source bytes");
    await writeFile(join(rootPath, "out", "version.xlsx"), original);
    await assert.rejects(
      output.publish("version.xlsx", Buffer.from("replacement"), 100),
      { code: "output_exists" },
    );
    assert.deepEqual(
      await readFile(join(rootPath, "out", "version.xlsx")),
      original,
    );
    assert.deepEqual(await readdir(join(rootPath, "out")), ["version.xlsx"]);
  });
});

test("output publication stays on the pinned directory after its pathname becomes a symlink", async () => {
  await workspace(async (directory, rootPath) => {
    const output = openOutputRoot(openRoot(rootPath), "out");
    await rename(join(rootPath, "out"), join(rootPath, "original-output"));
    await symlink(
      join(directory, "outside"),
      join(rootPath, "out"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const content = Buffer.from("complete version");
    await output.publish("version.xlsx", content, 100);
    assert.deepEqual(
      await readFile(join(rootPath, "original-output", "version.xlsx")),
      content,
    );
    assert.deepEqual(await readdir(join(directory, "outside")), []);
  });
});

test("output rejects directory escapes, symlink destinations and byte budget overflow", async () => {
  await workspace(async (directory, rootPath) => {
    const source = openRoot(rootPath);
    await symlink(
      join(directory, "outside"),
      join(rootPath, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(() => openOutputRoot(source, "escape"), {
      code: "path_outside_root",
    });
    const output = openOutputRoot(source, "out");
    await assert.rejects(
      output.publish("../outside.xlsx", Buffer.from("x"), 10),
      TypeError,
    );
    await assert.rejects(
      output.publish("too-large.xlsx", Buffer.from("123"), 2),
      { code: "file_too_large" },
    );
    const secret = join(directory, "outside", "secret.xlsx");
    await writeFile(secret, "unchanged");
    await symlink(secret, join(rootPath, "out", "version.xlsx"));
    await assert.rejects(
      output.publish("version.xlsx", Buffer.from("new"), 100),
      { code: "output_exists" },
    );
    assert.equal(await readFile(secret, "utf8"), "unchanged");
    assert.deepEqual(await readdir(join(rootPath, "out")), ["version.xlsx"]);
  });
});

test("output copies the input before asynchronous work and publishes one complete winner", async () => {
  await workspace(async (_directory, rootPath) => {
    const output = openOutputRoot(openRoot(rootPath), "out");
    const input = Buffer.from("complete immutable bytes");
    const pending = output.publish("stable.xlsx", input, 100);
    input.fill(0);
    await pending;
    assert.equal(
      await readFile(join(rootPath, "out", "stable.xlsx"), "utf8"),
      "complete immutable bytes",
    );
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        output.publish("winner.xlsx", Buffer.alloc(8192, i + 1), 8192),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    for (const result of results)
      if (result.status === "rejected")
        assert.equal(result.reason.code, "output_exists");
    const winner = await readFile(join(rootPath, "out", "winner.xlsx"));
    assert.equal(winner.length, 8192);
    assert.ok(winner[0] >= 1 && winner[0] <= 8);
    assert.ok(winner.every((byte) => byte === winner[0]));
    assert.deepEqual((await readdir(join(rootPath, "out"))).sort(), [
      "stable.xlsx",
      "winner.xlsx",
    ]);
  });
});
