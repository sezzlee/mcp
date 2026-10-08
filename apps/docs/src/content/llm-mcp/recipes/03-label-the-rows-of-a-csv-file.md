# Label the rows of a CSV file

`local_map` gives every row of a CSV file one label from a list you choose, and writes a labelled
copy. The agent sees the counts and a few sample rows, never the file.

Uses the `llm` helper from the [Quickstart](/docs/llm-mcp/quickstart#see-what-the-agent-receives)
and [tickets.csv](/samples/llm-mcp/tickets.csv), twelve support tickets. The outputs were produced
with `qwen3.8:latest`, so yours will read differently.

## Label the file

Give two to 50 labels, and an instruction that says how to choose, naming the cues:

```sh
llm local_map --tool-arg file=tickets.csv \
  instruction="Label each ticket by what the customer needs: billing for charges, refunds, invoices and discounts; delivery for late, lost, damaged or wrong parcels; bug for the app or website not working; other for anything else." \
  'labels=["billing","delivery","bug","other"]' \
  | jq '{rows, counts, unlabeled, sample: .sample.other}'
```

```json
{
  "rows": 12,
  "counts": {
    "billing": 4,
    "delivery": 4,
    "bug": 3,
    "other": 1
  },
  "unlabeled": 0,
  "sample": [
    "10,Thank you,\"Just wanted to say the chair is great, thanks for the quick help last week.\""
  ]
}
```

All twelve rows were labelled. Rows are sent in batches, each with its number, and the model answers
with the number of each row it labels. A row missing from the answer is asked for once more, counted
in `retriedRows`. A row still missing stays empty and is counted in `unlabeled`, never given a
guessed label. `labelColumn` names the new column; it defaults to `label`, and a name the file
already has is refused.

## Check the samples

The answer returns up to four sample rows for each label, here the one `other`, and a `verify` note.
Read the samples before using the output. If one is wrong, sharpen the instruction and run again.

## Read the output

The answer's `output` is the labelled copy's path inside the workspace. The server names it from the
input's name, the column and a time stamp, and it always ends in `.csv`:

```sh
head -4 ~/sezzlee-llm/.llm-mcp/out/tickets-label-*.csv
```

```text
id,subject,message,label
1,Charged twice,"I was billed two times for order 1004, please refund one of them.",billing
2,Where is my desk?,"Ordered an oak desk ten days ago and the tracking page has not moved since Monday.",delivery
3,Login loop,"After the update the app sends me back to the login screen every time I sign in.",bug
```

The original columns are untouched and a column is added. The input file is never changed, an
existing file is never overwritten, and each run writes a new file.

## Limits

One call reads a file of up to 8 MiB and 2,000 data rows, which the model was measured labelling in
about nine minutes. Split a larger file and label each part. The first line must be the header;
commas, semicolons and tabs are recognised as the delimiter, and quoted fields may contain newlines.

If a keyword or a column value decides the label, a script is faster and exact. On a 400-row task
with clear cues, an agent working alone was as accurate as delegating and about three times faster.
`local_map` pays off when each row has to be read and understood, such as free-text messages. See
[when delegating pays off](/docs/llm-mcp/quickstart).
