# Build a chart and pivot report

Build a report from typed sales records, with a chart, a real PivotTable and a calculated total. Fill a named template target, add interactive rules and notes, then protect the finished report.

Use the current repository build of `sezzlee-excel` on your `PATH`; [run the server from source](/docs/excel-mcp/run-the-server-from-source) until a package release includes these writing tools. Install the MCP Inspector and [jq](https://jqlang.org) as described in the [quickstart](/docs/excel-mcp/quickstart).

## Enable writing

The server remains read-only by default. This helper enables writing into `out` under `~/sezzlee-sheets`. Every successful write returns an immutable version; continue from that exact returned version.

```sh
excelwrite() {
  npx -y @modelcontextprotocol/inspector --cli sezzlee-excel ~/sezzlee-sheets --write out \
    -- --method tools/call --tool-name "$@" | jq '.content[0].text | fromjson'
}
```

```sh
mkdir -p ~/sezzlee-sheets/out
```

## Create the source and report together

`Period` names the report's template input. Its value is literal text. The total is written as an explicit formula. Chart series and the pivot use literal source cells, so their saved caches and grouped results can be created immediately.

```sh
report=$(excelwrite create_workbook \
  --tool-arg 'sheets=[
    {"name":"Data","blocks":[{"startCell":"A1","values":[
      [{"kind":"text","value":"Region"},{"kind":"text","value":"Amount"},{"kind":"text","value":"Status"}],
      [{"kind":"text","value":"North"},{"kind":"number","value":10},{"kind":"text","value":"Open"}],
      [{"kind":"text","value":"South"},{"kind":"number","value":20},{"kind":"text","value":"Closed"}],
      [{"kind":"text","value":"North"},{"kind":"number","value":5},{"kind":"text","value":"Open"}]
    ]}]},
    {"name":"Report","blocks":[]}
  ]' \
  --tool-arg 'changes=[
    {"kind":"define_name","sheetName":"Report","name":"Period","range":"B1"},
    {"kind":"write_named_range","sheetName":"Report","name":"Period","values":[[{"kind":"text","value":"2026-10"}]]},
    {"kind":"write_formula","sheetName":"Report","cell":"B3","formula":"SUM(Data!B2:B4)"},
    {"kind":"set_validation","sheetName":"Data","range":"C2:C4","rule":{"type":"list","items":["Open","Closed"]}},
    {"kind":"set_conditional_format","sheetName":"Data","range":"B2:B4","priority":1,"rule":{"type":"cellIs","operator":"greaterThan","formulas":["15"]},"appearance":{"fill":"FFCCCC"},"stopIfTrue":true},
    {"kind":"set_note","sheetName":"Report","cell":"B1","text":"Reviewed","author":"Finance"},
    {"kind":"set_hyperlink","sheetName":"Report","cell":"D1","target":{"kind":"external","url":"https://example.com/report"}},
    {"kind":"set_pivot","sheetName":"Report","name":"Regional","cell":"A5","sourceSheet":"Data","sourceRange":"A1:C4","rowColumn":"Region","measures":[{"column":"Amount","function":"sum","name":"Total"}]},
    {"kind":"set_chart","sheetName":"Report","name":"Sales","chartType":"column","cell":"E5","title":"Monthly sales","series":[{"name":"Revenue","sheetName":"Data","categories":"A2:A4","values":"B2:B4"}]}
  ]')
printf '%s\n' "$report" | jq '.editing | {formulasWritten, recalculationRequired}'
```

```json
{
  "formulasWritten": 1,
  "recalculationRequired": true
}
```

The chart contains amounts 10, 20 and 5. The PivotTable groups North to 15 and South to 20, with a grand total of 35. It includes PivotTable cache definitions and records, rather than only a static result range.

Validation provides an interactive spreadsheet rule. It does not make the server reject every later write that violates that rule. Conditional appearance is evaluated by the consuming application; LibreOffice can drop `stopIfTrue` when exporting.

## Calculate the saved formula

`calculate_workbook` evaluates the supported formula subset from the exact source version. It returns typed results and a new saved workbook. A complete result here means the formula in B3 has a current numeric cache of 35.

```sh
source=$(printf '%s\n' "$report" | jq -c '.version')
calculated=$(excelwrite calculate_workbook --tool-arg source="$source")
printf '%s\n' "$calculated" | jq '.calculation | {complete, calculatedCells, unavailableCells}'
```

```json
{
  "complete": true,
  "calculatedCells": 1,
  "unavailableCells": 0
}
```

Inspect unavailable results for unsupported formulas, cycles, dependencies or exhausted budgets. An unavailable result has no invented successful cache. A valid blank returned by `INDEX` is a blank scalar reference, which evaluates to zero in a saved scalar formula; it is distinct from an invalid reference.

## Protect the finished template

Leave B1 unlocked for future input, then protect the sheet and workbook structure. These changes retain the calculated formula cache.

```sh
source=$(printf '%s\n' "$calculated" | jq -c '.version')
protected=$(excelwrite edit_workbook --tool-arg source="$source" \
  --tool-arg 'changes=[
    {"kind":"format_cells","sheetName":"Report","range":"B1","style":{"protection":{"locked":false}}},
    {"kind":"protect_sheet","sheetName":"Report"},
    {"kind":"protect_workbook","sheetName":"Report"}
  ]')
printf '%s\n' "$protected" | jq '.editing | {operations, recalculationRequired}'
```

```json
{
  "operations": 3,
  "recalculationRequired": false
}
```

This is legacy editing protection, not encryption. For a later server edit, explicitly remove supported protection before editing and protect again afterwards. A password, when set, must be supplied correctly; unsupported hashes, encryption and signatures refuse.

## Reuse the report for another period

Start from a retained version and make replacement intent explicit. Replacing a pivot with a shorter source clears its old result tail. A new source that overlaps the prior pivot output refuses before that output is cleared; choose a separate source area.

Formula calculation, chart caches and pivot refresh are separate states. Source edits invalidate affected saved feature caches and receipts identify required refreshes. Explicitly replace a supported chart or pivot to rebuild it from literal source data. Formula-based chart sources require consumer refresh; formula-based pivot sources require calculated/materialized input in the supported profile. Unrelated formatting retains current caches.

Bulk jobs can finish an output with these same ordered changes before atomic group publication. An identical completed retry reuses its result; a late finishing failure publishes no partial group. Independent groups keep already successful outputs and expose failures for recovery.

The [generated tool contracts](/docs/excel-mcp/tools) define exact operations and bounds. Notes are legacy plain notes; images support embedded PNG/JPEG. Macros never execute, and unsupported affected dependencies refuse instead of being silently rewritten.
