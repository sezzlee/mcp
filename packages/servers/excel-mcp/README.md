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

| Tool                      | What it does                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_workbooks`          | Lists readable files under the root; the `filePath` it returns is passed to other tools verbatim                                                 |
| `describe_workbook`       | Sheets and their kind (worksheet or chart sheet), used ranges, counts of merges, validations, tables, formulas, images and charts, defined names |
| `read_sheet`              | A cell range as a compact grid: hoisted column headers plus row arrays                                                                           |
| `aggregate_sheet`         | Server-side count/sum/average/min/max and grouping, instead of paging a large sheet                                                              |
| `find_in_sheet`           | Cells whose value or formula matches a query                                                                                                     |
| `get_tables`              | Excel Tables: range, header and totals rows, column names and letters                                                                            |
| `get_data_validations`    | Validation rules, regrouped into rectangular ranges                                                                                              |
| `get_conditional_formats` | Conditional formatting rules as predicates                                                                                                       |
| `get_merged_ranges`       | Merged cell ranges                                                                                                                               |
| `get_images`              | Embedded pictures: anchor, size, extension. Charts belong to `get_charts`; pivot tables and sparklines are refused                               |
| `get_charts`              | Charts: type, title, axes (incl. secondary, scale, format), series refs/points, trendlines, hidden series, pivot source. Chart sheets included   |

Every argument, error code and limit is listed in the [reference](https://docs.sezzlee.app/docs/excel-mcp/tools).

## How the metadata is read

Every tool reads the OOXML parts directly through `@sezzlee/ooxml-core`: cells, number formats, formulas, hyperlinks, merges and defined names as much as data validation, Excel Tables, conditional formatting, images and frozen panes. No spreadsheet library is present at runtime. SheetJS and exceljs are dev dependencies: exceljs writes the test fixtures, and SheetJS is the reference the cell reader is compared against.

The OOXML parts are read namespace-aware by `@sezzlee/ooxml-core`'s own XML tokenizer. Matching is done on `(namespace uri, local name)` — the prefix the file happens to write is never consulted — so `<x:dataValidation>` and `<dataValidation>` are indistinguishable at the call site. These tools therefore work with any OPC layout, including prefixed .NET output and a worksheet part named `sheet.xml`.

| tool                      | source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_data_validations`    | worksheet part, `dataValidations/dataValidation`. Ranges are taken verbatim from `sqref`, not opened cell by cell — a rule covering an entire column still counts as exact, so `dataValidationRuleCountExact` is always `true`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `get_tables`              | worksheet `tableParts` → sheet rels → `xl/tables/*.xml`. `filterButton` is matched by `colId`, not by position                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `get_conditional_formats` | worksheet `conditionalFormatting/cfRule`. The `containsText` family is parsed into type + operator. A `cfvo type="formula"` threshold's expression is preserved in the `formula` field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `get_images`              | worksheet `drawing` → sheet rels → `xl/drawings/*.xml` → `a:blip r:embed` → drawing rels → `xl/media/*`. `twoCell`, `oneCell` and `absolute` anchors are all reported. Only a two-cell anchor gets a `range`; a one-cell anchor gets its top-left `cell` and its size in whole pixels, because the cells that size covers depend on column widths, and an absolute anchor gets the size alone. `get_charts` places a chart the same way                                                                                                                                                                                                                                   |
| `get_charts`              | worksheet or chart sheet `drawing` → chart / chartEx frames → `xl/charts/*.xml` for type, title, axes (min/max/log, number format), series refs and cached points, trendlines and `pivotSource`. Every element is matched under its parent, so a data label's `c:tx` is never a series name. A number cache is returned as numbers and a text cache as text, with the cache's `numberFormat`; a multi-level category keeps its outer `levels`. An axis is `secondary` when the first plot does not use it. A series under `c15:filtered*Series` is listed as `hidden`. Markup Compatibility chooses one `AlternateContent` branch. `chartEx` is reported as `unsupported` |

`describe_workbook` marks each sheet's `kind` as `worksheet` or `chartsheet` and reports `chartCount`. A chart sheet is refused by `read_sheet`, `aggregate_sheet`, `find_in_sheet` and `get_merged_ranges` as `chart_sheet`, with recovery pointing at `get_charts`. A call without `sheetName` lands on the first visible worksheet, never on a chart sheet, except `get_charts`, which takes the first visible sheet of either kind. Pivot tables and sparklines remain unread. `get_images` with `kind: "chart"` still returns `unsupported_object_kind` and points at `get_charts`.

A corrupt-file claim is split into three codes, and none substitutes for another: `not_a_workbook` (not a zip archive, or a zip with no workbook part or no worksheet), `encrypted_workbook` (an OLE2/CFB header — password-protected or legacy binary) and `corrupt_workbook` (a damaged archive: a part that fails its CRC-32 check, a local header that disagrees with the central directory, or a part that is not well-formed XML or valid UTF-8). A damaged worksheet is refused only by the calls that read that sheet, so the workbook's other sheets stay readable. A CSV is split into records by the server's own RFC 4180 tokenizer, where CRLF, LF and CR each end a record outside quotes; malformed quoting is `corrupt_workbook` with the fault and its line, and is never repaired. `internal_error` carries no `recovery`: there is no known next call, and pretending there is one sends the agent off to repair a file that is fine.

## Development

```bash
pnpm turbo run build --filter=@sezzlee/excel-mcp
pnpm turbo run test --filter=@sezzlee/excel-mcp
pnpm turbo run check-types --filter=@sezzlee/excel-mcp
```

Run tests through Turbo, not `pnpm --filter @sezzlee/excel-mcp test`: the bare filter skips `dependsOn: ["^build"]`, and this package resolves `@sezzlee/file-core` through `exports.default → ./dist/index.js`, so a bare filter can test against a stale `dist`.

A change to a tool's arguments, an error code or a limit changes the generated reference in `apps/docs`; run `pnpm --filter @sezzlee/docs gen` and commit the result, or `pnpm turbo run validate --filter=@sezzlee/docs` fails.
