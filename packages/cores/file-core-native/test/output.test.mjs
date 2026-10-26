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

test("publishes a complete directory once and retains every prior entry on collision", async () => {
  await workspace(async (_directory, rootPath) => {
    const source = openRoot(rootPath);
    assert.equal("publishDirectory" in source, false);
    const output = openOutputRoot(source, "out");
    const files = [
      { name: "a.xlsx", content: Buffer.from("first") },
      { name: "b.xlsx", content: Buffer.from("second") },
      { name: "manifest.json", content: Buffer.from('{"complete":true}') },
    ];
    await output.publishDirectory("job", files, 100);
    assert.deepEqual((await readdir(join(rootPath, "out", "job"))).sort(), [
      "a.xlsx",
      "b.xlsx",
      "manifest.json",
    ]);
    for (const file of files)
      assert.deepEqual(
        await readFile(join(rootPath, "out", "job", file.name)),
        file.content,
      );
    await assert.rejects(
      output.publishDirectory(
        "job",
        [{ name: "other", content: Buffer.from("new") }],
        100,
      ),
      { code: "output_exists" },
    );
    assert.deepEqual(await readdir(join(rootPath, "out")), ["job"]);
    assert.deepEqual(
      await readFile(join(rootPath, "out", "job", "a.xlsx")),
      Buffer.from("first"),
    );
  });
});

test("concurrent directory publication has exactly one complete winner", async () => {
  await workspace(async (_directory, rootPath) => {
    const output = openOutputRoot(openRoot(rootPath), "out");
    const results = await Promise.allSettled(
      ["left", "right"].map((value) =>
        output.publishDirectory(
          "job",
          [
            { name: "a", content: Buffer.from(value) },
            { name: "b", content: Buffer.from(value) },
          ],
          100,
        ),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const failure = results.find((result) => result.status === "rejected");
    assert.equal(failure.reason.code, "output_exists");
    const a = await readFile(join(rootPath, "out", "job", "a"), "utf8");
    assert.ok(a === "left" || a === "right");
    assert.equal(await readFile(join(rootPath, "out", "job", "b"), "utf8"), a);
    assert.deepEqual(await readdir(join(rootPath, "out")), ["job"]);
  });
});

test("directory publication validates all names, collisions and budgets before visibility", async () => {
  await workspace(async (directory, rootPath) => {
    const output = openOutputRoot(openRoot(rootPath), "out");
    for (const name of ["../escape", "/escape", ".", "nested/file"])
      await assert.rejects(
        output.publishDirectory(
          "job",
          [{ name, content: Buffer.from("x") }],
          100,
        ),
        TypeError,
      );
    await assert.rejects(
      output.publishDirectory(
        "job",
        [
          { name: "A", content: Buffer.from("x") },
          { name: "a", content: Buffer.from("y") },
        ],
        100,
      ),
      TypeError,
    );
    await assert.rejects(
      output.publishDirectory(
        "job",
        [{ name: "a", content: Buffer.from("123") }],
        2,
      ),
      { code: "file_too_large" },
    );
    assert.deepEqual(await readdir(join(rootPath, "out")), []);
    await symlink(
      join(directory, "outside"),
      join(rootPath, "out", "job"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      output.publishDirectory(
        "job",
        [{ name: "a", content: Buffer.from("secret") }],
        100,
      ),
      { code: "output_exists" },
    );
    assert.deepEqual(await readdir(join(directory, "outside")), []);
    assert.deepEqual(await readdir(join(rootPath, "out")), ["job"]);
  });
});

test("directory publication uses its pinned parent after the path is replaced", async () => {
  await workspace(async (directory, rootPath) => {
    const output = openOutputRoot(openRoot(rootPath), "out");
    await rename(join(rootPath, "out"), join(rootPath, "retained"));
    await symlink(
      join(directory, "outside"),
      join(rootPath, "out"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await output.publishDirectory(
      "job",
      [{ name: "a", content: Buffer.from("complete") }],
      100,
    );
    assert.equal(
      await readFile(join(rootPath, "retained", "job", "a"), "utf8"),
      "complete",
    );
    assert.deepEqual(await readdir(join(directory, "outside")), []);
  });
});

test("directory publication snapshots every buffer before asynchronous work", async () => {
  await workspace(async (_directory, rootPath) => {
    const output = openOutputRoot(openRoot(rootPath), "out");
    const content = Buffer.from("original");
    const pending = output.publishDirectory(
      "job",
      [{ name: "data", content }],
      100,
    );
    content.fill(0);
    await pending;
    assert.equal(
      await readFile(join(rootPath, "out", "job", "data"), "utf8"),
      "original",
    );
  });
});

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
