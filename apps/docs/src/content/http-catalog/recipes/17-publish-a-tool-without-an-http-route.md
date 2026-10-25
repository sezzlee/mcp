# Publish a tool without an HTTP route

Register a Nest provider as an MCP tool without creating a controller endpoint. The tool appears
in the same search and detail catalog as your HTTP operations and runs through its own access
policy and runtime validators.

## Define the provider tool

The demo API's `note-summary.ts` contains this complete example:

```ts
import { Injectable } from "@nestjs/common";
import { defineProviderTool } from "@sezzlee/sdk-nestjs";
import { z } from "zod";

@Injectable()
export class NoteSummaryService {
  summarize(text: string) {
    return { characters: text.length, words: text.trim().split(/\s+/u).length };
  }
}

export const noteSummaryTool = defineProviderTool({
  name: "summarize_note",
  description: "Count the characters and words in a note.",
  provider: NoteSummaryService,
  input: z.strictObject({ text: z.string().trim().min(1).max(10000) }),
  output: z.strictObject({ characters: z.number().int(), words: z.number().int() }),
  annotations: { readOnlyHint: true },
  tags: ["notes"],
  access: "public",
  execute: (service, input) => service.summarize(input.text),
});
```

The explicit `public` policy permits any caller admitted by your MCP transport. It does not remove
transport authentication. For a private tool, supply an `access` callback that checks
`context.caller` against your application's current permissions. It runs again on invocation and
when reading a stored result, so a discovery result cannot preserve revoked access.

## Register it with the application

Add `NoteSummaryService` to your application's `providers`, and push `noteSummaryTool` into
`options.tools` in `SezzleeModule.forRoot`. Both changes are present in the demo API's
`app.module.ts`. No controller or HTTP route decorator is needed. Keep the provider and its
dependencies independent of HTTP request scope.

Use `search_tools` to find `summarize_note`, then `load_tool` and `invoke_tool`. Arguments
`{ "text": "hello world" }` return `{ "body": { "characters": 11, "words": 2 } }`.
A direct HTTP request to `/summarize_note` returns 404 in the demo. The
`agent-client --scenario provider` scenario checks both the MCP result and that HTTP response.

:::details[Execution and compatibility]

The provider path does not execute HTTP middleware, guards, pipes or interceptors. Put required
access rules in its policy and keep domain checks in the service. Runtime validators check inputs
and declared outputs; the shared response budgets, result storage and rate limits still apply.
Deadlines pass an abort signal to the handler, but cannot undo side effects or interrupt synchronous
JavaScript. Unexpected errors are redacted; use `ProviderToolError` only for an intentional public
business message.

HTTP operations retain their existing envelopes and OpenAPI export. Provider results have no
HTTP status. Provider tools are omitted from OpenAPI with a diagnostic. Custom rankers receive
provider documents without a route; custom limiter partitions can use `providerTarget`.
The normative contract is
[`provider-tools.md`](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/provider-tools.md).

:::
