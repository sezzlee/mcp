# @sezzlee/excel-mcp

A standalone MCP server that **reads** local Excel files for an agent. There is no write path.

Reads `.xlsx`, `.xlsm` and `.csv`, sandboxed to one folder. Sandboxing, the document cache, the error envelope, the cursor codec and the tool registration layer come from [@sezzlee/file-core](../../cores/file-core).

**Documentation: <https://docs.sezzlee.app/docs/excel-mcp/introduction>** — a tutorial, task guides, and the tool, error-code and limit reference generated from this package.

## Quick start

The server takes the folder it is allowed to read as its only argument, as an absolute path. Nothing outside that folder can be read.

```json
{
  "mcpServers": {
    "excel": {
      "command": "npx",
      "args": ["-y", "@sezzlee/excel-mcp", "/Users/me/sheets"]
    }
  }
}
```

With Claude Code:

```bash
claude mcp add excel -- npx -y @sezzlee/excel-mcp /Users/me/sheets
```

Requires Node.js 22 or 24 on macOS (x64, arm64), glibc Linux (x64, arm64) or Windows x64; file access goes through a native module with no JavaScript fallback.

## Tools

| Tool                      | What it does                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `list_workbooks`          | Lists readable files under the root; the `filePath` it returns is passed to other tools verbatim |
| `describe_workbook`       | Sheets, used ranges, counts of merges, validations, tables and formulas, defined names           |
| `read_sheet`              | A cell range as a compact grid: hoisted column headers plus row arrays                           |
| `aggregate_sheet`         | Server-side count/sum/average/min/max and grouping, instead of paging a large sheet              |
| `find_in_sheet`           | Cells whose value or formula matches a query                                                     |
| `get_tables`              | Excel Tables: range, header and totals rows, column names and letters                            |
| `get_data_validations`    | Validation rules, regrouped into rectangular ranges                                              |
| `get_conditional_formats` | Conditional formatting rules as predicates                                                       |
| `get_merged_ranges`       | Merged cell ranges                                                                               |
| `get_images`              | Embedded pictures: anchor, size, extension. Charts, pivot tables and sparklines are refused      |

Every argument, error code and limit is listed in the [reference](https://docs.sezzlee.app/docs/excel-mcp/tools).

## How the metadata is read

Every tool reads the OOXML parts directly through `@sezzlee/ooxml-core`: cells, number formats, formulas, hyperlinks, merges and defined names as much as data validation, Excel Tables, conditional formatting, images and frozen panes. No spreadsheet library is present at runtime. SheetJS and exceljs are dev dependencies: exceljs writes the test fixtures, and SheetJS is the reference the cell reader is compared against.

The OOXML parts are read namespace-aware with `saxes`. Matching is done on `(namespace uri, local name)` — the prefix the file happens to write is never consulted — so `<x:dataValidation>` and `<dataValidation>` are indistinguishable at the call site. These tools therefore work with any OPC layout, including prefixed .NET output and a worksheet part named `sheet.xml`.

| tool                      | source                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_data_validations`    | worksheet part, `dataValidations/dataValidation`. Ranges are taken verbatim from `sqref`, not opened cell by cell — a rule covering an entire column still counts as exact, so `dataValidationRuleCountExact` is always `true`                                     |
| `get_tables`              | worksheet `tableParts` → sheet rels → `xl/tables/*.xml`. `filterButton` is matched by `colId`, not by position                                                                                                                                                     |
| `get_conditional_formats` | worksheet `conditionalFormatting/cfRule`. The `containsText` family is parsed into type + operator. A `cfvo type="formula"` threshold's expression is preserved in the `formula` field                                                                             |
| `get_images`              | worksheet `drawing` → sheet rels → `xl/drawings/*.xml` → `a:blip r:embed` → drawing rels → `xl/media/*`. `twoCell`, `oneCell` and `absolute` anchors are all reported; an absolute anchor has no cell range, and the `range` field is omitted rather than invented |

Charts, pivot tables and sparklines are the reader's ceiling in every format, not a CSV limitation: `xl/charts/*.xml` is never opened, there is no object model for pivots, and sparklines in the worksheet `extLst` are not parsed. The `capabilities` block reports all three as `false`, and `get_images` returns `unsupported_object_kind` when they are requested.

A corrupt-file claim is split into three codes, and none substitutes for another: `not_a_workbook` (no zip header, or a zip with no workbook part), `encrypted_workbook` (an OLE2/CFB header — password-protected or legacy binary) and `corrupt_workbook` (the workbook part exists but does not parse). `internal_error` carries no `recovery`: there is no known next call, and pretending there is one sends the agent off to repair a file that is fine.

## Development

```bash
pnpm turbo run build --filter=@sezzlee/excel-mcp
pnpm turbo run test --filter=@sezzlee/excel-mcp
pnpm turbo run check-types --filter=@sezzlee/excel-mcp
```

Run tests through Turbo, not `pnpm --filter @sezzlee/excel-mcp test`: the bare filter skips `dependsOn: ["^build"]`, and this package resolves `@sezzlee/file-core` through `exports.default → ./dist/index.js`, so a bare filter can test against a stale `dist`.

A change to a tool's arguments, an error code or a limit changes the generated reference in `apps/docs`; run `pnpm --filter @sezzlee/docs gen` and commit the result, or `pnpm turbo run validate --filter=@sezzlee/docs` fails.
