# Error codes

> Generated from the error-code union types of `@sezzlee/excel-mcp` 0.10.1.

A tool that fails answers with `isError: true` and one text item holding a JSON object with three fields: `error`, a stable machine code from this page; `message`, what went wrong; and `recovery`, what the next call should do differently. Branch on `error`, never on `message`.

This is the answer to `describe_workbook {"filePath":"q3.xlsx"}` in a folder that has no such file:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"error\":\"file_not_found\",\"message\":\"No source exists under the workbook root.\",\"recovery\":\"Call list_workbooks to see readable files.\"}"
    }
  ],
  "isError": true
}
```

The text item, parsed:

```json
{
  "error": "file_not_found",
  "message": "No source exists under the workbook root.",
  "recovery": "Call list_workbooks to see readable files."
}
```

The server has 34 codes.

## Arguments and paging

| Code                       | Meaning                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_argument`         | An argument the tool does not declare, a value of the wrong type, a missing required argument, or a combination the tool refuses, such as `headerScan` together with `headerRow`, or a `cursor` together with `sheetName` or `range`. The message names the conflict. For an undeclared or mistyped argument the recovery lists the arguments the tool accepts. |
| `invalid_range`            | `range` is not a valid A1 range. Use a form such as `B2:D40`, `B:D` or `2:40`.                                                                                                                                                                                                                                                                                  |
| `range_outside_used_range` | `range` lies outside the sheet's used range. The recovery names the used range.                                                                                                                                                                                                                                                                                 |
| `invalid_cursor`           | `cursor` is not a token that a previous `read_sheet` answer returned, for example because it was cut short or edited. Read again without a cursor.                                                                                                                                                                                                              |
| `stale_cursor`             | The file changed between two pages of the same read. Start again without a cursor.                                                                                                                                                                                                                                                                              |
| `invalid_pattern`          | `find_in_sheet` refused a `regex` query: it is longer than 256 characters, uses a Unicode property escape (`\p{…}`), or is not a valid JavaScript regular expression.                                                                                                                                                                                           |
| `resource_limit`           | The request would exceed a fixed processing, response or retained-result budget, or a regex search timed out or found the queue full. No partial aggregate is published. A full result store refuses admission until entries expire or the server restarts. See [Limits](/docs/excel-mcp/limits).                                                               |
| `result_unavailable`       | The result identifier is unknown, expired, or belongs to another server instance. Retained results are snapshots in one instance, not durable identifiers. Repeat aggregate_sheet with resultMode retained to create a new result.                                                                                                                              |

## Files and paths

| Code                    | Meaning                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path_outside_root`     | `filePath` resolves outside the folder the server was started with. Paths are relative to that folder, and `..` cannot leave it.                                                                                                                                                                                                                   |
| `file_not_found`        | No file exists at `filePath`. Call `list_workbooks` for the paths that do.                                                                                                                                                                                                                                                                         |
| `not_a_file`            | `filePath` names a directory or another entry that is not a regular file.                                                                                                                                                                                                                                                                          |
| `unsupported_extension` | The file is not `.xlsx`, `.xlsm` or `.csv`.                                                                                                                                                                                                                                                                                                        |
| `file_too_large`        | The file or its metadata exceeds a resource bound: 50 MB for a workbook; for a CSV, 16 MB, 16,384 fields in one record or 2,000,000 cells. Rich metadata also has bounded record, field and value counts. For the byte bounds the message names the file's size and the limit, and the recovery says that no tool of the server can open the file. |
| `file_changed`          | The file was modified while it was being read. Retry the call.                                                                                                                                                                                                                                                                                     |
| `unsupported_platform`  | The native package that gives the server safe file access is missing for this operating system and CPU. Reinstall on a supported platform.                                                                                                                                                                                                         |

## File content

| Code                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_a_workbook`          | The bytes are not a workbook: not a zip archive at all, or a zip with no workbook part or no worksheet inside, such as a `.docx` renamed to `.xlsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `encrypted_workbook`      | The file is password-protected or saved in the legacy binary `.xls` format. Save an unprotected `.xlsx` copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `corrupt_workbook`        | The file is a damaged workbook: a zip archive that cannot be indexed, a part that fails its CRC-32 check or whose local header disagrees with the central directory, or a part that is not well-formed XML or valid UTF-8 or that breaks a SpreadsheetML rule, including an invalid referenced rich-value index or relationship chain. A damaged sheet is refused only by the calls that read it, `describe_workbook` included. The message names the part and the fault. For a CSV: a quote inside an unquoted field, text after a closing quote, or a quote that never closes; the message names the fault and its line, and the file is never repaired. |
| `undecodable_text`        | A CSV cannot be decoded as text: it is not valid UTF-8 and has no byte-order mark, it is not valid text in the `encoding` passed, it contains NUL bytes near its start, which means a binary file or UTF-16 without a byte-order mark, or it starts with a UTF-32 byte-order mark. Pass the known source encoding from the tool’s closed encoding list.                                                                                                                                                                                                                                                                                                    |
| `ambiguous_delimiter`     | Two delimiters fit the first 20 lines of a CSV equally well. Pass `delimiter`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `numeric_overflow`        | A cell or a comparison value holds a number outside the finite range, such as `Infinity`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `unsupported_for_format`  | The file's format cannot carry what was asked for, such as `get_tables` or `headerScan` on a CSV. `describe_workbook` lists what each file supports in its `capabilities` block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `unsupported_object_kind` | `get_images` was asked for charts, pivot tables or sparklines. Charts belong to `get_charts`; pivot tables and sparklines are unread in every format, so the server refuses rather than answer with an empty list. Selecting a table with unsupported header/totals row counts also fails explicitly; inspect it with range instead.                                                                                                                                                                                                                                                                                                                       |

## Sheets, tables, columns and headers

| Code                   | Meaning                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown_sheet`        | No sheet has that name. Names are case-sensitive; the recovery lists the sheets that exist.                                                                                 |
| `ambiguous_sheet`      | Two sheets have names that are the same after Unicode normalization, so neither can be addressed. Rename one in the workbook.                                               |
| `empty_sheet`          | The sheet has no stored values, or the selected table has no data rows after excluding its header and totals.                                                               |
| `chart_sheet`          | The sheet is a chart sheet: it holds a chart, not a cell grid. Call `get_charts`.                                                                                           |
| `unknown_column`       | A column named in `groupBy`, `metrics` or `where` is neither a header in the range nor an A1 letter. The recovery lists the named columns.                                  |
| `ambiguous_column`     | A column reference matches more than one column: two columns share the header text, or the text is both a header and another column's letter. Address the column by letter. |
| `unknown_header_row`   | `headerScan` found no row that qualifies as a header. Pass `headerRow`, or `headerRow: 0` to read without headers.                                                          |
| `ambiguous_header_row` | `headerScan` found more than one row that qualifies as a header, or more than one Excel Table declares one. The recovery quotes the candidate rows; pass `headerRow`.       |
| `unknown_table`        | No declared table matches the requested name in the workbook or selected sheet. Call get_tables on the relevant worksheet.                                                  |
| `ambiguous_table`      | More than one table name matches after Unicode folding. Pass sheetName to restrict the lookup, or repair duplicate names.                                                   |

## Server

| Code             | Meaning                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `internal_error` | A defect in the server, not in your file or your call. This is the one code with no `recovery`, because there is no next call that fixes it. The detail is written to the server's stderr. |
