import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const input = resolve(process.argv[2] ?? "local/npm-tarballs");
const names = await readdir(input);
const archive = (prefix) => {
  const matches = names.filter(
    (name) => name.startsWith(prefix) && name.endsWith(".tgz"),
  );
  if (matches.length !== 1)
    throw new Error(`Expected exactly one ${prefix} tarball`);
  return `file:${join(input, matches[0]).replaceAll("\\", "/")}`;
};
const directory = await mkdtemp(join(tmpdir(), "http-packages-smoke-"));
try {
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@modelcontextprotocol/client": "^2.0.0",
        "@modelcontextprotocol/express": "^2.0.0",
        "@modelcontextprotocol/node": "^2.0.0",
        "@modelcontextprotocol/server": "^2.0.0",
        "@nestjs/common": "^11.0.0",
        "@nestjs/core": "^11.0.0",
        "@nestjs/platform-express": "^11.0.0",
        "reflect-metadata": "^0.2.2",
        rxjs: "^7.8.0",
        zod: "^4.5.4",
        "@sezzlee/core": archive("sezzlee-core-"),
        "@sezzlee/openapi": archive("sezzlee-openapi-0"),
        "@sezzlee/openapi-mcp": archive("sezzlee-openapi-mcp-"),
        "@sezzlee/sdk-nestjs": archive("sezzlee-sdk-nestjs-"),
      },
      overrides: {
        "@sezzlee/core": "$@sezzlee/core",
        "@sezzlee/openapi": "$@sezzlee/openapi",
      },
    }),
  );
  const installed = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--cache",
      join(directory, "npm-cache"),
    ],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 180000,
      shell: process.platform === "win32",
    },
  );
  if (installed.status !== 0)
    throw new Error(`Clean package install failed: ${installed.stderr}`);
  await writeFile(
    join(directory, "openapi.json"),
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Shop", version: "1" },
      servers: [{ url: "https://shop.example.com" }],
      paths: {
        "/orders": {
          get: {
            operationId: "listOrders",
            summary: "List orders",
            responses: { 200: { description: "ok" } },
          },
        },
        "/orders/{id}": {
          get: {
            operationId: "getOrder",
            summary: "Get one order",
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "integer" },
              },
            ],
            responses: { 200: { description: "ok" } },
          },
        },
      },
    }),
  );
  await writeFile(
    join(directory, "gateway.json"),
    JSON.stringify({
      source: "./openapi.json",
      selection: { default: "include" },
    }),
  );
  await writeFile(
    join(directory, "smoke-gateway.mjs"),
    `
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@sezzlee/openapi-mcp')), 'cli.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli],
  env: { ...process.env, SEZZLEE_OPENAPI_CONFIG: ${JSON.stringify(join(directory, "gateway.json"))} },
});
const client = new Client({ name:'packed-http-smoke', version:'1.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['invoke_tool', 'load_tool', 'search_tools']);
  const found = await client.callTool({ name:'search_tools', arguments:{ query:'order' } });
  assert.notEqual(found.isError, true);
  const body = JSON.parse(found.content[0].text);
  assert.deepEqual(body.results.map((result) => result.name).sort(), ['get_order', 'list_orders']);
  const loaded = await client.callTool({ name:'load_tool', arguments:{ name:'get_order' } });
  assert.notEqual(loaded.isError, true);
} finally { await client.close(); await transport.close(); }
`,
  );
  await writeFile(
    join(directory, "smoke-nestjs.mjs"),
    `
import 'reflect-metadata';
import assert from 'node:assert/strict';
const sdk = await import('@sezzlee/sdk-nestjs');
for (const name of ['SezzleeModule', 'SezzleeCatalog', 'SezzleeDispatcher'])
  assert.equal(typeof sdk[name], 'function', name);
`,
  );
  for (const script of ["smoke-gateway.mjs", "smoke-nestjs.mjs"]) {
    const run = spawnSync(process.execPath, [join(directory, script)], {
      cwd: directory,
      encoding: "utf8",
      timeout: 30000,
    });
    if (run.status !== 0)
      throw new Error(`Installed ${script} failed: ${run.stderr}`);
  }
  console.log(
    "Installed HTTP catalog packages; gateway search and load over stdio and the NestJS SDK import passed.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
