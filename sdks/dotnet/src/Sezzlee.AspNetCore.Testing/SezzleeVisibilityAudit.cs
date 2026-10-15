using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Visibility;
using Sezzlee.AspNetCore.Visibility.Probe;

namespace Sezzlee.AspNetCore.Testing;

public static class SezzleeVisibilityAudit
{
    private abstract record Truth;

    private sealed record Decided(bool Allowed) : Truth;

    private sealed record Unjudged(string Reason) : Truth;

    private sealed record Row(string Caller, CatalogEntry Entry, HttpRequest Outer, bool? Listed);

    /// <summary>
    /// Compares, for each caller and each catalog tool, what <c>search_tools</c> and <c>load_tool</c>
    /// would show with what the real pipeline answers.
    /// </summary>
    /// <remarks>
    /// The listing side takes the cheap tiers only: the host's <see cref="IToolAuthorizer"/>, then the
    /// declarative evaluation, then <c>Visibility.OnUnknown</c>, through the code the tools use and without
    /// a probe, so the audit measures those tiers. The truth side sends one probe per tool and caller
    /// through the registered <see cref="IProbeEvaluator"/>: uncached, not limited by
    /// <c>MaxProbesPerSearch</c> and not gated by <c>Visibility.Tier</c>. It neither reads nor writes the
    /// shared verdict cache or the held authorizer accesses.
    /// Limit: the probe stops before the handler, so a check inside it, such as a dispatcher that
    /// validates its target method, is invisible to it. A tool the authorizer hides for that reason shows
    /// as <see cref="VisibilityAuditKind.HiddenButAllowed"/>; skip it with
    /// <see cref="VisibilityAuditOptions.Exclude"/>.
    /// The probe's disabled latch is the app's own: a probe that does not route, or that succeeds without
    /// the short-circuit marker, disables probing for that tool until the catalog changes, exactly as it
    /// would during a search, so an audit can leave a tool disabled for the search that follows.
    /// </remarks>
    /// <param name="services">The started app's services; the host must have called <c>AddSezzlee</c> and <c>UseSezzleeCapture</c>.</param>
    /// <param name="callers">The identities to audit; names must be unique.</param>
    /// <exception cref="ArgumentException">A caller name is blank or used twice.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><see cref="VisibilityAuditOptions.Concurrency"/> is not positive.</exception>
    /// <exception cref="InvalidOperationException">Sezzlee is not registered, or its pipeline was not captured.</exception>
    public static Task<VisibilityAuditReport> RunAsync(
        IServiceProvider services,
        IEnumerable<AuditCaller> callers,
        VisibilityAuditOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(callers);
        options ??= new VisibilityAuditOptions();
        ArgumentOutOfRangeException.ThrowIfLessThan(options.Concurrency, 1, nameof(options));
        AuditCaller[] audited = [.. callers];
        foreach (AuditCaller caller in audited)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(caller.Name, nameof(callers));
        }
        string? repeated = audited.GroupBy(caller => caller.Name, StringComparer.Ordinal)
            .FirstOrDefault(group => group.Count() > 1)?.Key;
        if (repeated is not null)
        {
            throw new ArgumentException(
                $"Caller name '{repeated}' is used twice; findings would not say which one they mean.", nameof(callers));
        }
        if (services.GetService<SezzleeRegistrationMarker>() is null)
        {
            throw new InvalidOperationException("sezzlee is not registered: call AddSezzlee on the app under test.");
        }
        return AuditAsync(services, audited, options, cancellationToken);
    }

    private static async Task<VisibilityAuditReport> AuditAsync(
        IServiceProvider services, AuditCaller[] callers, VisibilityAuditOptions options, CancellationToken cancellationToken)
    {
        SezzleeCatalogProvider catalog = services.GetRequiredService<SezzleeCatalogProvider>();
        catalog.EnsureValid();
        IReadOnlyList<CatalogEntry> entries = catalog.Result.Entries;
        IReadOnlySet<string> policyNames = catalog.PolicyNames;
        CallerVisibilityProvider visibility = services.GetRequiredService<CallerVisibilityProvider>();
        IProbeEvaluator prober = services.GetRequiredService<IProbeEvaluator>();
        Func<McpToolInfo, bool> excluded = options.Exclude ?? (_ => false);

        List<Row> rows = [];
        foreach (AuditCaller caller in callers)
        {
            DefaultHttpContext outer = new();
            caller.Prepare(outer.Request);
            Func<CatalogEntry, bool> listing = await visibility.ListingAsync(outer.Request, policyNames, cancellationToken);
            rows.AddRange(entries.Select(entry =>
                new Row(caller.Name, entry, outer.Request, excluded(entry.Info) ? null : listing(entry))));
        }

        Truth?[] truths = new Truth?[rows.Count];
        await Parallel.ForEachAsync(
            Enumerable.Range(0, rows.Count).Where(index => rows[index].Listed is not null),
            new ParallelOptions { MaxDegreeOfParallelism = options.Concurrency, CancellationToken = cancellationToken },
            async (index, token) => truths[index] = await TruthOfAsync(prober, rows[index], token));

        List<VisibilityAuditFinding> findings = [];
        int consistent = 0;
        for (int index = 0; index < rows.Count; index++)
        {
            Row row = rows[index];
            string tool = row.Entry.Tool.Name;
            switch (truths[index])
            {
                case null:
                    findings.Add(new VisibilityAuditFinding(row.Caller, tool, VisibilityAuditKind.Excluded));
                    break;
                case Unjudged unjudged:
                    findings.Add(new VisibilityAuditFinding(row.Caller, tool, VisibilityAuditKind.NotComparable, unjudged.Reason));
                    break;
                case Decided { Allowed: false } when row.Listed is true:
                    findings.Add(new VisibilityAuditFinding(row.Caller, tool, VisibilityAuditKind.ListedButDenied));
                    break;
                case Decided { Allowed: true } when row.Listed is false:
                    findings.Add(new VisibilityAuditFinding(row.Caller, tool, VisibilityAuditKind.HiddenButAllowed));
                    break;
                default:
                    consistent++;
                    break;
            }
        }
        return new VisibilityAuditReport(callers.Length, entries.Count, consistent, findings);
    }

    private static async Task<Truth> TruthOfAsync(IProbeEvaluator prober, Row row, CancellationToken cancellationToken)
    {
        if (!prober.CanProbe(row.Entry))
        {
            return new Unjudged(
                "the tool cannot be probed: it is neither an MVC action nor a safe-method endpoint with declarative "
                + "authorization, or an earlier probe disabled probing for it; declare a value in Visibility.ProbeValues");
        }
        VisibilityDecision decision = await prober.ProbeAsync(row.Entry, row.Outer, cancellationToken);
        return decision switch
        {
            VisibilityDecision.Allow => new Decided(true),
            VisibilityDecision.Deny => new Decided(false),
            _ => new Unjudged(prober.CanProbe(row.Entry)
                ? "the probe was inconclusive: a throttle, a server error, a timeout or a redirect says nothing about this caller's access"
                : "the probe disabled itself for this tool: its path did not route or the response came back without the short-circuit marker; declare a value in Visibility.ProbeValues"),
        };
    }
}
