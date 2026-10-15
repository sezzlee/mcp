using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;
using Sezzlee.AspNetCore.Caching;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Visibility.Probe;

namespace Sezzlee.AspNetCore.Visibility;

internal sealed class ProbeBudget(int limit)
{
    public static readonly ProbeBudget Unbounded = new(int.MaxValue);

    private int _taken;

    public bool Exhausted => Volatile.Read(ref _taken) >= limit;

    public bool TryTake()
    {
        if (Interlocked.Increment(ref _taken) <= limit)
        {
            return true;
        }
        Interlocked.Decrement(ref _taken);
        return false;
    }
}

internal sealed class CallerVisibilityProvider
{
    private readonly IVisibilityEvaluator evaluator;
    private readonly IProbeEvaluator probe;
    private readonly ISezzleeCache cache;
    private readonly IOptions<SezzleeOptions> options;
    private readonly ILogger<CallerVisibilityProvider> logger;
    private readonly ToolAccessResolver access;
    private readonly SingleFlight<CallerFacts> _factsFlight = new();
    private readonly SingleFlight<VisibilityDecision> _probeFlight = new();
    private long _epoch;

    public CallerVisibilityProvider(
        IVisibilityEvaluator evaluator,
        IProbeEvaluator probe,
        ISezzleeCache cache,
        IOptions<SezzleeOptions> options,
        ILogger<CallerVisibilityProvider> logger,
        ISezzleeCatalogChangeSource changeSource,
        ToolAccessResolver access)
    {
        this.evaluator = evaluator;
        this.probe = probe;
        this.cache = cache;
        this.options = options;
        this.logger = logger;
        this.access = access;
        ChangeToken.OnChange(changeSource.GetChangeToken, Bump);
    }

    internal void Bump() => Interlocked.Increment(ref _epoch);

    internal void ForgetCaller(CallerScope scope) => access.Forget(scope);

    internal void ForgetAllCallers() => access.ForgetAll();

    public bool HasAuthorizer => access.HasAuthorizer;

    public ValueTask<IToolAccess?> AccessAsync(
        CallerScope scope, HttpRequest? outerRequest, CancellationToken cancellationToken) =>
        access.ResolveAsync(scope, outerRequest, cancellationToken);

    public bool CanProbe(CatalogEntry entry) => probe.CanProbe(entry);

    public UnknownVisibility OnUnknown =>
        options.Value.Visibility.OnUnknown ?? (HasAuthorizer ? UnknownVisibility.Hide : UnknownVisibility.Show);

    /// <remarks>
    /// Guard: the one place that orders the cheap tiers, shared by search_tools, load_tool and the
    /// test audit, so an audit cannot drift from what the tools show. An authorizer's allow or deny is
    /// final; unknown falls through to the declarative tier.
    /// </remarks>
    public static VisibilityDecision Decide(CatalogEntry entry, IToolAccess? access, CallerFacts facts)
    {
        VisibilityDecision decision = access?.Decide(entry.Info) ?? VisibilityDecision.Unknown;
        return decision != VisibilityDecision.Unknown
            ? decision
            : VisibilityCombiner.Evaluate(entry.Descriptor.Auth, facts);
    }

    public bool IsVisible(VisibilityDecision decision) => decision switch
    {
        VisibilityDecision.Allow => true,
        VisibilityDecision.Unknown => OnUnknown == UnknownVisibility.Show,
        _ => false,
    };

    /// <summary>
    /// Whether search_tools and load_tool would list each tool for the caller, from the cheap tiers
    /// alone: no probe, and neither the facts cache nor the held authorizer accesses are read or written.
    /// </summary>
    internal async Task<Func<CatalogEntry, bool>> ListingAsync(
        HttpRequest outerRequest, IReadOnlySet<string> policyNames, CancellationToken cancellationToken)
    {
        IToolAccess? held = await access.ResolveUncachedAsync(outerRequest, cancellationToken);
        CallerFacts facts = await evaluator.ResolveAsync(outerRequest, policyNames, cancellationToken);
        return entry => IsVisible(Decide(entry, held, facts));
    }

    public async Task<CallerFacts> FactsAsync(
        CallerScope scope, HttpRequest? outerRequest, IReadOnlySet<string> policyNames, CancellationToken cancellationToken)
    {
        TimeSpan lifetime = options.Value.Cache.Lifetime;
        if (lifetime <= TimeSpan.Zero)
        {
            return await evaluator.ResolveAsync(outerRequest, policyNames, cancellationToken);
        }

        CacheKey key = new(scope, CacheKind.Facts);
        long epoch = Volatile.Read(ref _epoch);
        string? cached = await TryGetAsync(key, cancellationToken);
        if (cached is not null)
        {
            return CallerFactsCodec.DecodeFacts(cached);
        }

        CallerFacts facts = await _factsFlight.RunAsync(
            key.ToString(), ct => evaluator.ResolveAsync(outerRequest, policyNames, ct), cancellationToken);

        if (Volatile.Read(ref _epoch) == epoch)
        {
            await TrySetAsync(key, CallerFactsCodec.EncodeFacts(facts), Jittered(lifetime), cancellationToken);
        }
        return facts;
    }

    public async Task<VisibilityDecision> ProbeAsync(
        CallerScope scope, HttpRequest? outerRequest, CatalogEntry entry, CancellationToken cancellationToken) =>
        await ProbeAsync(scope, outerRequest, entry, ProbeBudget.Unbounded, cancellationToken)
        ?? VisibilityDecision.Unknown;

    /// <returns>The verdict, or <see langword="null"/> when the cache had none and the budget refused to probe.</returns>
    public async Task<VisibilityDecision?> ProbeAsync(
        CallerScope scope, HttpRequest? outerRequest, CatalogEntry entry, ProbeBudget budget, CancellationToken cancellationToken)
    {
        TimeSpan lifetime = options.Value.Cache.Lifetime;
        if (lifetime <= TimeSpan.Zero)
        {
            return budget.TryTake() ? await probe.ProbeAsync(entry, outerRequest, cancellationToken) : null;
        }

        CacheKey key = new(scope, CacheKind.Probe, entry.Tool.Name);
        long epoch = Volatile.Read(ref _epoch);
        string? cached = await TryGetAsync(key, cancellationToken);
        if (cached is not null)
        {
            return CallerFactsCodec.DecodeProbe(cached);
        }

        bool refused = false;
        VisibilityDecision decision = await _probeFlight.RunAsync(
            key.ToString(),
            ct =>
            {
                if (budget.TryTake())
                {
                    return probe.ProbeAsync(entry, outerRequest, ct);
                }
                refused = true;
                return Task.FromResult(VisibilityDecision.Unknown);
            },
            cancellationToken);
        if (refused)
        {
            return null;
        }

        if (decision != VisibilityDecision.Unknown && Volatile.Read(ref _epoch) == epoch)
        {
            await TrySetAsync(key, CallerFactsCodec.EncodeProbe(decision), Jittered(lifetime), cancellationToken);
        }
        return decision;
    }

    private async Task<string?> TryGetAsync(CacheKey key, CancellationToken cancellationToken)
    {
        try
        {
            return await cache.GetAsync(key, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "sezzlee cache read failed for '{Key}'; treating as a miss.", key);
            return null;
        }
    }

    private async Task TrySetAsync(CacheKey key, string value, TimeSpan lifetime, CancellationToken cancellationToken)
    {
        try
        {
            await cache.SetAsync(key, value, lifetime, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "sezzlee cache write failed for '{Key}'.", key);
        }
    }

    private static TimeSpan Jittered(TimeSpan lifetime)
    {
        double factor = 1.0 - (Random.Shared.NextDouble() * 0.1);
        return TimeSpan.FromTicks((long)(lifetime.Ticks * factor));
    }
}

internal static class CallerFactsCodec
{
    public static string EncodeFacts(CallerFacts facts)
    {
        char identity = facts.Identity switch
        {
            CallerIdentity.Present => 'P',
            CallerIdentity.Absent => 'A',
            _ => 'U',
        };
        IEnumerable<string> pairs = facts.PolicyResults
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => $"{pair.Key}={EncodeDecision(pair.Value)}");
        return $"{identity}|{string.Join(';', pairs)}";
    }

    public static CallerFacts DecodeFacts(string text)
    {
        CallerIdentity identity = text.Length > 0
            ? text[0] switch
            {
                'P' => CallerIdentity.Present,
                'A' => CallerIdentity.Absent,
                _ => CallerIdentity.Unknown,
            }
            : CallerIdentity.Unknown;

        Dictionary<string, VisibilityDecision> results = new(StringComparer.Ordinal);
        int separator = text.IndexOf('|');
        string rest = separator < 0 ? string.Empty : text[(separator + 1)..];
        if (rest.Length > 0)
        {
            foreach (string pair in rest.Split(';'))
            {
                int equals = pair.IndexOf('=');
                if (equals < 0)
                {
                    continue;
                }
                results[pair[..equals]] = DecodeDecision(pair[(equals + 1)..]);
            }
        }
        return new CallerFacts(identity, results);
    }

    public static string EncodeProbe(VisibilityDecision decision) => decision switch
    {
        VisibilityDecision.Allow => "A",
        VisibilityDecision.Deny => "D",
        _ => throw new ArgumentOutOfRangeException(
            nameof(decision), decision, "Unknown probe decisions are never cached."),
    };

    public static VisibilityDecision DecodeProbe(string text) => text switch
    {
        "A" => VisibilityDecision.Allow,
        "D" => VisibilityDecision.Deny,
        _ => throw new FormatException($"Unrecognized cached probe value '{text}'."),
    };

    private static char EncodeDecision(VisibilityDecision decision) => decision switch
    {
        VisibilityDecision.Allow => 'A',
        VisibilityDecision.Deny => 'D',
        _ => 'U',
    };

    private static VisibilityDecision DecodeDecision(string letter) => letter switch
    {
        "A" => VisibilityDecision.Allow,
        "D" => VisibilityDecision.Deny,
        _ => VisibilityDecision.Unknown,
    };
}
