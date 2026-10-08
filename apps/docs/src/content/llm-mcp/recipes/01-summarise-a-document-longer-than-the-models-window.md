# Summarise a document longer than the model's window

`summarize` and `extract` read an input longer than the model's context window by splitting it and
merging what each part yields. The other kinds refuse it rather than send the model half.

Uses the `llm` helper from the [Quickstart](/docs/llm-mcp/quickstart#see-what-the-agent-receives)
and [operations-2026.txt](/samples/llm-mcp/operations-2026.txt), twelve monthly meeting notes of
about 15,600 characters. The outputs were produced with `qwen3.8:latest`, so yours will read
differently.

## See the budget

```sh
llm local_status | jq -c '{contextTokens, inputBudgetTokens}'
```

```json
{"contextTokens":16384,"inputBudgetTokens":7372}
```

The server estimates an input at 1.8 characters per token, so 7,372 tokens is about 13,300
characters. The year's notes are longer than that.

## Summarise it

```sh
llm local_task --tool-arg kind=summarize \
  instruction="Summarise the year for the board: what changed, with figures." \
  'files=["operations-2026.txt"]' | jq -r '"chunks: \(.chunks), reduceRounds: \(.reduceRounds)\n\n\(.answer)"'
```

```text
chunks: 2, reduceRounds: 1

**2026 Revenue Hits EUR 4.17M with Late Deliveries Dropping from 14% to 2% Following Carrier Switch and Pricing Adjustments**

*   **Revenue Growth:** Total annual revenue reached approximately EUR 4,166,000, driven by a monthly trend rising from EUR 310k in January to a peak of EUR 402k in December, with Black Friday week generating a record EUR 118,000.
*   **Logistics Improvement:** Late delivery rates improved from 14% in January to 2% in December, primarily due to the NorthSea Freight carrier trial (started April, extended to all regions) and the completion of the Rotterdam warehouse relocation in March.
*   **Pricing Strategy:** Desk prices were reduced by 8% in September after a review found them 12% above market average, resulting in a 19% increase in desk order volume in the first two weeks.
*   **Support Efficiency:** Migration to a new ticketing tool in August reduced average first response time from 9 hours to 3 hours, while common issues remained focused on delivery queries and invoice corrections.
*   **Operational Stability:** Stock levels for all key products (desks, chairs, lamps, shelves) remained above safety thresholds throughout the year, and no supplier changes were made despite monthly scorecard reviews.
*   **Year-End Actions:** Two temporary staff were hired for Black Friday, the old carrier contract ended on December 31, and the 2027 plan is due by January 20.
```

The server split the file at paragraph boundaries, asked the model for notes on each part, then gave
the model all the notes with your instruction one last time. `chunks` is how many parts were read.
`reduceRounds` is how many times notes were merged: one when they fit together, up to three when the
merged notes were themselves too long. Every part was read, so a fact in December is as likely to
reach the summary as one in January. `extract` works the same way: each chunk yields the fields it
holds, and the merge combines them.

A split input may be up to 1 MiB and 32 chunks. Beyond that, or when three merge rounds still do not
fit, the call fails with `input_too_large`. Each chunk is one model call, so a large file takes
minutes.

## The other kinds refuse

`classify`, `transform` and `free` need the whole input at once, so they do not split it:

```sh
llm local_task --tool-arg kind=free instruction="Which month had the highest revenue?" \
  'files=["operations-2026.txt"]'
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'local_task' returned isError:true."}}
{
  "error": "input_too_large",
  "message": "The input is about 8759 tokens; one local call takes at most 7372.",
  "recovery": "summarize and extract split long input themselves; for other kinds split the input and call once per part, or do the work yourself."
}
```

The first line comes from the Inspector; the object under it is the server's answer. Nothing was
sent to the model: the server counted first. For a question like this one, ask `extract` for the
monthly figures and compare them yourself, or run a script.

:::details[Why the server counts tokens first]

Ollama does not refuse a prompt that is too long. It keeps the end and drops the beginning, with no
error and no warning. Measured: 84,608 characters sent into a 16k window came back as 8,194
processed tokens, with the start gone. The model then answers fluently from what is left, and a
summary of the second half of a report reads like a summary of the report.

So the server estimates every input first and treats 45% of the window as the budget. The rest is
room for its instructions and for the answer, which is capped at 40% of the window so that a model
caught in a loop stops inside it. The estimate errs high on English, which runs near four characters
per token: a refused input costs one call, a cut input costs a wrong answer nobody notices. A file
whose size alone proves it cannot fit is refused before it is read. Over the budget, the server
splits or refuses, and never sends the input to be cut.

:::
