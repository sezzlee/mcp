using System.Threading.RateLimiting;

namespace Sezzlee.AspNetCore.RateLimiting;

/// <summary>
/// Limits what one caller may ask of the meta-tools. With nothing configured nothing is limited and the
/// SDK behaves as without it. Declared limits and a partition function are alternatives: setting both
/// fails startup.
/// </summary>
public sealed class RateLimitingOptions
{
    /// <summary>The limit of every meta-tool that has no section of its own, <c>Other</c> included.</summary>
    public RateLimitSettings? Default { get; set; }

    /// <summary>Replaces <see cref="Default"/> for <c>search_tools</c>.</summary>
    public RateLimitSettings? Search { get; set; }

    /// <summary>Replaces <see cref="Default"/> for <c>load_tool</c>.</summary>
    public RateLimitSettings? Load { get; set; }

    /// <summary>Replaces <see cref="Default"/> for <c>invoke_tool</c>.</summary>
    public RateLimitSettings? Invoke { get; set; }

    /// <summary>
    /// The most <c>invoke_tool</c> calls one caller may have running at once, held until the result is
    /// mapped, in addition to <see cref="Invoke"/> or <see cref="Default"/>.
    /// </summary>
    public int? InvokeConcurrency { get; set; }

    internal Func<McpCallContext, string>? KeyFunction { get; private set; }

    internal Func<McpCallContext, IReadOnlyList<RateLimitPartition<string>>>? PartitionFunction { get; private set; }

    internal bool HasDeclared =>
        Default is not null || Search is not null || Load is not null || Invoke is not null
        || InvokeConcurrency is not null;

    internal bool IsConfigured => HasDeclared || PartitionFunction is not null;

    /// <summary>
    /// Partitions the declared limits by the key this returns instead of the caller scope key. The scope
    /// key fits only while it stays the same for one caller: one that carries a permission or version
    /// stamp starts a fresh bucket on every change, and such a host supplies a stable key here, such as
    /// a user or grant identifier.
    /// </summary>
    public void Key(Func<McpCallContext, string> key)
    {
        ArgumentNullException.ThrowIfNull(key);
        KeyFunction = key;
    }

    /// <summary>
    /// Replaces the declared limits with one partition per call. Partitions with equal keys share one
    /// limiter until it idles out.
    /// </summary>
    public void Partition(Func<McpCallContext, RateLimitPartition<string>> partition)
    {
        ArgumentNullException.ThrowIfNull(partition);
        PartitionFunction = context => [partition(context)];
    }

    /// <summary>
    /// Replaces the declared limits with the partitions this returns. A call takes one permit from each
    /// in order and is refused when any refuses; no partitions leaves the call unlimited.
    /// </summary>
    public void Partitions(Func<McpCallContext, IReadOnlyList<RateLimitPartition<string>>> partitions)
    {
        ArgumentNullException.ThrowIfNull(partitions);
        PartitionFunction = partitions;
    }
}

/// <summary>Which <c>System.Threading.RateLimiting</c> limiter a <see cref="RateLimitSettings"/> builds.</summary>
public enum RateLimitKind
{
    /// <summary>Needs <see cref="RateLimitSettings.TokenLimit"/>, <see cref="RateLimitSettings.TokensPerPeriod"/> and <see cref="RateLimitSettings.Period"/>.</summary>
    TokenBucket,

    /// <summary>Needs <see cref="RateLimitSettings.PermitLimit"/> and <see cref="RateLimitSettings.Window"/>.</summary>
    FixedWindow,

    /// <summary>Needs <see cref="RateLimitSettings.PermitLimit"/>, <see cref="RateLimitSettings.Window"/> and <see cref="RateLimitSettings.SegmentsPerWindow"/>.</summary>
    SlidingWindow,

    /// <summary>Needs <see cref="RateLimitSettings.PermitLimit"/>.</summary>
    Concurrency,
}

/// <summary>One declared limit. Only the fields <see cref="Kind"/> names are read.</summary>
public sealed class RateLimitSettings
{
    public RateLimitKind Kind { get; set; }

    public int PermitLimit { get; set; }

    public int TokenLimit { get; set; }

    public int TokensPerPeriod { get; set; }

    public TimeSpan Period { get; set; }

    public TimeSpan Window { get; set; }

    public int SegmentsPerWindow { get; set; }

    /// <summary>How many calls may wait for a permit; zero refuses at once. A wait ends when the MCP call is cancelled.</summary>
    public int QueueLimit { get; set; }
}
