# Limits

> Generated from the exported `limits` object of `@sezzlee/llm-mcp` 0.1.3.

These bounds are exported by the server. Tool arguments can request smaller pages or samples within them. Truncation and continuation are tool-specific: follow a cursor only when the response supplies one. An operation that cannot stay within its resource budget can fail with `resource_limit`.

## The context window

| Limit                                                                                       | Value |
| ------------------------------------------------------------------------------------------- | ----- |
| Share of `SEZZLEE_LLM_NUM_CTX` one call's input may use; a larger input is refused or split | 0.45  |
| Share of `SEZZLEE_LLM_NUM_CTX` the answer may use                                           | 0.4   |
| Characters counted as one token when the server estimates an input's size                   | 1.8   |
| UTF-8 bytes counted per character, so a file that cannot fit is refused before it is read   | 4     |

## Long inputs

| Limit                                                                      | Value |
| -------------------------------------------------------------------------- | ----- |
| Chunks a long `summarize` or `extract` input may be split into             | 32    |
| Largest total input a `summarize` or `extract` call reads                  | 1 MB  |
| Rounds of merging chunk notes before the call fails with `input_too_large` | 3     |

## Labelling rows

| Limit                                                                    | Value |
| ------------------------------------------------------------------------ | ----- |
| Most data rows `local_map` labels in one call                            | 2,000 |
| Largest CSV file `local_map` reads                                       | 8 MB  |
| Answer tokens reserved per row when rows are batched into one model call | 17    |
| Longest sample row returned per label, in characters                     | 512   |

## Responses

| Limit                     | Value  |
| ------------------------- | ------ |
| Largest serialized answer | 512 KB |
