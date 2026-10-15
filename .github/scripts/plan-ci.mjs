import { appendFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

/**
 * Decides what one CI run has to prove: the packages changed since the last green CI of main plus
 * the packages about to be published, each with its dependents.
 *
 * Guard: a run that cannot establish its base runs everything. So does a change to anything turbo
 * cannot attribute to a package — the workflows, these scripts, the root manifests and the
 * lockfile — because a scoped run would then skip exactly the packages that change could break.
 */

const nativePackages = [
  "@sezzlee/file-core-native",
  "@sezzlee/mcp-core",
  "@sezzlee/file-core",
  "@sezzlee/ooxml-core",
  "@sezzlee/excel-mcp",
  "@sezzlee/xml-mcp",
  "@sezzlee/llm-mcp",
  "@sezzlee/pdf-mcp",
  "@sezzlee/pdf-raster-pdfjs",
  "@sezzlee/ocr-ollama",
];
const httpPackages = [
  "@sezzlee/core",
  "@sezzlee/openapi",
  "@sezzlee/openapi-mcp",
  "@sezzlee/sdk-nestjs",
];
const dotnetPackages = [
  "@sezzlee/sdk-dotnet",
  "@sezzlee/conformance",
  "@sezzlee/spec",
  "@sezzlee/openapi",
  "@sezzlee/openapi-mcp",
];
const wholeRepo = [
  /^\.github\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^turbo\.json$/,
  /^\.npmrc$/,
];
const ciJob = "ci / build, lint, types, fixtures";
const packageName = /^@?[a-z0-9][a-z0-9._/-]*$/;

const env = process.env;
const event = env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
const pullRequest = event === "pull_request";

const filtersOf = (names) => names.map((name) => `--filter=${name}`).join(" ");

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...env, ...extra },
  });
  return { ok: result.status === 0, out: result.stdout.trim() };
}

function workspacePackages(filters, base) {
  const listed = run(
    "pnpm",
    ["exec", "turbo", "ls", ...filters, "--output=json"],
    base === undefined ? {} : { TURBO_SCM_BASE: base, TURBO_SCM_HEAD: "HEAD" },
  );
  if (!listed.ok) {
    throw new Error(`turbo ls ${filters.join(" ")} failed`);
  }
  const names = JSON.parse(listed.out).packages.items.map((item) => item.name);
  for (const name of names) {
    if (!packageName.test(name)) {
      throw new Error(`refusing an unexpected package name: ${name}`);
    }
  }
  return names;
}

async function github(path) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(env.GH_TOKEN ? { authorization: `Bearer ${env.GH_TOKEN}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${path}`);
  }
  return response.json();
}

async function lastGreenBase() {
  const repo = env.GITHUB_REPOSITORY;
  const runs = await github(
    `repos/${repo}/actions/workflows/publish.yml/runs?branch=main&status=success&per_page=30`,
  );
  for (const candidate of runs.workflow_runs) {
    const { jobs } = await github(
      `repos/${repo}/actions/runs/${candidate.id}/jobs?filter=latest&per_page=100`,
    );
    const ci = jobs.find((job) => job.name === ciJob);
    if (ci?.conclusion === "success") {
      return { sha: candidate.head_sha, run: candidate.id };
    }
  }
  return undefined;
}

async function unpublished(publicPackages) {
  const missing = [];
  for (const { name, version } of publicPackages) {
    const response = await fetch(
      `https://registry.npmjs.org/${name}/${version}`,
    );
    if (response.status === 404) {
      missing.push(name);
    } else if (!response.ok) {
      throw new Error(`npm answered ${response.status} for ${name}@${version}`);
    }
  }
  for (const nugetPackage of [
    "Sezzlee.AspNetCore",
    "Sezzlee.AspNetCore.NewtonsoftJson",
    "Sezzlee.AspNetCore.Testing",
  ]) {
    const project = await readFile(
      `sdks/dotnet/src/${nugetPackage}/${nugetPackage}.csproj`,
      "utf8",
    );
    const nugetVersion = /<VersionPrefix>([^<]+)<\/VersionPrefix>/.exec(
      project,
    )?.[1];
    const nuget = await fetch(
      `https://api.nuget.org/v3-flatcontainer/${nugetPackage.toLowerCase()}/index.json`,
    );
    const published = nuget.ok ? (await nuget.json()).versions : [];
    if (nugetVersion === undefined || !published.includes(nugetVersion)) {
      missing.push("@sezzlee/sdk-dotnet");
      break;
    }
  }
  return missing;
}

async function publicPackagesOf(names) {
  const listed = run("pnpm", ["-r", "ls", "--depth", "-1", "--json"]);
  if (!listed.ok) {
    throw new Error("pnpm ls failed");
  }
  return JSON.parse(listed.out)
    .filter((item) => !item.private && names.includes(item.name))
    .map((item) => ({ name: item.name, version: item.version }));
}

async function plan() {
  const all = workspacePackages([]);
  const reasons = [];
  let base = pullRequest ? env.PR_BASE_SHA : undefined;
  if (env.FULL === "true") {
    reasons.push("full was requested");
  }
  if (!pullRequest && reasons.length === 0) {
    const found = await lastGreenBase();
    if (found === undefined) {
      reasons.push("no green CI of main was found");
    } else {
      base = found.sha;
      reasons.push(`base: Publish run ${found.run} (${found.sha.slice(0, 7)})`);
    }
  }
  let full = env.FULL === "true" || base === undefined;
  if (!full && !run("git", ["merge-base", "--is-ancestor", base, "HEAD"]).ok) {
    full = true;
    reasons.push(`${base.slice(0, 7)} is not an ancestor of HEAD`);
  }
  if (!full) {
    const diff = run("git", ["diff", "--name-only", base, "HEAD"]);
    const global = diff.out
      .split("\n")
      .filter((path) => wholeRepo.some((pattern) => pattern.test(path)));
    if (!diff.ok || global.length > 0) {
      full = true;
      reasons.push(`repository-wide change: ${global.slice(0, 5).join(", ")}`);
    }
  }

  const releasing = pullRequest
    ? []
    : await unpublished(await publicPackagesOf(all));
  let scope;
  if (full) {
    scope = all;
  } else {
    const affected = workspacePackages(["--affected"], base);
    const released =
      releasing.length === 0
        ? []
        : workspacePackages(releasing.map((name) => `--filter=...${name}`));
    scope = [...new Set([...affected, ...released])].sort();
  }

  const inScope = (names) => names.some((name) => scope.includes(name));
  const native = !pullRequest && inScope(nativePackages);
  const releasingNative = releasing.some((name) =>
    nativePackages.includes(name),
  );
  return {
    full,
    reasons,
    scope,
    releasing,
    outputs: {
      filters: filtersOf(scope),
      native: String(native),
      node_versions: JSON.stringify(
        native && (full || releasingNative) ? [22, 24] : [24],
      ),
      dotnet: String(inScope(dotnetPackages)),
      pack: String(!pullRequest),
      pack_build: filtersOf([
        ...httpPackages,
        ...(native
          ? nativePackages.filter(
              (name) => name !== "@sezzlee/file-core-native",
            )
          : []),
      ]),
      pack_filters: filtersOf([
        ...httpPackages,
        ...(native ? nativePackages : []),
      ]),
    },
  };
}

const result = await plan();
const lines = Object.entries(result.outputs).map(
  ([key, value]) => `${key}=${value}`,
);
if (env.GITHUB_OUTPUT) {
  await appendFile(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
const summary = [
  `### CI scope (${event})`,
  "",
  `- mode: ${result.full ? "full" : "scoped"}`,
  ...result.reasons.map((reason) => `- ${reason}`),
  `- releasing: ${result.releasing.join(", ") || "nothing"}`,
  `- packages: ${result.scope.join(", ") || "none"}`,
  `- native: ${result.outputs.native} (Node ${result.outputs.node_versions}), dotnet: ${result.outputs.dotnet}, pack: ${result.outputs.pack}`,
  "",
].join("\n");
if (env.GITHUB_STEP_SUMMARY) {
  await appendFile(env.GITHUB_STEP_SUMMARY, summary);
}
process.stdout.write(summary);
