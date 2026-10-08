# Get a structured answer from the model

`local_task` answers in prose unless you give it a JSON Schema. With one, the answer is JSON the
agent can use without parsing sentences.

Uses the `llm` helper from the [Quickstart](/docs/llm-mcp/quickstart#see-what-the-agent-receives)
and `meeting-notes.txt`. The outputs were produced with `qwen3.8:latest`, so yours will read
differently.

## Pick the kind

`kind` chooses the instructions the server gives the model. `instruction` says precisely what to do,
and the input is `text` for a short string, `files` for up to eight paths in the workspace, or both.

| Kind        | Answers with                         | A long input is             |
| ----------- | ------------------------------------ | --------------------------- |
| `summarize` | a headline and the key facts         | split and read whole        |
| `extract`   | the requested fields, null if absent | split and read whole        |
| `classify`  | labels                               | refused (`input_too_large`) |
| `transform` | the input rewritten as instructed    | refused                     |
| `free`      | a direct answer to the instruction   | refused                     |

## Constrain the answer with a schema

With `jsonSchema`, Ollama constrains the model's output to the schema and the server parses it. The
answer arrives as `result` instead of `answer`:

```sh
llm local_task --tool-arg kind=classify \
  instruction="Is this message a complaint, a question or praise, and how urgent is it?" \
  text="Third time this month the delivery came a day after the promised date." \
  'jsonSchema={"type":"object","properties":{"type":{"enum":["complaint","question","praise"]},"urgency":{"enum":["low","medium","high"]}},"required":["type","urgency"]}' \
  | jq -c '{kind, result}'
```

```json
{"kind":"classify","result":{"type":"complaint","urgency":"high"}}
```

An `enum` keeps the answer to values the agent already handles.

## Extract fields from a file

`extract` pulls named fields out of the input:

```sh
llm local_task --tool-arg kind=extract \
  instruction="The trial budget in euros, who approved it, and every action item with its owner and due date." \
  'files=["meeting-notes.txt"]' \
  'jsonSchema={"type":"object","properties":{"budgetEur":{"type":["number","null"]},"approvedBy":{"type":["string","null"]},"actions":{"type":"array","items":{"type":"object","properties":{"owner":{"type":"string"},"action":{"type":"string"},"due":{"type":["string","null"]}},"required":["owner","action","due"]}}},"required":["budgetEur","approvedBy","actions"]}' \
  | jq '.result'
```

```json
{
  "budgetEur": 18000,
  "approvedBy": "Ada",
  "actions": [
    {
      "owner": "Emre",
      "action": "talk to a second carrier and report back",
      "due": "30 January"
    },
    {
      "owner": "Lena",
      "action": "remove fax number from returns form in next release",
      "due": null
    }
  ]
}
```

Mark every field `required`, and allow `null` for one the input may not contain, so a missing value
is `null` rather than a guess or an absent key.

## When the answer is not valid JSON

A model can fail a schema it cannot hold. The call then fails with `unparsable_output` instead of
returning a half-parsed object. Retry once with a flatter schema and fewer fields, or do the work
without the local model. Some models cannot follow a schema at all: `gpt-oss:20b` was measured
scoring 0 out of 100 on the numbered-row schema that `local_map` and structured `local_task` calls
rely on.

Besides the answer, every call returns `promptTokens` and `outputTokens`, and `chunks` and
`reduceRounds`, which exceed 1 and 0 only when a long input was split; see
[Summarise a document longer than the model's window](/docs/llm-mcp/summarise-a-document-longer-than-the-models-window).
