# Sezzlee.AspNetCore.Testing

> Status: `1.0.0`, stable. Versioned with `Sezzlee.AspNetCore`; use the same version of both.

`search_tools` and `load_tool` decide what a caller sees from your `IToolAuthorizer` and from your endpoints' declared authorization. The request pipeline decides what the caller can actually do. `SezzleeVisibilityAudit` checks the two against each other in your tests, for each caller you name and each tool in the catalog, so a permission change that only one side learns about fails a test instead of surfacing in production.

```csharp
using Microsoft.AspNetCore.Mvc.Testing;
using Sezzlee.AspNetCore.Testing;

public sealed class VisibilityAuditTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Each_caller_sees_exactly_what_the_pipeline_lets_through()
    {
        VisibilityAuditReport report = await SezzleeVisibilityAudit.RunAsync(
            factory.Services,
            [
                AuditCaller.WithHeaders("clerk", ("Authorization", $"Bearer {ClerkToken}")),
                AuditCaller.WithHeaders("auditor", ("Authorization", $"Bearer {AuditorToken}")),
            ],
            new VisibilityAuditOptions
            {
                Exclude = tool => tool.Container == typeof(MethodDispatcher).FullName,
            });

        report.EnsureConsistent();
    }
}
```

Pass the services of the started app (`WebApplicationFactory<T>.Services`, or `WebApplication.Services` on a `TestServer`). The app must call `AddSezzlee` and `UseSezzleeCapture`; the pipeline is captured when the host starts. An `AuditCaller` is a name and an `Action<HttpRequest>` that sets what that caller's MCP requests carry on the outer request; `AuditCaller.WithHeaders` covers the usual case of an authorization header.

## What it compares

The listing side runs the cheap tiers only, through the same decision code the tools use: the authorizer, then the declarative evaluation, then `Visibility.OnUnknown`. It does not probe, so the comparison measures those tiers.

The truth side sends one probe per tool and caller through the registered `IProbeEvaluator`: a request through your middleware, filters and authorization that stops before the handler. It is uncached, not limited by `MaxProbesPerSearch`, and not gated by `Visibility.Tier`. It neither reads nor writes the verdict cache or the held authorizer accesses, so an audit cannot change what a later search shows.

Each caller and tool pair ends as one of:

| Kind               | Meaning                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `ListedButDenied`  | Listed, but the probe got a 401 or 403                                                                                          |
| `HiddenButAllowed` | Hidden, but the probe got through                                                                                               |
| `NotComparable`    | The probe could not judge it (not probeable, probing disabled for the tool, a 429, a 5xx, a timeout), with a `Reason`           |
| `Excluded`         | Skipped by `VisibilityAuditOptions.Exclude`                                                                                     |

`report.Findings` lists every pair that is not consistent, in caller then catalog order. `report.Counts` totals each kind, and `report.Total`, `report.Consistent` and `report.Compared` count the rest; every pair is accounted for. `EnsureConsistent()` throws a `VisibilityAuditException` that carries the report and a message grouped by kind. It fails on `NotComparable` too, because a pair the probe could not judge was not checked: declare a `Visibility.ProbeValues` entry for a route the probe could not reach, or exclude the tool. Only `Excluded` passes.

`VisibilityAuditOptions.Concurrency` (default 4, must be positive) bounds the probes in flight. Caller names must be unique, so a finding always says which caller it means.

## Limits

The probe stops before the handler, so a check inside a handler, such as a dispatcher that validates its target method, is invisible to it. A tool your authorizer hides for that reason shows as `HiddenButAllowed`. Skip such a tool with `Exclude`: it is reported as `Excluded` for every caller instead of being dropped.

The probe's disabled latch belongs to the app, not the audit. A probe that does not route, or that succeeds without the short-circuit marker, disables probing for that tool until the catalog changes, exactly as it would during a search. An audit can therefore leave a tool disabled for the search that follows it, and a tool already disabled is reported as `NotComparable`.

A probe request that throws instead of answering, such as a pipeline that was never captured, fails the audit with that exception rather than being reported as a finding.
