# Rich-value regression fixture provenance

These three small, fixed CI workbooks are licensed test fixtures, distinct from the optional
external corpus. The `.base64` files decode directly to ZIP/XLSX bytes. No private corpus,
downloaded image, or workbook of unknown licensing is included. The fixtures are exercised
through the public MCP interface; Python's independent ZIP/XML oracle verifies their saved
meaning without importing the MCP implementation.

| Base64 fixture               | Decoded bytes | SHA-256 of decoded workbook                                        |
| ---------------------------- | ------------: | ------------------------------------------------------------------ |
| `rich-values.xlsx.base64`    |         11600 | `b29d5664bfebd138af4f55135b4470e682065cb0a2fcbfce5a680e5f5c6ff9e3` |
| `linked-seattle.xlsx.base64` |          8544 | `537a61c16e9c09a33d405e5f828d0e17b9462a69396e42203cc77706e63c6a12` |
| `rich-errors.xlsx.base64`    |         11688 | `9ee3db1974c3bebed188a0e098815806bae179a6b6dca0c453ea01c80b7cdaa1` |

## Original XlsxWriter workbook

`rich-values` is original project test data, released under this repository's MIT license.
XlsxWriter 3.2.9 wrote its two original 2-by-2 PNGs, multilingual image alt text, dynamic-array
formula and explicit caches, elapsed-time formats, three ordinary errors, booleans, percentage,
identifier strings, a table with a totals row, saved filtered rows and a hidden sheet.

The PNGs contain literal RGB pixels generated with Python/zlib. No external media was copied.
Formula results are supplied caches, not independently recalculated Excel results. XlsxWriter's
[formula documentation](https://xlsxwriter.readthedocs.io/working_with_formulas.html#formula-results)
explains this producer limitation. Its [image documentation](https://xlsxwriter.readthedocs.io/worksheet.html#worksheet-embed-image)
and [autofilter documentation](https://xlsxwriter.readthedocs.io/working_with_autofilters.html)
describe the corresponding writer features.

## Microsoft Open XML SDK workbook

`linked-seattle` was produced from Microsoft's MIT-licensed
[RichData example](https://github.com/dotnet/Open-XML-SDK/blob/431ab05cf160248cc3885a4a766026d4f8243792/samples/RichData/Program.cs)
at commit `431ab05cf160248cc3885a4a766026d4f8243792`. The source bytes used for this exact
fixture match Git blob `c695df765d77262cf5fcd88cf1f25b3775f89718` (48,378 bytes; SHA-256
`ca25f8d9f75b54bd1e4e03d1061a26d789b4bc9316bc53c3cf9e492f707a2e38`).
The companion `samples/common/ExampleUtilities.cs` matches blob
`c10b2d632f0a31fcca2ec099992047072386316d`.

An original harness created one empty sheet named `Linked`, called the unchanged
`RichData.Program.InsertRichData` method, then invoked
`OpenXmlValidator(FileFormatVersions.Microsoft365)`. The environment was .NET SDK 10.0.402,
DocumentFormat.OpenXml 3.5.1, DocumentFormat.OpenXml.Framework 3.5.1 and
System.IO.Packaging 10.0.2. Schema validation returned zero errors. The separate Python
oracle also passed the exact A1/metadata/structure/key chain.

`Linked!A1` is the `_linkedentity2` record with cached display `Seattle`, service ID
`536870912`, entity ID `5fbba6b8-85e1-4d41-9444-d9055436e473`, culture `en-US` and icon `Map`.
Its cell cache is `#VALUE!`; the metadata relationship resolves to `xl/metadata1.xml`.
The sample also contains supporting/nested records. Their historic geographic description
and population are upstream example data, not current facts. Two Bing hyperlinks are stored
as external references; they were not fetched, and no external image data is embedded.
The workbook was not opened or recalculated in Excel and does not prove live provider refresh.

The [upstream license](https://github.com/dotnet/Open-XML-SDK/blob/431ab05cf160248cc3885a4a766026d4f8243792/LICENSE)
and the example's Microsoft notice apply to this derived fixture. Both notices are retained below.

## Original rich-error mutation

`rich-errors` is an original project mutation of `rich-values`, under this repository's MIT
license. It adds `Rich!E5` and `Rich!E6` with verified `XLRICHVALUE` metadata and `_error`
structures defined by Microsoft's format specification:

- [Spill error](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-xlsx/7a27b5fb-48a8-4a1c-b67a-2ca5edc07514): `errorType:i=8`, `colOffset:i=0`, `rwOffset:i=2`, expected `#SPILL!`.
- [Calc error](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-xlsx/a4cdc4c3-45b4-45c4-be49-d244f598a538): `errorType:i=13`, expected `#CALC!`.

Both cells intentionally use `#VALUE!` as a compatibility cache. F5/F6 separately contain
direct `t=e` caches `#SPILL!` and `#CALC!`, without metadata. These separate cases prevent a
literal-only test from being mistaken for coverage of modern rich errors. The mutation
passes Microsoft365 schema validation with zero errors and the fixed Python chain oracle.
It is specification-derived test data, not an Excel-recalculated formula result.

## Independent verification

From the repository root:

```bash
python3 packages/lab/excel-lab/scripts/verify-rich-fixtures.py
```

The verifier uses only Python's standard library, checks decoded SHA-256/size first, resolves
metadata relationships and indices, and compares values with literal expected answers.
It does not execute workbook formulas or external links. It writes its JSON report to stdout;
normal MCP CI requires neither Python nor .NET. The full expected matrix and research limits
are in [RICH_VALUE_SOURCES.md](../../../../lab/excel-lab/RICH_VALUE_SOURCES.md).

## Retained upstream MIT notices

Copyright (c) Microsoft. All rights reserved.
Licensed under the MIT license.

The MIT License (MIT)

Copyright (c) .NET Foundation and Contributors

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
