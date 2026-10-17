import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { isProbeFormat, sha256Schema, type CorpusEntry } from "./record.ts";

const manifestLine = z.object({
  file: z.string().min(1),
  sha256: sha256Schema,
  bytes: z.int().nonnegative(),
  format: z.string(),
  license: z.string(),
});

export interface ManifestRejection {
  readonly source: string;
  readonly line: number;
  readonly reason: "malformed" | "outside_source";
}

export interface ManifestScan {
  readonly entries: readonly CorpusEntry[];
  readonly rejected: readonly ManifestRejection[];
  readonly unsupported: number;
}

function isInside(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Turns one source's `manifest.jsonl` into probe entries. Lines in a format
 * the server does not read are counted, not kept.
 *
 * Guard: a manifest is data written by a crawler, so a `file` that is absolute
 * or climbs out of the source folder is refused rather than resolved — the
 * harness never reads bytes the manifest's own source does not hold.
 */
export function parseManifest({
  source,
  sourceDir,
  text,
}: {
  readonly source: string;
  readonly sourceDir: string;
  readonly text: string;
}): ManifestScan {
  const entries: CorpusEntry[] = [];
  const rejected: ManifestRejection[] = [];
  let unsupported = 0;
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === "") continue;
    const line = index + 1;
    const parsed = manifestLine.safeParse(parseJson(raw));
    if (!parsed.success) {
      rejected.push({ source, line, reason: "malformed" });
      continue;
    }
    const { file, sha256, bytes, format, license } = parsed.data;
    if (!isProbeFormat(format)) {
      unsupported += 1;
      continue;
    }
    const path = resolve(sourceDir, file);
    if (isAbsolute(file) || !isInside(sourceDir, path)) {
      rejected.push({ source, line, reason: "outside_source" });
      continue;
    }
    entries.push({ source, file, path, sha256, bytes, format, license });
  }
  return { entries, rejected, unsupported };
}

/**
 * Reads every source folder's manifest under the corpus root. Folders whose
 * name starts with `_` or `.` hold tooling and caches, not sources.
 */
export async function readCorpus({
  root,
  sources,
}: {
  readonly root: string;
  readonly sources?: readonly string[];
}): Promise<ManifestScan> {
  const folders = (await readdir(root, { withFileTypes: true }))
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .filter((name) => !name.startsWith("_") && !name.startsWith("."))
    .sort();
  const unknown = (sources ?? []).filter((name) => !folders.includes(name));
  if (unknown.length > 0) {
    throw new Error(`unknown corpus source: ${unknown.join(", ")}`);
  }
  const selected =
    sources === undefined || sources.length === 0
      ? folders
      : folders.filter((name) => sources.includes(name));
  const entries: CorpusEntry[] = [];
  const rejected: ManifestRejection[] = [];
  let unsupported = 0;
  for (const source of selected) {
    const sourceDir = join(root, source);
    const text = await readFile(
      join(sourceDir, "manifest.jsonl"),
      "utf8",
    ).catch(() => undefined);
    if (text === undefined) continue;
    const scan = parseManifest({ source, sourceDir, text });
    entries.push(...scan.entries);
    rejected.push(...scan.rejected);
    unsupported += scan.unsupported;
  }
  return { entries, rejected, unsupported };
}
