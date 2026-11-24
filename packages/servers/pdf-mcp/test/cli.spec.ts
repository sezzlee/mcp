import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, inject, it } from "vitest";
import { bodyOf } from "./fixtures/harness.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const binding = fileURLToPath(
  new URL("./fixtures/page-image-binding.mjs", import.meta.url),
);

it.each([[["--pages"]], [["--pages", "--ocr"]]])(
  "exits with usage when --pages has no value (%j)",
  (flags) => {
    const child = spawnSync(
      process.execPath,
      [cli, inject("fixtures").root, ...flags],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(child.status, child.stderr).toBe(2);
    expect(child.stderr).toContain("[--pages <module>]");
  },
);

it.each([
  ["@sezzlee/pdf-raster-pdfjs", "does not export a page-image binding"],
  [`${binding}.missing`, "could not be loaded"],
])("exits when the page-image module is invalid (%s)", (specifier, message) => {
  const child = spawnSync(
    process.execPath,
    [cli, inject("fixtures").root, "--pages", specifier],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(child.status, child.stderr).toBe(1);
  expect(child.stderr).toContain(message);
});

it("serves an image over stdio with only --pages configured", async () => {
  const client = new Client({ name: "pdf-cli-spec", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "--pages", binding, inject("fixtures").root],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const filePath = "scanned.pdf";
    const described = await client.callTool({
      name: "describe_document",
      arguments: { filePath },
    });
    expect(bodyOf(described)["capabilities"]).toMatchObject({
      ocr: false,
      pageImages: true,
    });
    const result = await client.callTool({
      name: "view_pages",
      arguments: { filePath, pages: [1] },
    });
    expect(result.content).toEqual([
      { type: "text", text: "Showing page 1." },
      {
        type: "image",
        data: expect.stringMatching(/^iVBORw0KGgo/),
        mimeType: "image/png",
      },
    ]);
  } finally {
    await client.close();
  }
}, 15_000);
