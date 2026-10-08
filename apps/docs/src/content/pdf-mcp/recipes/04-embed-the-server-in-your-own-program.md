# Embed the server in your own program

Start the server from your own Node.js program when you need options the `sezzlee-pdf` command does
not expose: how many extracted documents stay in memory, how many reads may run at once, or an OCR
binding built in code.

## Install the packages

```sh
mkdir -p ~/sezzlee-embed && cd ~/sezzlee-embed && npm init -y >/dev/null
npm install --silent @sezzlee/pdf-mcp @modelcontextprotocol/server
```

`@modelcontextprotocol/server` provides the stdio transport the server is served over.

## Write the program

```sh
cat > ~/sezzlee-embed/server.mjs <<'EOF'
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createDocumentRoot, createPdfMcpServer } from "@sezzlee/pdf-mcp";

const root = await createDocumentRoot(process.argv[2]);
const server = createPdfMcpServer(root, {
  documentCacheSize: 4,
  maxConcurrentExtractions: 1,
});
serveStdio(() => server);
EOF
```

`createDocumentRoot` checks the folder the same way the command does and throws if it does not
exist. `createPdfMcpServer` takes these options, all optional:

| Option                     | Default | Meaning                                                                                 |
| -------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `documentCacheSize`        | `2`     | Extracted documents kept in memory, 1 to 16. Each one holds the Markdown of every page. |
| `maxConcurrentExtractions` | `2`     | Documents extracted at once before a new read fails with `resource_limit`.              |
| `maxConcurrentListings`    | `4`     | `list_documents` calls running at once before a new one fails with `resource_limit`.    |
| `ocr`                      | none    | An OCR binding, the same object a `--ocr` module exports by default.                    |

A `documentCacheSize` outside 1 to 16 throws `invalid_argument` when the server is created.

## Call it

The program is a stdio MCP server like the command, so the Inspector can start it:

```sh
npx -y @modelcontextprotocol/inspector --cli node ~/sezzlee-embed/server.mjs ~/sezzlee-pdf \
  --method tools/call --tool-name describe_document --tool-arg filePath=annual-report.pdf \
  | jq -c '.content[0].text | fromjson | {pageCount, documentType}'
```

```json
{"pageCount":4,"documentType":"text_based"}
```

In a client configuration, the command is `node` and the arguments are the program's absolute path
and the folder.

## Bind OCR in code

The `ocr` option takes the binding object directly, so the adapters from
[Read scanned pages with OCR](/docs/pdf-mcp/read-scanned-pages-with-ocr) can be configured without a
separate module:

```js
import { createPdfjsRasterizer } from "@sezzlee/pdf-raster-pdfjs";
import { createOllamaOcrProvider } from "@sezzlee/ocr-ollama";

const server = createPdfMcpServer(root, {
  ocr: {
    rasterizer: createPdfjsRasterizer(),
    provider: createOllamaOcrProvider({ baseUrl: "http://127.0.0.1:11434", model: "deepseek-ocr:3b" }),
    dpi: 200,
    maxPagesPerCall: 5,
    timeoutMs: 60_000,
  },
});
```

`maxPagesPerCall` and `timeoutMs` can only lower the server's own ceilings of 10 pages and two
minutes. To use a different model host, implement the two methods yourself: `render({ bytes, pages,
dpi, signal })` returns `{ page, image, mediaType }` for each requested page, and `recognize({ pages,
signal })` returns `{ page, markdown, confidence? }` for each image. Page numbers are 1-based, and an
answer for a page that was not asked for is ignored.
