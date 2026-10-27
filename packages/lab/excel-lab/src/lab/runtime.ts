import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export interface Identity {
  readonly files: number;
  readonly sha256: string;
}

async function digestTree(
  directory: string,
  include: (name: string) => boolean,
): Promise<Identity> {
  const hash = createHash("sha256");
  let files = 0;
  async function walk(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (include(entry.name)) {
        hash
          .update(relative(directory, file))
          .update("\0")
          .update(await readFile(file))
          .update("\0");
        files += 1;
      }
    }
  }
  await walk(directory);
  return { files, sha256: hash.digest("hex") };
}

/** The installed excel-mcp build the trials run against. */
export function serverIdentity(): Promise<Identity> {
  return digestTree(
    dirname(fileURLToPath(import.meta.resolve("@sezzlee/excel-mcp"))),
    (name) => name.endsWith(".js"),
  );
}

/** The lab's own runner sources and oracle scripts. */
export async function labIdentity(): Promise<{
  readonly sources: Identity;
  readonly oracles: Identity;
}> {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  return {
    sources: await digestTree(join(root, "src"), (name) =>
      name.endsWith(".ts"),
    ),
    oracles: await digestTree(join(root, "scripts"), (name) =>
      name.endsWith(".py"),
    ),
  };
}
