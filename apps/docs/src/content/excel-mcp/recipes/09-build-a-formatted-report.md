# Build a formatted report

Create a report with number formats, cell appearance, formulas and real Excel tables. Each successful write returns a new immutable workbook version; the source stays unchanged.

Enable writing with `--write <relative-output-directory>` after the workbook root. The output directory is inside that root. The default server remains read-only. The [generated tool contracts](/docs/excel-mcp/tools) include the writing tools and their complete registered input schemas.

These writing workflows require the current repository build. Until a package release includes them, [run the server from source](/docs/excel-mcp/run-the-server-from-source).

## Select the source and prepare the change

Use `prepare_edit` to select the exact source version and inspect blockers before `edit_workbook`. A new report starts with `create_workbook`, which can create values and apply ordered presentation changes in one publication. Continue from the returned version, or select an older retained version to create a separate branch.

Formatting changes display, not stored scalar types. A percentage format displays numeric `0.18` as a percentage; currency formatting does not turn a number into text. Write a date as a typed date. Formula-looking text remains literal text unless a formula operation is requested.

Cell styles compose number formats, fonts, solid fills, borders and alignment without changing other cells that share the original style. Row heights, column widths, hidden dimensions, frozen panes, sheet visibility and basic print settings are separate operations. Merging refuses non-anchor contents by default; discarding them requires an explicit loss policy.

## Keep formulas and tables connected

Write or fill formulas explicitly. Ordinary relative, absolute, mixed and sheet-qualified references are supported, as are table column references. A calculated table column can multiply the current row's quantity and price. The saved formula uses the table's full name and the explicit current-row selector for application compatibility.

Filling ordinary cells alone does not define calculated-column metadata on the table. Define the calculated column through the table operation. Totals labels are explicit too: requesting a sum does not invent a label.

Tables support creation, header and identity changes, growth, shrink, calculated columns, totals and filter dropdowns. Shrinking preserves excluded values unless clearing is explicitly requested. Converting a supported table to a normal range rewrites affected structured references and retains its supported appearance. New table appearance supports the bundled `SezzleeBlue` style or no style. Conversion refuses unknown affected styles and unsupported dependencies instead of guessing their appearance.

Table range resizing retains the header position and column width; structural width changes use explicit worksheet column operations first. Resizing refuses saved filter or sort criteria that need an unsupported transformation.

Newly written formulas have no cached result, and receipts disclose required recalculation. Call `calculate_workbook` with the returned version to evaluate the documented bounded subset and save typed caches in another immutable version. Inspect `calculation.complete` and unavailable-cell diagnostics; unsupported formulas are not silently treated as calculated. Formula writing and calculation remain separate operations. Dynamic spilling arrays, external workbook formula authoring and unsupported affected dependencies are refused.

The [chart and pivot report recipe](/docs/excel-mcp/build-a-chart-and-pivot-report) demonstrates named template fill, formula calculation, validation, conditional formatting, links, notes and protection. Chart and pivot refresh are separate from formula calculation.

## Finish a bulk report atomically

For a bulk job, attach ordered finishing changes to the selected output through the job's finishing contract. Data, presentation and formulas are completed before publishing the group. A failed finishing operation publishes no partial group. Independent groups report partial success explicitly and preserve already completed groups; identical retries reuse durable results.

The repository's authoring acceptance scenarios exercise formatting, formulas, table growth and conversion, merge loss and branching from a retained version. Independent ZIP/XML checks, the Open XML SDK and LibreOffice verify the resulting files; actual model trials are recorded separately from scripted execution.
