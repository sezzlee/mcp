# Let an agent read your XML documents

`@sezzlee/xml-mcp` gives an agent read-only access to the XML files in one folder, and to nothing
outside it. It has no tool that writes, so a document is never modified.

You need Node.js 22 or later.

## 1. Pick a folder

Everything under the folder is readable, subfolders included, so pick the narrowest one that holds
the documents the agent needs. To follow along, create one and save
[orders.xml](/samples/xml-mcp/orders.xml) into it: six orders in the namespace `urn:example:orders`,
each with a payment in a second namespace, `urn:example:payments`. One order has no region and one
has no payment, as real exports do.

```sh
mkdir -p ~/sezzlee-xml
```

## 2. Add the server to your client

Pass the folder as an **absolute** path. A JSON configuration is not read by a shell, so `~` is not
expanded there.

:::tabs

```sh title="Claude Code"
claude mcp add xml -- npx -y @sezzlee/xml-mcp /Users/you/sezzlee-xml
```

```json title="Claude Desktop"
{
  "mcpServers": {
    "xml": {
      "command": "npx",
      "args": ["-y", "@sezzlee/xml-mcp", "/Users/you/sezzlee-xml"]
    }
  }
}
```

```json title="Cursor"
{
  "mcpServers": {
    "xml": {
      "command": "npx",
      "args": ["-y", "@sezzlee/xml-mcp", "/Users/you/sezzlee-xml"]
    }
  }
}
```

```json title="VS Code"
{
  "servers": {
    "xml": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sezzlee/xml-mcp", "/Users/you/sezzlee-xml"]
    }
  }
}
```

:::

Claude Desktop reads `claude_desktop_config.json` (**Settings → Developer → Edit Config**, then
restart). Cursor reads `.cursor/mcp.json` in the project or `~/.cursor/mcp.json`. VS Code reads
`.vscode/mcp.json`. Any other client that starts a stdio server works with the command `npx` and the
arguments `-y`, `@sezzlee/xml-mcp` and the folder.

:::details[If the server does not start]

Run the same command in a terminal. A wrong or relative folder exits at once with
`The XML source root '…' does not exist.` File access goes through a native module built for Node.js
22 and 24 on macOS (x64 and arm64), Linux with glibc (x64 and arm64) and Windows x64; anywhere else,
including Alpine, it fails with `unsupported_platform`. On Windows, escape the backslashes in JSON:
`"C:\\Users\\you\\sezzlee-xml"`. A listed `.config` or `.props` file is only a candidate: it may
still turn out not to be XML.

:::

## 3. Ask

Ask the agent: **How much was paid per order status in orders.xml?**

The agent looks at the document first, then has the server group the orders by `status` and add up
the payments. It gets three lines back instead of six records, and the answer is 2,570 for shipped
orders. On a document with fifty thousand records the answer is the same size.

## See what the agent receives

The recipes call the tools the way an agent does, through the MCP Inspector, so you can see each
answer exactly. They need the server installed once and [jq](https://jqlang.org):

```sh
npm install -g @sezzlee/xml-mcp
```

Define this helper in your shell; it reads `~/sezzlee-xml`:

```sh
xml() {
  npx -y @modelcontextprotocol/inspector --cli sezzlee-xml ~/sezzlee-xml \
    --method tools/call --tool-name "$@" | jq '.content[0].text | fromjson'
}
```

Name the repeated element once: every `order` child of `orders` is one record.

```sh
ORDERS='{"ancestors":[{"namespaceUri":"urn:example:orders","localName":"orders"}],"name":{"namespaceUri":"urn:example:orders","localName":"order"}}'
```

This is the call behind the answer above. Adding up turns text into numbers, which the server does
only when `numericMode` says so:

```sh
xml aggregate_document --tool-arg filePath=orders.xml "itemAddress=$ORDERS" \
  'columns=[{"label":"status","value":{"from":"attribute","namespaceUri":"","localName":"status"}},{"label":"paid","name":{"namespaceUri":"urn:example:payments","localName":"payment"}}]' \
  'groupBy=["status"]' 'metrics=[{"fn":"count"},{"fn":"sum","column":"paid"}]' \
  numericMode=binary64 \
  | jq -c '.groups[] | {status: .key[0].value, orders: .metrics[0].value, paid: .metrics[1].value, counted: .metrics[1].counted}'
```

```json
{"status":"cancelled","orders":1,"paid":0,"counted":0}
{"status":"pending","orders":1,"paid":610,"counted":1}
{"status":"shipped","orders":4,"paid":2570,"counted":4}
```

The cancelled order has no payment, so its total is `0` with `counted: 0`. That is different from a
payment of zero.

## What it can read

- **Structure first**: the document element, every namespace with a stable alias, and which elements
  repeat and how often.
- **Records as rows**: a repeated element becomes a table with named columns, and every cell says
  whether its value was present, empty, missing or found more than once.
- **Answers instead of pages**: counts, distinct values, sums and averages per group.
- **XPath 1.0**, evaluated exactly as written, and **literal search** over text and attribute
  values.
- **Any part of the tree** in document order, as flat records that page without gaps.

It reads `.xml`, `.xsd`, `.xhtml`, `.svg`, `.csproj`, `.props`, `.targets`, `.config` and `.resx`
files. Values come back as the exact text in the file. A document over 8 MB is read one record at a
time, and a DOCTYPE is refused before anything is parsed.

:::details[Why it cannot read outside the folder]

The server opens the folder once at startup and resolves every path against that handle in a native
module, not by comparing strings. A `..` that climbs out, an absolute path, or a symbolic link that
leads outside is refused with `path_outside_root`. That check runs before the existence check, so
error codes cannot be used to map your disk, and the folder's absolute path is removed from every
error.

The XML parser runs as WebAssembly in a worker thread, with a two-second deadline per parse. A
document cannot pull in other resources, because the server never asks the parser to resolve
anything. A file is read as one snapshot: if it changes during a read, the call fails with
`file_changed`.

Two things are outside what it can defend: a hard link inside the folder is the same file as its
other name, and someone who can mount a filesystem over the folder can change what it holds.

:::

:::details[Why a DOCTYPE is refused]

A DOCTYPE can define entities, and entities are where XML's best-known attacks live. An external
entity points at a file or a URL that the parser inlines, which would turn a read-only tool into a way
to read outside the folder. Nested entities grow a few hundred bytes into gigabytes.

The parser's own switches were measured to be incomplete: the option that blocks external entities
does not stop an internal entity from expanding. So the server scans the prolog before parsing and
refuses with `doctype_not_allowed`. The same scan refuses the UCS-4 and EBCDIC encoding families.

The cost: a document that really uses a DTD cannot be read. Remove the DOCTYPE from a copy, or expand
its entities with a trusted tool first.

:::
