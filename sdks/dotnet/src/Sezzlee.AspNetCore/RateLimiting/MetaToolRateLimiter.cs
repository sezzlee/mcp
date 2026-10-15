using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sezzlee.AspNetCore.Caching;
using Sezzlee.AspNetCore.Errors;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore.RateLimiting;

/// <remarks>
/// Guard: the target is found by the raw <c>name</c> argument without visibility, so a hidden or unknown
/// name takes a permit like a visible one. Otherwise <c>unknown_tool</c> answers would let a caller
/// enumerate names without limit.
/// </remarks>
internal sealed class MetaToolRateLimiter(
    IOptions<SezzleeOptions> options,
    SezzleeCatalogProvider catalog,
    ICallerScopeResolver scopeResolver,
    IHttpContextAccessor httpContextAccessor,
    ILogger<MetaToolRateLimiter> logger) : IDisposable
{
    private readonly PartitionedRateLimiter<RateLimitPartition<string>> _limiters =
        PartitionedRateLimiter.Create<RateLimitPartition<string>, string>(partition => partition);

    public async ValueTask<MetaCallAdmission> AdmitAsync(
        string toolName,
        IDictionary<string, JsonElement>? arguments,
        CancellationToken cancellationToken)
    {
        RateLimitingOptions limits = options.Value.RateLimiting;
        HttpContext? http = httpContextAccessor.HttpContext;
        McpMetaTool metaTool = Classify(toolName);
        McpCallContext context = new(
            http,
            metaTool,
            TargetOf(metaTool, arguments),
            toolName,
            scopeResolver.Resolve(http?.Request).Key);

        IReadOnlyList<RateLimitPartition<string>> partitions = limits.PartitionFunction is { } custom
            ? custom(context)
            : DeclaredLimits.PartitionsFor(limits, context);

        List<RateLimitLease> held = new(partitions.Count);
        try
        {
            foreach (RateLimitPartition<string> partition in partitions)
            {
                RateLimitLease lease = await _limiters.AcquireAsync(partition, 1, cancellationToken).ConfigureAwait(false);
                if (lease.IsAcquired)
                {
                    held.Add(lease);
                    continue;
                }

                int? retryAfter = RetryAfterSeconds(lease);
                lease.Dispose();
                logger.LogDebug(
                    "Rate limit refused a {MetaTool} call in partition '{Partition}'",
                    metaTool, partition.PartitionKey);
                Release(held);
                return new MetaCallAdmission([], SdkErrors.RefuseRateLimited(retryAfter));
            }
        }
        catch
        {
            Release(held);
            throw;
        }
        return new MetaCallAdmission(held, null);
    }

    public void Dispose() => _limiters.Dispose();

    private static McpMetaTool Classify(string toolName) => toolName switch
    {
        "search_tools" => McpMetaTool.Search,
        "load_tool" => McpMetaTool.Load,
        "invoke_tool" => McpMetaTool.Invoke,
        _ => McpMetaTool.Other,
    };

    private Visibility.McpToolInfo? TargetOf(McpMetaTool metaTool, IDictionary<string, JsonElement>? arguments)
    {
        if (metaTool is not (McpMetaTool.Load or McpMetaTool.Invoke)
            || arguments is null
            || !arguments.TryGetValue("name", out JsonElement name)
            || name.ValueKind != JsonValueKind.String)
        {
            return null;
        }
        return catalog.Find(name.GetString()!)?.Info;
    }

    private static int? RetryAfterSeconds(RateLimitLease lease) =>
        lease.TryGetMetadata(MetadataName.RetryAfter, out TimeSpan retryAfter) && retryAfter > TimeSpan.Zero
            ? (int)Math.Min(Math.Ceiling(retryAfter.TotalSeconds), int.MaxValue)
            : null;

    private static void Release(List<RateLimitLease> held)
    {
        foreach (RateLimitLease lease in held)
        {
            lease.Dispose();
        }
        held.Clear();
    }
}

internal sealed class MetaCallAdmission(IReadOnlyList<RateLimitLease> leases, SdkError? refusal) : IDisposable
{
    public SdkError? Refusal { get; } = refusal;

    public void Dispose()
    {
        foreach (RateLimitLease lease in leases)
        {
            lease.Dispose();
        }
    }
}
