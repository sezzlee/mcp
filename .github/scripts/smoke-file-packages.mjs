import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const input = resolve(process.argv[2] ?? "local/npm-tarballs");
const names = await readdir(input);
const find = (prefix) => {
  const matches = names.filter(
    (name) => name.startsWith(prefix) && name.endsWith(".tgz"),
  );
  if (matches.length > 1)
    throw new Error(`Expected at most one ${prefix} tarball`);
  return matches[0];
};
const archive = (prefix) => {
  const match = find(prefix);
  if (match === undefined)
    throw new Error(`Expected exactly one ${prefix} tarball`);
  return `file:${join(input, match).replaceAll("\\", "/")}`;
};
/**
 * The PDF engine publishes no darwin-x64 binary, so the native job does not pack
 * @sezzlee/pdf-mcp on that leg. Its smoke is skipped there rather than failing.
 */
const packedPdf = find("sezzlee-pdf-mcp-") !== undefined;
const directory = await mkdtemp(join(tmpdir(), "file-packages-smoke-"));
try {
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@modelcontextprotocol/client": "^2.0.0",
        "@sezzlee/file-core-native": archive("sezzlee-file-core-native-"),
        "@sezzlee/mcp-core": archive("sezzlee-mcp-core-"),
        "@sezzlee/db-core": archive("sezzlee-db-core-"),
        "@sezzlee/mssql-mcp": archive("sezzlee-mssql-mcp-"),
        "@sezzlee/postgres-mcp": archive("sezzlee-postgres-mcp-"),
        "@sezzlee/llm-mcp": archive("sezzlee-llm-mcp-"),
        "@sezzlee/file-core": archive("sezzlee-file-core-0"),
        "@sezzlee/ooxml-core": archive("sezzlee-ooxml-core-"),
        "@sezzlee/excel-mcp": archive("sezzlee-excel-mcp-"),
        "@sezzlee/xml-mcp": archive("sezzlee-xml-mcp-"),
        ...(packedPdf
          ? { "@sezzlee/pdf-mcp": archive("sezzlee-pdf-mcp-") }
          : {}),
      },
      overrides: {
        "@sezzlee/file-core-native": "$@sezzlee/file-core-native",
        "@sezzlee/mcp-core": "$@sezzlee/mcp-core",
        "@sezzlee/db-core": "$@sezzlee/db-core",
        "@sezzlee/file-core": "$@sezzlee/file-core",
        "@sezzlee/ooxml-core": "$@sezzlee/ooxml-core",
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
  const data = join(directory, "data");
  await mkdir(data);
  await writeFile(join(data, "smoke.csv"), "name,value\na,1\nb,2\n");
  await writeFile(
    join(data, "smoke.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<catalog xmlns="urn:smoke"><item id="1">first</item></catalog>\n',
  );
  if (packedPdf) {
    await writeFile(
      join(data, "smoke.pdf"),
      Buffer.from(
        "JVBERi0xLjcKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbNSAwIFIgNyAwIFJdL0NvdW50IDI+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+PgplbmRvYmoKNCAwIG9iago8PC9UeXBlL1hPYmplY3QvU3VidHlwZS9JbWFnZS9XaWR0aCAyL0hlaWdodCAyL0NvbG9yU3BhY2UvRGV2aWNlUkdCL0JpdHNQZXJDb21wb25lbnQgOC9MZW5ndGggMTI+PgpzdHJlYW0K/wAAAP8AAAD///8ACmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgMyAwIFI+Pj4+L0NvbnRlbnRzIDYgMCBSPj4KZW5kb2JqCjYgMCBvYmoKPDwvTGVuZ3RoIDYwPj4Kc3RyZWFtCkJUCi9GMSAxOCBUZgoxIDAgMCAxIDcyIDcwMCBUbQooU21va2UgcGFnZSBvbmUgVE9LRU4pIFRqCkVUCgplbmRzdHJlYW0KZW5kb2JqCjcgMCBvYmoKPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgNjEyIDc5Ml0vUmVzb3VyY2VzPDwvRm9udDw8L0YxIDMgMCBSPj4+Pi9Db250ZW50cyA4IDAgUj4+CmVuZG9iago4IDAgb2JqCjw8L0xlbmd0aCA1ND4+CnN0cmVhbQpCVAovRjEgMTggVGYKMSAwIDAgMSA3MiA3MDAgVG0KKFNtb2tlIHBhZ2UgdHdvKSBUagpFVAoKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgOQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1NCAwMDAwMCBuIAowMDAwMDAwMTExIDAwMDAwIG4gCjAwMDAwMDAxNzQgMDAwMDAgbiAKMDAwMDAwMDMxOCAwMDAwMCBuIAowMDAwMDAwNDMwIDAwMDAwIG4gCjAwMDAwMDA1MzggMDAwMDAgbiAKMDAwMDAwMDY1MCAwMDAwMCBuIAp0cmFpbGVyCjw8L1NpemUgOS9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjc1MgolJUVPRgo=",
        "base64",
      ),
    );
  }
  await writeFile(
    join(directory, "smoke.mjs"),
    `
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@sezzlee/excel-mcp')), 'cli.js');
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ${JSON.stringify(data)}] });
const client = new Client({ name:'packed-smoke', version:'1.0.0' });
try {
  await client.connect(transport);
  const result = await client.callTool({ name:'read_sheet', arguments:{ filePath:'smoke.csv' } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text).values, [['a','1'],['b','2']]);
  const regex = await client.callTool({ name:'find_in_sheet', arguments:{ filePath:'smoke.csv', query:'^a$', matchMode:'regex' } });
  assert.notEqual(regex.isError, true); assert.equal(JSON.parse(regex.content[0].text).total,1);
} finally { await client.close(); await transport.close(); }
`,
  );
  await writeFile(
    join(directory, "smoke-xml.mjs"),
    `
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@sezzlee/xml-mcp')), 'cli.js');
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ${JSON.stringify(data)}] });
const client = new Client({ name:'packed-xml-smoke', version:'1.0.0' });
try {
  await client.connect(transport);
  const listed = await client.callTool({ name:'list_documents', arguments:{} });
  assert.notEqual(listed.isError, true);
  const body = JSON.parse(listed.content[0].text);
  assert.equal(body.totalExact, true);
  assert.ok(body.files.some((file) => file.filePath.endsWith('smoke.xml')));
} finally { await client.close(); await transport.close(); }

const { createDocumentRoot, resolveDocumentPath, createXmlWorkerPool, createXmlDocumentCache } = await import('@sezzlee/xml-mcp');
const pool = createXmlWorkerPool();
try {
  const root = await createDocumentRoot(${JSON.stringify(data)});
  const cache = createXmlDocumentCache(pool, root.real);
  const loaded = await cache.load(await resolveDocumentPath(root, 'smoke.xml'));
  assert.equal(loaded.root.localName, 'catalog');
  assert.equal(loaded.root.namespaceUri, 'urn:smoke');
  assert.equal(loaded.declaredEncoding, 'UTF-8');
} finally { await pool.close(); }
`,
  );
  const smoke = spawnSync(process.execPath, [join(directory, "smoke.mjs")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 20000,
  });
  if (smoke.status !== 0)
    throw new Error(`Installed MCP smoke failed: ${smoke.stderr}`);
  const xmlSmoke = spawnSync(
    process.execPath,
    [join(directory, "smoke-xml.mjs")],
    { cwd: directory, encoding: "utf8", timeout: 30000 },
  );
  if (xmlSmoke.status !== 0)
    throw new Error(`Installed XML MCP smoke failed: ${xmlSmoke.stderr}`);
  if (packedPdf) {
    await writeFile(
      join(directory, "smoke-pdf.mjs"),
      `
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@sezzlee/pdf-mcp')), 'cli.js');
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ${JSON.stringify(data)}] });
const client = new Client({ name:'packed-pdf-smoke', version:'1.0.0' });
try {
  await client.connect(transport);
  const listed = await client.callTool({ name:'list_documents', arguments:{} });
  assert.notEqual(listed.isError, true);
  assert.ok(JSON.parse(listed.content[0].text).files.some((file) => file.filePath.endsWith('smoke.pdf')));
  const read = await client.callTool({ name:'read_pages', arguments:{ filePath:'smoke.pdf' } });
  assert.notEqual(read.isError, true);
  const body = JSON.parse(read.content[0].text);
  assert.equal(body.pageCount, 2);
  assert.equal(body.pages[0].page, 1);
  assert.ok(body.pages[0].markdown.includes('TOKEN'));
  const found = await client.callTool({ name:'find_in_document', arguments:{ filePath:'smoke.pdf', query:'TOKEN' } });
  assert.notEqual(found.isError, true);
  const hits = JSON.parse(found.content[0].text);
  assert.equal(hits.matches[0].page, 1);
  assert.equal(hits.coverageComplete, true);
} finally { await client.close(); await transport.close(); }
`,
    );
    const pdfSmoke = spawnSync(
      process.execPath,
      [join(directory, "smoke-pdf.mjs")],
      { cwd: directory, encoding: "utf8", timeout: 30000 },
    );
    if (pdfSmoke.status !== 0)
      throw new Error(`Installed PDF MCP smoke failed: ${pdfSmoke.stderr}`);
  }
  const manifest = JSON.parse(
    await readFile(
      join(directory, "node_modules/@sezzlee/file-core-native/package.json"),
      "utf8",
    ),
  );
  console.log(
    `Installed native ${manifest.version}; snapshot read, regex worker, XML listing and packed-worker parse passed on ${process.platform}-${process.arch} (${basename(input)}). PDF engine: ${packedPdf ? "page read and search passed" : "not packed for this target"}.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
