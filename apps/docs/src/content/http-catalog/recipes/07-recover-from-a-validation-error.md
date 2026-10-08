# Recover from a validation error

This page is for whoever writes the agent side. `invoke_tool` came back as an error, and you want the agent to fix its arguments and retry instead of giving up.

## Read the envelope

Every meta-tool result is JSON serialized into one text content block:

```ts
const result = await client.callTool({
  name: "invoke_tool",
  arguments: { name, arguments: args },
});
const payload = JSON.parse(result.content[0].text);
```

`result.isError` says something went wrong. `payload.error` says what.

## Repair from `fields`

A `validation_failed` payload carries the per-field reasons:

```json
{
  "error": "validation_failed",
  "message": "The backend rejected one or more arguments. Fix the listed fields and call the operation again.",
  "status": 400,
  "retryable": false,
  "fields": [
    { "name": "item", "message": "The Item field is required." },
    {
      "name": "item",
      "message": "The field Item must be a string or array type with a minimum length of '1'."
    },
    {
      "name": "quantity",
      "message": "The field Quantity must be between 1 and 100."
    }
  ]
}
```

A field can appear more than once, once per failed rule. `item` above failed both presence and minimum length, so fix all of its messages, not the first. Repair from `fields` rather than `message`: the message is prose for a human, and the field list is the part that names what to change.

`retryable: false` refers to replaying the same request, which fails identically. It does not mean the operation is unusable. A repaired call is a new request:

```json
{
  "status": 200,
  "body": { "id": 3, "item": "sample", "quantity": 1, "owner": "alice" }
}
```

## Tell an SDK rejection from a backend one

Some errors never reach your backend. sezzlee validates the arguments against the tool's schema first and rejects locally. Those envelopes have no `status` field, and that absence is the discriminator:

```json
{ "error": "unknown_argument", "message": "...", "retryable": false }
```

An error with a `status` came from your backend and was mapped. An error without one came from sezzlee. For the argument codes the names or types do not match the schema you loaded, so re-read it with `load_tool` instead of retrying.

The codes that arrive without a `status` are `unknown_argument`, `invalid_path_type`, `missing_path_parameter`, `header_injection`, `null_not_allowed`, `invalid_type`, `deferred_value_missing`, `deferred_value_invalid`, `unknown_tool`, `not_invocable`, `response_too_large`, `invoke_timeout` and `internal_error`. The last three are invoke guards, not argument problems. Only `invoke_timeout` is retryable. See [Keep a response from flooding the agent](/docs/http-catalog/keep-a-response-from-flooding-the-agent) and the [invoke result envelope](/docs/http-catalog/invoke-result-envelope).

## Do not retry every error

Branch on `retryable`, which sezzlee sets from the mapped status. Only `408`, `429`, `502`, `503` and `504` are retryable, and a `429` may carry `retryAfterSeconds`. Everything else needs a different call or a different caller. A `forbidden` does not become allowed by repeating it, and neither does an `unauthenticated`.

## Verify the loop

The example client ships this loop as a scenario. It generates invalid arguments from the loaded schema, asserts the envelope, repairs using only `fields` and calls again:

```sh
node sdks/nestjs/samples/agent-client/dist/main.js --scenario validation-retry
```

It exits `0` when the repaired call returns a `2xx` and `1` if any assertion fails. That includes its check that no error message leaked a stack frame, a file path or a connection string.
