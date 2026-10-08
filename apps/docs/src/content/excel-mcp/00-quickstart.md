# Let an agent read your spreadsheets

`@sezzlee/excel-mcp` gives an agent read-only access to the `.xlsx`, `.xlsm` and `.csv` files in one
folder, and to nothing outside it. It has no tool that writes, so a workbook is never modified.

You need Node.js 22 or later.

## 1. Pick a folder

Everything under the folder is readable, subfolders included, so pick the narrowest one that holds
the files the agent needs. To follow along, create one and save
[sales.xlsx](/samples/excel-mcp/sales.xlsx) into it: twelve orders on a sheet called `Orders`.

```sh
mkdir -p ~/sezzlee-sheets
```

## 2. Add the server to your client

Pass the folder as an **absolute** path. A JSON configuration is not read by a shell, so `~` is not
expanded there.

:::tabs

```sh title="Claude Code"
claude mcp add excel -- npx -y @sezzlee/excel-mcp /Users/you/sezzlee-sheets
```

```json title="Claude Desktop"
{
  "mcpServers": {
    "excel": {
      "command": "npx",
      "args": ["-y", "@sezzlee/excel-mcp", "/Users/you/sezzlee-sheets"]
    }
  }
}
```

```json title="Cursor"
{
  "mcpServers": {
    "excel": {
      "command": "npx",
      "args": ["-y", "@sezzlee/excel-mcp", "/Users/you/sezzlee-sheets"]
    }
  }
}
```

```json title="VS Code"
{
  "servers": {
    "excel": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sezzlee/excel-mcp", "/Users/you/sezzlee-sheets"]
    }
  }
}
```

:::

Claude Desktop reads `claude_desktop_config.json` (**Settings → Developer → Edit Config**, then
restart). Cursor reads `.cursor/mcp.json` in the project or `~/.cursor/mcp.json`. VS Code reads
`.vscode/mcp.json`. Any other client that starts a stdio server works with the command `npx` and the
arguments `-y`, `@sezzlee/excel-mcp` and the folder.

:::details[If the server does not start]

Run the same command in a terminal. A wrong folder exits at once with
`The workbook root '…' does not exist.` File access goes through a native module built for Node.js
22 and 24 on macOS (x64 and arm64), Linux with glibc (x64 and arm64) and Windows x64; anywhere else,
including Alpine, it fails with `unsupported_platform`. On Windows, escape the backslashes in JSON:
`"C:\\Users\\you\\sezzlee-sheets"`.

:::

## 3. Ask

Ask the agent: **Which region sold the most in sales.xlsx?**

Expect three calls: `list_workbooks` to find the file, `describe_workbook` to see its sheets, and
`aggregate_sheet` to add up `Total` for each `Region` on the server. The agent gets four rows back
instead of twelve, and the answer is West, at 1,865. On a sheet of fifty thousand rows the answer is
the same size.

## See what the agent receives

The recipes call the tools the way an agent does, through the MCP Inspector, so you can see each
answer exactly. They need the server installed once and [jq](https://jqlang.org):

```sh
npm install -g @sezzlee/excel-mcp
```

Define this helper in your shell; it reads `~/sezzlee-sheets`:

```sh
excel() {
  npx -y @modelcontextprotocol/inspector --cli sezzlee-excel ~/sezzlee-sheets \
    --method tools/call --tool-name "$@" | jq '.content[0].text | fromjson'
}
```

This is the call behind the answer above:

```sh
excel aggregate_sheet --tool-arg filePath=sales.xlsx \
  'groupBy=["Region"]' 'metrics=[{"fn":"sum","column":"Total"}]' \
  | jq -c '[.columns[].label], .rows[]'
```

```json
["Region","sum(Total)"]
["East",1290]
["North",1660]
["South",1810]
["West",1865]
```

## What it can read

- **Cells** as a compact grid: the header row once, then one array per row, as values, formulas or
  both.
- **Answers instead of pages**: totals, counts and groupings computed on the server, and cells
  located by value or formula.
- **Structure**: sheets, used ranges, defined names, merged cells, Excel Tables, data validation,
  conditional formatting and embedded pictures.
- **CSV files**, with the delimiter and encoding detected and every value kept as the exact text.

Charts, pivot tables and sparklines cannot be read. The server says so instead of answering with an
empty list.

:::details[Why it cannot read outside the folder]

The server opens the folder once at startup and resolves every path against that handle in a native
module, not by comparing strings. A `..` that climbs out, an absolute path, or a symbolic link that
leads outside is refused with `path_outside_root`, and that check runs before the existence check, so
error codes cannot be used to map your disk. The folder's absolute path is removed from every error.

Two things are outside what it can defend: a hard link inside the folder is the same file as its
other name, and someone who can mount a filesystem over the folder can change what it holds.

:::
