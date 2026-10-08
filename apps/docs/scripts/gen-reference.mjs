import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const contentDir = path.resolve(here, "../src/content");
const notesDir = path.resolve(here, "../reference");
const check = process.argv.includes("--check");

const servers = [
  {
    product: "excel-mcp",
    pkg: "@sezzlee/excel-mcp",
    dir: "excel-mcp",
    root: true,
  },
  { product: "xml-mcp", pkg: "@sezzlee/xml-mcp", dir: "xml-mcp", root: true },
  { product: "pdf-mcp", pkg: "@sezzlee/pdf-mcp", dir: "pdf-mcp", root: true },
  {
    product: "mssql-mcp",
    pkg: "@sezzlee/mssql-mcp",
    dir: "mssql-mcp",
    env: {
      SEZZLEE_MSSQL_SERVER: "127.0.0.1",
      SEZZLEE_MSSQL_DATABASE: "docs",
      SEZZLEE_MSSQL_USER: "docs",
      SEZZLEE_MSSQL_PASSWORD: "docs",
    },
  },
  {
    product: "postgres-mcp",
    pkg: "@sezzlee/postgres-mcp",
    dir: "postgres-mcp",
    env: {
      SEZZLEE_POSTGRES_SERVER: "127.0.0.1",
      SEZZLEE_POSTGRES_PORT: "9",
      SEZZLEE_POSTGRES_DATABASE: "docs",
      SEZZLEE_POSTGRES_USER: "docs",
      SEZZLEE_POSTGRES_PASSWORD: "docs",
      SEZZLEE_POSTGRES_SSL_MODE: "disable",
      SEZZLEE_POSTGRES_CONNECT_TIMEOUT_MS: "2000",
    },
  },
  {
    product: "llm-mcp",
    pkg: "@sezzlee/llm-mcp",
    dir: "llm-mcp",
    workspace: true,
    env: {
      SEZZLEE_LLM_MODEL: "docs",
      SEZZLEE_LLM_BASE_URL: "http://127.0.0.1:9",
    },
  },
];

const problems = [];

/**
 * Guard: the pages are built from what the running server answers, never from its source, so an
 * argument added to a zod schema and forgotten here cannot exist — WRITING.md rule 2.
 */
function interrogate(server, scratch, example) {
  const cli = path.join(repo, "packages/servers", server.dir, "dist/cli.js");
  const args = server.root ? [cli, scratch] : [cli];
  const env = { ...process.env, ...server.env };
  if (server.workspace) {
    env.SEZZLEE_LLM_ROOT = scratch;
    env.SEZZLEE_LLM_OUTPUT_DIR = scratch;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${server.pkg}: no answer within 20 s`));
    }, 20_000);
    let stderr = "";
    let buffer = "";
    const answer = {};
    const send = (message) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const finish = () => {
      clearTimeout(timer);
      child.kill();
      resolve(answer);
    };
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) {
        reject(new Error(`${server.pkg} exited ${code}: ${stderr.trim()}`));
      }
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.id === 1) {
          answer.serverInfo = message.result.serverInfo;
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list" });
        } else if (message.id === 2) {
          answer.tools = message.result.tools;
          if (example === undefined) {
            finish();
          } else {
            send({
              id: 3,
              method: "tools/call",
              params: { name: example.tool, arguments: example.arguments },
            });
          }
        } else if (message.id === 3) {
          answer.example = message.result;
          finish();
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "sezzlee-docs", version: "0.0.0" },
      },
    });
  });
}

const cell = (text) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const code = (value) => `\`${cell(JSON.stringify(value))}\``;

/**
 * Guard: zod's `.int()` writes ±`Number.MAX_SAFE_INTEGER` as the bound of every integer, which is a
 * representation limit rather than an argument limit; printing it reads as a real ceiling.
 */
const meaningful = (value) =>
  Math.abs(value ?? 0) === Number.MAX_SAFE_INTEGER ? undefined : value;

function bounds(schema, unit) {
  const low = meaningful(schema.minimum ?? schema.minItems ?? schema.minLength);
  const high = meaningful(
    schema.maximum ?? schema.maxItems ?? schema.maxLength,
  );
  if (low === undefined && high === undefined) return "";
  if (low !== undefined && high !== undefined)
    return ` (${low}–${high}${unit})`;
  return low !== undefined ? ` (≥ ${low}${unit})` : ` (≤ ${high}${unit})`;
}

function typeOf(schema) {
  if (schema.const !== undefined) return code(schema.const);
  if (schema.enum) return schema.enum.map(code).join(" \\| ");
  if (schema.oneOf) return "one of the variants below";
  if (schema.type === "array") {
    const item = schema.items ?? {};
    const inner = item.type === "object" ? "object" : typeOf(item);
    return `array of ${inner}${bounds(schema, " items")}`;
  }
  if (schema.type === "object") return "object";
  const unit = schema.type === "string" ? " chars" : "";
  const pattern = schema.pattern ? `, pattern ${code(schema.pattern)}` : "";
  const type = [schema.type ?? "any"].flat().join(" \\| ");
  return `${type}${bounds(schema, unit)}${pattern}`;
}

/**
 * Guard: an argument with no description reaches the agent as a bare name and type, so the page
 * refuses to render one instead of printing an empty cell.
 */
function rows(schema, prefix, out, owner) {
  const required = new Set(schema.required ?? []);
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const key = `${prefix}${name}`;
    if (!property.description && property.const === undefined) {
      problems.push(`${owner}: argument \`${key}\` has no description`);
    }
    out.push(
      `| \`${key}\` | ${typeOf(property)} | ${required.has(name) ? "yes" : ""} | ${cell(property.description ?? "")} |`,
    );
    const item = property.type === "array" ? property.items : undefined;
    if (item?.type === "object") rows(item, `${key}[].`, out, owner);
    if (property.type === "object" && property.properties) {
      rows(property, `${key}.`, out, owner);
    }
    if (property.oneOf) variants(property.oneOf, key, out, owner);
    if (item?.oneOf) variants(item.oneOf, `${key}[]`, out, owner);
  }
}

function variants(options, key, out, owner) {
  for (const option of options) {
    const tag = Object.entries(option.properties ?? {}).find(
      ([, value]) => value.const !== undefined,
    );
    const label = tag
      ? `${tag[0]}: ${JSON.stringify(tag[1].const)}`
      : "variant";
    rows(option, `${key} (${label}).`, out, owner);
  }
}

function hints(annotations = {}) {
  const facts = [];
  if (annotations.readOnlyHint) facts.push("read-only");
  if (annotations.destructiveHint === false) facts.push("non-destructive");
  if (annotations.idempotentHint) facts.push("idempotent");
  if (annotations.openWorldHint === false) facts.push("closed world");
  if (annotations.openWorldHint === true) facts.push("open world");
  return facts;
}

const provenance = (server, serverInfo, what) =>
  `> Generated from ${what} of \`${server.pkg}\` ${serverInfo.version}.`;

function toolsPage(server, { serverInfo, tools }) {
  const lines = [
    "# Tools",
    "",
    provenance(
      server,
      serverInfo,
      `the \`tools/list\` answer (server name \`${serverInfo.name}\`)`,
    ),
    "",
    "The descriptions are the text the server publishes to every client, so your agent reads exactly what this page shows. Every input schema is closed: an argument a tool does not list here, or a value of the wrong type, is refused with `invalid_argument` and never silently ignored.",
    "",
    `${tools.length} tools: ${tools.map((tool) => `\`${tool.name}\``).join(", ")}.`,
  ];
  for (const tool of tools) {
    lines.push("", `## \`${tool.name}\``, "", tool.description.trim());
    const facts = hints(tool.annotations);
    if (facts.length > 0) {
      lines.push("", `Annotations: ${facts.join(", ")}.`);
    }
    const table = [];
    rows(tool.inputSchema, "", table, `${server.pkg} ${tool.name}`);
    if (table.length === 0) {
      lines.push("", "Takes no arguments.");
    } else {
      lines.push(
        "",
        "| Argument | Type | Required | Description |",
        "| --- | --- | --- | --- |",
        ...table,
      );
    }
  }
  return lines.join("\n");
}

function unionMembers(file, name) {
  const source = readFileSync(path.join(repo, file), "utf8");
  const start = source.indexOf(`export type ${name} =`);
  if (start < 0) {
    problems.push(`${file}: no \`export type ${name}\``);
    return [];
  }
  const body = source.slice(start, source.indexOf(";", start));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

/**
 * Guard: the code list comes from the error-code union types, and every member needs a sentence in
 * `apps/docs/reference/<product>.json`; a code added to the server without one fails `validate`,
 * and so does a sentence for a code the server no longer has.
 */
function errorsPage(server, answer, notes) {
  const codes = new Set(
    notes.sources.flatMap(([file, name]) => unionMembers(file, name)),
  );
  const described = new Set();
  const lines = [
    "# Error codes",
    "",
    provenance(server, answer.serverInfo, "the error-code union types"),
    "",
    "A tool that fails answers with `isError: true` and one text item holding a JSON object with three fields: `error`, a stable machine code from this page; `message`, what went wrong; and `recovery`, what the next call should do differently. Branch on `error`, never on `message`.",
    "",
    `This is the answer to \`${answer.exampleCall}\` ${notes.example.situation ?? "in a folder that has no such file"}:`,
    "",
    "```json",
    JSON.stringify(answer.example, null, 2),
    "```",
    "",
    "The text item, parsed:",
    "",
    "```json",
    JSON.stringify(JSON.parse(answer.example.content[0].text), null, 2),
    "```",
    "",
    `The server has ${codes.size} codes.`,
  ];
  for (const section of notes.sections) {
    lines.push(
      "",
      `## ${section.title}`,
      "",
      "| Code | Meaning |",
      "| --- | --- |",
    );
    for (const [name, meaning] of Object.entries(section.codes)) {
      if (!codes.has(name)) {
        problems.push(
          `reference/${server.product}.json: "${name}" is not an error code of ${server.pkg}`,
        );
      }
      described.add(name);
      lines.push(`| \`${name}\` | ${cell(meaning)} |`);
    }
  }
  for (const name of codes) {
    if (!described.has(name)) {
      problems.push(
        `reference/${server.product}.json: error code "${name}" has no meaning`,
      );
    }
  }
  return lines.join("\n");
}

function magnitude(key, value) {
  if (/Bytes$/.test(key)) {
    for (const [unit, size] of [
      ["MB", 1024 * 1024],
      ["KB", 1024],
    ]) {
      if (value >= size && value % size === 0) return `${value / size} ${unit}`;
    }
    return `${value} bytes`;
  }
  if (/Ms$/.test(key)) {
    return value % 1000 === 0 ? `${value / 1000} s` : `${value} ms`;
  }
  return value.toLocaleString("en-US");
}

async function limitsPage(server, answer, notes) {
  const { limits } = await import(
    pathToFileURL(path.join(repo, notes.module)).href
  );
  const described = new Set(Object.keys(notes.hidden ?? {}));
  const lines = [
    "# Limits",
    "",
    provenance(server, answer.serverInfo, "the exported `limits` object"),
    "",
    "Every limit is fixed at build time; none is configurable. A call that would cross one either answers with `truncated: true` and a way to continue, or fails with `resource_limit`.",
  ];
  for (const section of notes.sections) {
    lines.push(
      "",
      `## ${section.title}`,
      "",
      "| Limit | Value |",
      "| --- | --- |",
    );
    for (const [key, meaning] of Object.entries(section.keys)) {
      if (!(key in limits)) {
        problems.push(
          `reference/${server.product}.json: "${key}" is not a limit of ${server.pkg}`,
        );
        continue;
      }
      described.add(key);
      lines.push(`| ${cell(meaning)} | ${magnitude(key, limits[key])} |`);
    }
  }
  for (const key of Object.keys(limits)) {
    if (!described.has(key)) {
      problems.push(
        `reference/${server.product}.json: limit "${key}" is neither described nor hidden`,
      );
    }
  }
  return lines.join("\n");
}

function notesOf(product) {
  const file = path.join(notesDir, `${product}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

const registered = new Set(
  JSON.parse(readFileSync(path.join(contentDir, "products.json"), "utf8")).map(
    (entry) => entry.id,
  ),
);
const published = servers.filter((server) => registered.has(server.product));

const scratch = mkdtempSync(path.join(tmpdir(), "sezzlee-docs-"));
const stale = [];
try {
  const answers = await Promise.all(
    published.map((server) =>
      interrogate(server, scratch, notesOf(server.product).errors?.example),
    ),
  );
  for (const [i, server] of published.entries()) {
    const notes = notesOf(server.product);
    const answer = answers[i];
    const pages = { "reference/01-tools.md": toolsPage(server, answer) };
    if (notes.errors) {
      const call = notes.errors.example;
      answer.exampleCall = `${call.tool} ${JSON.stringify(call.arguments)}`;
      pages["reference/02-error-codes.md"] = errorsPage(
        server,
        answer,
        notes.errors,
      );
    }
    if (notes.limits) {
      pages["reference/03-limits.md"] = await limitsPage(
        server,
        answer,
        notes.limits,
      );
    }
    for (const [relative, markdown] of Object.entries(pages)) {
      const target = path.join(contentDir, server.product, relative);
      const page = await format(`${markdown}\n`, {
        ...(await resolveConfig(target)),
        filepath: target,
      });
      const current = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (current === page) continue;
      if (check) {
        stale.push(path.relative(repo, target));
      } else {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, page);
        process.stdout.write(`wrote ${path.relative(repo, target)}\n`);
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length > 0) {
  process.stderr.write(
    `Reference notes disagree with the servers:\n${problems.map((line) => `  ${line}`).join("\n")}\n`,
  );
  process.exit(1);
}
if (stale.length > 0) {
  process.stderr.write(
    `Generated reference is out of date; run \`pnpm --filter @sezzlee/docs gen\`:\n${stale.map((file) => `  ${file}`).join("\n")}\n`,
  );
  process.exit(1);
}
