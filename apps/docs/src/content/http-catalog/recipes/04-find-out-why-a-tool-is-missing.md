# Find out why a tool is missing

An endpoint exists but `search_tools` does not return it. Work through these checks top to bottom. Each rules out one cause.

## 1. Read the catalog line

The catalog is built at startup and reports itself. Find this line in your host's log first:

```text
info: Sezzlee.AspNetCore.SezzleeCatalogProvider[0]
      sezzlee catalog: 16 discovered, 9 selected, 9 tools, 0 diagnostic(s)
```

The gap between the numbers names the layer that lost your endpoint.

- `discovered` is what the framework knows about. If it is `0`, on ASP.NET Core `AddEndpointsApiExplorer()` is usually missing from a host that does not get it implicitly.
- `discovered` to `selected` is selection. This is the most common gap.
- `selected` to `tools` is catalog construction. The diagnostics say which endpoints were dropped.

If `tools` includes your endpoint, the problem is per caller. Skip to step 4.

## 2. Rule out selection

Selection is opt-in. With no `[McpTool]` or `@McpTool()` anywhere, `selected` is `0` and search is empty for everyone. A partly decorated backend is subtler: the method is not on the route you expected, or an `[McpIgnore]` on the class wins. See [Choose which endpoints become tools](/docs/http-catalog/choose-which-endpoints-become-tools).

## 3. Read the diagnostics

When `selected` is higher than `tools`, a diagnostic names each dropped endpoint. There are three severities:

- **warning** is recorded and nothing is dropped.
- **endpointDropped** removes that endpoint and keeps the rest of the catalog.
- **fatal** means the catalog is not trustworthy, and the host refuses to start.

Three codes are fatal by default: `name_collision`, `ambiguous_selection` and `invalid_name`. Each means two declarations disagree, and a conflict is an error here, never a coin flip.

Two codes drop a single endpoint most often:

- `argument_collision`: a path or query parameter and a body property share a name, so the flat argument object cannot hold both.
- `unsupported_binding`: a body media type with no writer, a raw-body binding or a wildcard route. For forms and uploads, see [Accept form bodies and file uploads](/docs/http-catalog/accept-form-and-file-uploads).

Family sources add their own codes: [Expose a dispatching endpoint as one tool per method](/docs/http-catalog/expose-a-dispatching-endpoint-as-one-tool-per-method).

The complete lists are in the source, one per SDK: [`DiagnosticCodes.cs`](https://github.com/sezzlee/mcp/blob/main/sdks/dotnet/src/Sezzlee.AspNetCore/Discovery/DiagnosticCodes.cs) and [`diagnostics.ts`](https://github.com/sezzlee/mcp/blob/main/sdks/nestjs/src/discovery/diagnostics.ts). The two sets are not identical.

## 4. Rule out visibility

If the tool is in the catalog but one caller cannot see it, the visibility filter is working. Search as a caller you know is allowed and compare. See [Control what a caller can see](/docs/http-catalog/control-what-a-caller-can-see).

On NestJS, one cause is worth checking early. A guard without `describeVisibility()` pins its endpoint to `unknown`, and with `visibility.onUnknown: "hide"` every such endpoint disappears for everyone. See [Declare visibility for a NestJS guard](/docs/http-catalog/declare-visibility-for-a-nestjs-guard).

## 5. Change a severity

Once you know the code, you can move it. Downgrade to keep an endpoint you can live without, or escalate to make a warning stop the build:

:::tabs

```csharp title="ASP.NET Core"
builder.Services.AddSezzlee(options =>
{
    options.Diagnostics.Downgrade.Add(DiagnosticCodes.NameCollision);
    options.Diagnostics.Escalate.Add(DiagnosticCodes.UnreadableShape);
});
```

```ts title="NestJS"
SezzleeModule.forRoot((options) => {
  options.diagnostics.downgrade.add("name_collision");
  options.diagnostics.escalate.add("unreadable_shape");
});
```

:::

`diagnostics.failOn` sets the threshold that stops startup, `fatal` by default. Downgrading a fatal code ships a catalog with a known conflict: with `name_collision` downgraded, the catalog does not promise which endpoint an agent reaches by that name. Fix the names where you can.

:::details[A tool exists but the agent cannot call it correctly]

The catalog line counts endpoints, not correctness. An opaque body from `unreadable_shape` or a truncated schema from `schema_depth_truncated` is a `warning`, and the tool still counts in `tools`. If an agent can find a tool but not call it, read the warnings you skipped.

:::
