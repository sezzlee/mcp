# Ship a behaviour change without breaking agents mid-deploy

During a rolling deploy an agent can load a tool from one replica and have the call answered by another. Declare a revision when an operation's behaviour changes behind an unchanged schema, and a call the agent planned against the old behaviour is refused instead of run.

## Pin calls to the version

`load_tool` returns a `version`, and `invoke_tool` takes it back. When the replica that answers holds a different definition, the call is refused with `tool_changed` before it reaches your backend, and the agent loads the tool again. See [`invoke_tool`](/docs/http-catalog/meta-tool-contract#invoke-tool).

The version already changes when anything the agent reads changes: the description, an argument, the output schema, a hint. It cannot see a change that leaves all of those alone, such as a cancel endpoint that now also refunds. That is what a revision is for.

## Declare a revision on the operation

Raise the revision on the operation whose behaviour changed:

```ts
@Get("cancel")
@McpTool({
  name: "cancel_order",
  description: "Cancels an order.",
  revision: 2,
})
cancel(): void {}
```

A call pinned to a version loaded before such a change is now refused, and nothing is dispatched:

```json
{
  "error": "tool_changed",
  "message": "The tool 'get_order' changed after it was loaded, so the call was refused before reaching the backend. Load it again with load_tool and retry with the new version.",
  "retryable": false
}
```

Only that operation's version changes. Calls to every other tool in the same deploy go through. The agent never sees the revision itself: it is not on the card, in `load_tool` or in `search_tools`.

## Declare it on a controller or the whole catalog

A change in a shared service can reach every operation of a controller, or the whole backend. Declare the revision at that level instead of on each method:

| Level     | Declaration                            | Covers                        |
| --------- | -------------------------------------- | ----------------------------- |
| Catalog   | `options.revision`                     | Every tool                    |
| Container | `@McpTool({ revision })` on the class  | Every operation in that class |
| Operation | `@McpTool({ revision })` on the method | That operation                |

For a controller you cannot decorate, declare a container rule centrally. Returning null or `undefined` means no rule here:

```ts
SezzleeModule.forRoot((options) => {
  options.revision = 7;
  options.containerRevision = (container) =>
    container === "RuledController" ? 9 : undefined;
});
```

The levels add up instead of replacing one another. A controller declared with `revision: 4`, holding a method declared with `revision: 2`, in a catalog at `7`, gives that method's tool all three:

```json
{ "catalog": 7, "container": 4, "operation": 2 }
```

Raising the controller to `5` therefore changes that method's version too, even though the method declares its own.

When a controller declaration and a central rule both name a container, the declaration wins and the SDK reports `revision_overridden`, because raising the rule would change nothing. A value below `1` is reported as `invalid_revision` and ignored.

## Declare it on an OpenAPI gateway

`openapi-mcp` reads the same three levels from the document's `x-sezzlee` extension: the document root is the catalog, a path item covers every operation under it, and an operation covers itself.

```json
{
  "openapi": "3.0.3",
  "x-sezzlee": { "revision": 1 },
  "paths": {
    "/orders": {
      "x-sezzlee": { "revision": 4 },
      "post": { "operationId": "createOrder", "x-sezzlee": { "revision": 2 } }
    }
  }
}
```

A path item or the document root may carry only a revision; any other field there stops every operation beneath it from being published. The older `x-sezzlee-revision` spelling is still read, and when both spellings disagree neither is carried (`extension_conflict`).

If you cannot edit the document, declare the levels in the gateway configuration. Paths and operations are keyed as the document writes them:

```json
{
  "revision": {
    "catalog": 3,
    "paths": { "/orders": 5 },
    "operations": { "GET /orders": 6 }
  }
}
```

The configuration comes first at each level, and every extension it hides is reported as `revision_overridden`. A configured value below `1` stops the gateway at startup; one in the document is reported as `revision_invalid` and not carried.

:::details[Why the levels add up]

Tags and search terms let the nearer declaration replace the farther one. A revision cannot: if a method's revision replaced its controller's, raising the controller would leave the version of exactly the methods that declare their own unchanged, and those are the calls the controller's change reaches. Each level is therefore its own input to the version.

:::

:::details[What a revision cannot catch]

A revision is a declaration. A behaviour change nobody declares is invisible, as it is to any other client of your backend. A tool that declares no revision keeps the version it had before revisions existed, so upgrading the SDK is not itself a change every agent has to reload for. The normative rules are in the [invoke semantics](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/invoke-semantics.md#the-tool-version) and the [metadata contract](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/metadata-contract.md).

:::
