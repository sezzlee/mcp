# Error codes

> Generated from the error-code union types of `@sezzlee/xml-mcp` 0.5.1.

A tool that fails answers with `isError: true` and one text item holding a JSON object with three fields: `error`, a stable machine code from this page; `message`, what went wrong; and `recovery`, what the next call should do differently. Branch on `error`, never on `message`.

This is the answer to `describe_document {"filePath":"orders.xml"}` in a folder that has no such file:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"error\":\"file_not_found\",\"message\":\"No source exists under the XML source root.\",\"recovery\":\"Call list_documents to see readable files.\"}"
    }
  ],
  "isError": true
}
```

The text item, parsed:

```json
{
  "error": "file_not_found",
  "message": "No source exists under the XML source root.",
  "recovery": "Call list_documents to see readable files."
}
```

The server has 18 codes.

## Arguments and paging

| Code                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_argument`    | An argument the tool does not declare, a value of the wrong type, a missing required argument, or a combination the tool refuses: an address that matches no node, a prefix bound twice, two columns with the same label, a metric other than `count` with no column. The message names the problem. For an undeclared or mistyped argument the recovery lists the arguments the tool accepts. |
| `invalid_cursor`      | `cursor` is not a token this tool returned, belongs to a different tool, or is more than ten minutes old. Call the tool again without a cursor.                                                                                                                                                                                                                                                |
| `stale_cursor`        | The document changed between two pages of the same read. Start again without a cursor.                                                                                                                                                                                                                                                                                                         |
| `query_not_supported` | `select_xpath` was given something outside XPath 1.0 as this engine provides it: a function from XPath 2.0 or later, or the namespace axis, whose nodes the engine cannot report. `describe_document` lists every namespace instead.                                                                                                                                                           |
| `resource_limit`      | The request would exceed a fixed budget: parsing took longer than two seconds, too many reads are already queued, or too many `list_documents` calls are running. See [Limits](/docs/xml-mcp/limits).                                                                                                                                                                                          |

## Files and paths

| Code                    | Meaning                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `path_outside_root`     | `filePath` resolves outside the folder the server was started with. Paths are relative to that folder, and `..` cannot leave it.           |
| `file_not_found`        | No file exists at `filePath`. Call `list_documents` for the paths that do.                                                                 |
| `not_a_file`            | `filePath` names a directory or another entry that is not a regular file.                                                                  |
| `unsupported_extension` | The file's extension is not one the server reads: `.xml`, `.xsd`, `.xhtml`, `.svg`, `.csproj`, `.props`, `.targets`, `.config` or `.resx`. |
| `file_too_large`        | The file is over the 50 MB ceiling. Between 8 MB and 50 MB a document is read in chunked mode instead.                                     |
| `file_changed`          | The file was modified while it was being read. Retry the call.                                                                             |
| `unsupported_platform`  | The native package that gives the server safe file access is missing for this operating system and CPU. Reinstall on a supported platform. |

## Document content

| Code                     | Meaning                                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `malformed_xml`          | The document, or one record of a chunked document, is not well-formed XML. A file with an XML extension is a candidate, not a guarantee; `.config` files in particular are often not XML.                                        |
| `doctype_not_allowed`    | The document has a DOCTYPE declaration. The server refuses every DOCTYPE before parsing, because an internal DTD subset can expand entities that no parser flag fully blocks. Remove the declaration to read the file.           |
| `unsupported_encoding`   | The document is encoded in a UCS-4 or EBCDIC family, which the server cannot read. Re-encode it as UTF-8 or UTF-16.                                                                                                              |
| `numeric_precision`      | `aggregate_document` met a value with more digits than a binary64 number holds, so `sum`, `avg`, `min` or `max` would change it. Use a counting metric, or project the rows and total them elsewhere.                            |
| `unsupported_for_format` | The tool needs the whole document in memory and this document is read in chunked mode because it is over 8 MB. `select_xpath`, `find_in_document` and `aggregate_document` are unavailable there; `project_records` still works. |

## Server

| Code             | Meaning                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal_error` | A defect in the server, not in your document or your call. This is the one code with no `recovery`, because there is no next call that fixes it. The detail is written to the server's stderr. |
