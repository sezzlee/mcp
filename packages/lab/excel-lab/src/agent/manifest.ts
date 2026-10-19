import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { commitOf } from "../run.ts";
import { systemPrompt } from "./agent-run.ts";
import { graderVersion } from "./grade.ts";
import { thinkingPolicies, type HostIdentity, type ToolSpec } from "./host.ts";
import { catalogPath } from "./task.ts";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  catalog: sha256,
  oracle: sha256,
  graderVersion: z.string(),
  lab: z.strictObject({ commit: z.string().nullable(), sources: sha256 }),
  server: z.strictObject({ version: z.string(), dist: sha256 }),
  tools: sha256,
  systemPrompt: sha256,
  host: z.strictObject({
    provider: z.string(),
    model: z.string(),
    digest: z.string().nullable(),
    version: z.string().nullable(),
    details: z.record(z.string(), z.unknown()).nullable(),
  }),
  generation: z.strictObject({
    window: z.int().positive(),
    temperature: z.number(),
    thinking: z.enum(thinkingPolicies),
    keepAlive: z.string(),
    callBudget: z.int().positive(),
    timeoutMs: z.int().positive(),
  }),
  node: z.string(),
});
export type Manifest = z.infer<typeof manifestSchema>;

const labRoot = fileURLToPath(new URL("../../", import.meta.url));
const oraclePath = new URL("../../scripts/agent-oracle.py", import.meta.url);

function digest(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function treeDigest(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(relative(root, file))
      .update("\0")
      .update(await readFile(file))
      .update("\0");
  return hash.digest("hex");
}

/** Hashes a value's canonical JSON, keys sorted, so field order never changes an identity. */
export function canonicalHash(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : typeof item === "object" && item !== null
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, inner]) => [key, canonical(inner)]),
          )
        : item;
  return digest(JSON.stringify(canonical(value)));
}

/**
 * Everything a run's outcome depends on besides the model's sampling: the
 * catalog, oracle, grader and lab sources, the server build and its tool
 * list, the host's model digest and version, and the generation settings.
 * Two runs compare as one condition only when every field but the declared
 * treatment matches.
 */
export async function buildManifest(input: {
  readonly host: HostIdentity;
  readonly tools: readonly ToolSpec[];
  readonly generation: Manifest["generation"];
}): Promise<Manifest> {
  const serverEntry = fileURLToPath(import.meta.resolve("@sezzlee/excel-mcp"));
  const serverDist = dirname(serverEntry);
  const serverPackage = z
    .object({ version: z.string() })
    .parse(
      JSON.parse(
        await readFile(join(serverDist, "..", "package.json"), "utf8"),
      ),
    );
  return manifestSchema.parse({
    schemaVersion: 1,
    catalog: digest(await readFile(catalogPath)),
    oracle: digest(await readFile(oraclePath)),
    graderVersion,
    lab: {
      commit: commitOf(labRoot),
      sources: await treeDigest(join(labRoot, "src")),
    },
    server: {
      version: serverPackage.version,
      dist: await treeDigest(serverDist),
    },
    tools: canonicalHash(input.tools),
    systemPrompt: digest(systemPrompt),
    host: input.host,
    generation: input.generation,
    node: process.version,
  });
}

/** The fields two manifests disagree on, as dotted paths. */
export function manifestDifferences(
  left: Manifest,
  right: Manifest,
): readonly string[] {
  const differences: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (
      typeof a === "object" &&
      a !== null &&
      typeof b === "object" &&
      b !== null &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of [...keys].sort())
        walk(
          Object.entries(a).find(([name]) => name === key)?.[1],
          Object.entries(b).find(([name]) => name === key)?.[1],
          path === "" ? key : `${path}.${key}`,
        );
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(path);
  };
  walk(left, right, "");
  return differences;
}
