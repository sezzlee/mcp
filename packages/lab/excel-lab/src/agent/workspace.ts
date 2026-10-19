import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareOutRoot, sha256OfFile } from "../run.ts";
import type { Catalog } from "./task.ts";

/**
 * Copies every catalog file from the corpus into a fresh workspace under its
 * clean `as` path, refusing a file whose bytes no longer match its digest.
 * @returns the workspace's real path.
 */
export async function buildWorkspace({
  catalog,
  corpusRoot,
  outRoot,
}: {
  readonly catalog: Catalog;
  readonly corpusRoot: string;
  readonly outRoot: string;
}): Promise<string> {
  const root = await prepareOutRoot(outRoot);
  const workspace = join(root, "workspace");
  await rm(workspace, { recursive: true, force: true });
  for (const [id, file] of Object.entries(catalog.files)) {
    const source = join(corpusRoot, file.source, file.file);
    const actual = await sha256OfFile(source);
    if (actual !== file.sha256)
      throw new Error(
        `${id}: ${file.source}/${file.file} has sha256 ${actual}, the catalog expects ${file.sha256}`,
      );
    const target = join(workspace, file.as);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return workspace;
}
