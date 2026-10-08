# Let an agent read your PDFs

`@sezzlee/pdf-mcp` gives an agent read-only access to the PDF files in one folder, and to nothing
outside it. It has no tool that writes, so a document is never modified, and it never opens a network
connection.

You need Node.js 22 or later on macOS with Apple silicon, Linux with glibc or Windows x64.

## 1. Pick a folder

Everything under the folder is readable, subfolders included, so pick the narrowest one that holds
the documents the agent needs. To follow along, create one and save
[annual-report.pdf](/samples/pdf-mcp/annual-report.pdf) into it: four pages of text, one of them a
table.

```sh
mkdir -p ~/sezzlee-pdf
```

## 2. Add the server to your client

Pass the folder as an **absolute** path. A JSON configuration is not read by a shell, so `~` is not
expanded there.

:::tabs

```sh title="Claude Code"
claude mcp add pdf -- npx -y @sezzlee/pdf-mcp /Users/you/sezzlee-pdf
```

```json title="Claude Desktop"
{
  "mcpServers": {
    "pdf": {
      "command": "npx",
      "args": ["-y", "@sezzlee/pdf-mcp", "/Users/you/sezzlee-pdf"]
    }
  }
}
```

```json title="Cursor"
{
  "mcpServers": {
    "pdf": {
      "command": "npx",
      "args": ["-y", "@sezzlee/pdf-mcp", "/Users/you/sezzlee-pdf"]
    }
  }
}
```

```json title="VS Code"
{
  "servers": {
    "pdf": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sezzlee/pdf-mcp", "/Users/you/sezzlee-pdf"]
    }
  }
}
```

:::

Claude Desktop reads `claude_desktop_config.json` (**Settings → Developer → Edit Config**, then
restart). Cursor reads `.cursor/mcp.json` in the project or `~/.cursor/mcp.json`. VS Code reads
`.vscode/mcp.json`. Any other client that starts a stdio server works with the command `npx` and the
arguments `-y`, `@sezzlee/pdf-mcp` and the folder.

:::details[If the server does not start]

Run the same command in a terminal. A relative path or a `~` in JSON exits at once with
`The PDF source root '…' does not exist.` On an Intel Mac the PDF engine cannot load: the server
prints that it could not load it on `darwin-x64` and exits with code 3. On Alpine and other
musl-based Linux, every read fails with `unsupported_platform`, because file access goes through a
native module that has no build there. On Windows, escape the backslashes in JSON:
`"C:\\Users\\you\\sezzlee-pdf"`.

:::

## 3. Ask

Ask the agent: **Which region had the most revenue in annual-report.pdf?**

Expect three calls: `list_documents` to find the file, `describe_document` to learn that page 2
holds a table, and `read_pages` for that one page. The table comes back as Markdown, so the agent
reads the numbers by column. The answer is North, at EUR 1,240,000.

## See what the agent receives

The recipes call the tools the way an agent does, through the MCP Inspector, so you can see each
answer exactly. They need the server installed once and [jq](https://jqlang.org):

```sh
npm install -g @sezzlee/pdf-mcp
```

Define this helper in your shell; it reads `~/sezzlee-pdf`:

```sh
pdf() {
  npx -y @modelcontextprotocol/inspector --cli sezzlee-pdf ~/sezzlee-pdf \
    --method tools/call --tool-name "$@" | jq '.content[0].text | fromjson'
}
```

This is the call behind the answer above. Page numbers start at 1:

```sh
pdf read_pages --tool-arg filePath=annual-report.pdf 'pages=[2]' \
  | jq -r '.pages[0].markdown'
```

```text
# 2. Revenue by region

Revenue is reported in euros, net of returns.

|Region|Revenue|Orders|Growth|
|---|---|---|---|
|North|1,240,000|3,410|+8.2%|
|South|980,500|2,875|+3.1%|
|East|1,105,250|3,020|+11.4%|
|West|612,800|1,940|-2.6%|
|Total|3,938,550|11,245|+5.9%|

West is the only region that shrank; see section 3 for the late delivery issue.

```

## What it can read

- **Pages as Markdown**, numbered from 1, with headings and tables kept as Markdown structure.
- **A summary first**: page count, whether the document is text or scanned, and exactly which pages
  have no readable text.
- **Literal search** over the text, with the page, the line and the surrounding text of each match.
- **Scanned pages**, when you start the server with an OCR binding. OCR is off unless a call asks
  for it.

A page with no readable text is never shown as an empty page: it is marked `needsOcr`. See
[Read scanned pages with OCR](/docs/pdf-mcp/read-scanned-pages-with-ocr).

:::details[Why it cannot read outside the folder]

The server opens the folder once at startup and resolves every path against that handle in a native
module, not by comparing strings. A `..` that climbs out, an absolute path, or a symbolic link that
leads outside is refused with `path_outside_root`. That check runs before the existence check, so
error codes cannot be used to map your disk, and the folder's absolute path is removed from every
error.

The server has no network code, so the links and references inside a PDF are never followed. A
document is read as one snapshot of its bytes; a file that changes mid-read fails with
`file_changed`. A file over 32 MiB, a document over 2,000 pages and an extraction that runs past 20
seconds are refused, and a password-protected document fails with `encrypted_pdf`. These are budgets
that keep one file from exhausting the server, not a sandbox around the PDF engine.

Two things are outside what it can defend: a hard link inside the folder is the same file as its
other name, and someone who can mount a filesystem over the folder can change what it holds.

:::
