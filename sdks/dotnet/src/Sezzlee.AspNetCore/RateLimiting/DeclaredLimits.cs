using System.Threading.RateLimiting;

namespace Sezzlee.AspNetCore.RateLimiting;

internal static class DeclaredLimits
{
    public static IReadOnlyList<RateLimitPartition<string>> PartitionsFor(RateLimitingOptions limits, McpCallContext call)
    {
        string key = limits.KeyFunction?.Invoke(call) ?? call.CallerScope;
        List<RateLimitPartition<string>> partitions = [];

        (RateLimitSettings? own, string bucket) = call.MetaTool switch
        {
            McpMetaTool.Search => (limits.Search, "search"),
            McpMetaTool.Load => (limits.Load, "load"),
            McpMetaTool.Invoke => (limits.Invoke, "invoke"),
            _ => (null, string.Empty),
        };
        RateLimitSettings? settings = own ?? limits.Default;
        if (settings is not null)
        {
            partitions.Add(Partition($"{(own is null ? "default" : bucket)}:{key}", settings));
        }

        if (call.MetaTool == McpMetaTool.Invoke && limits.InvokeConcurrency is int running)
        {
            partitions.Add(Partition(
                $"invoke-concurrency:{key}",
                new RateLimitSettings { Kind = RateLimitKind.Concurrency, PermitLimit = running }));
        }
        return partitions;
    }

    private static RateLimitPartition<string> Partition(string key, RateLimitSettings settings) => settings.Kind switch
    {
        RateLimitKind.TokenBucket => RateLimitPartition.GetTokenBucketLimiter(key, _ => new TokenBucketRateLimiterOptions
        {
            TokenLimit = settings.TokenLimit,
            TokensPerPeriod = settings.TokensPerPeriod,
            ReplenishmentPeriod = settings.Period,
            QueueLimit = settings.QueueLimit,
        }),
        RateLimitKind.FixedWindow => RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = settings.PermitLimit,
            Window = settings.Window,
            QueueLimit = settings.QueueLimit,
        }),
        RateLimitKind.SlidingWindow => RateLimitPartition.GetSlidingWindowLimiter(key, _ => new SlidingWindowRateLimiterOptions
        {
            PermitLimit = settings.PermitLimit,
            Window = settings.Window,
            SegmentsPerWindow = settings.SegmentsPerWindow,
            QueueLimit = settings.QueueLimit,
        }),
        RateLimitKind.Concurrency => RateLimitPartition.GetConcurrencyLimiter(key, _ => new ConcurrencyLimiterOptions
        {
            PermitLimit = settings.PermitLimit,
            QueueLimit = settings.QueueLimit,
        }),
        _ => throw new ArgumentOutOfRangeException(nameof(settings), settings.Kind, "Unknown rate limit kind."),
    };
}
