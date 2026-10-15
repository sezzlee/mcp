using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sezzlee.AspNetCore.Caching;

namespace Sezzlee.AspNetCore.Visibility;

/// <summary>
/// Runs the host's <see cref="IToolAuthorizer"/> and keeps what it resolved per caller scope.
/// </summary>
/// <remarks>
/// Guard: the access objects stay in process memory instead of <see cref="ISezzleeCache"/>, which stores
/// strings; a distributed cache cannot carry an object the host defined. The authorizer is resolved from
/// a fresh service scope each time so a scoped registration works, which is why an access must not hold
/// that scope.
/// </remarks>
internal sealed class ToolAccessResolver
{
    private sealed record Cached(TaskCompletionSource<IToolAccess> Completion, long ExpiresAt);

    private readonly IServiceScopeFactory scopes;
    private readonly IOptions<SezzleeOptions> options;
    private readonly TimeProvider time;
    private readonly ILogger<ToolAccessResolver> logger;
    private readonly ConcurrentDictionary<string, Cached> _entries = new(StringComparer.Ordinal);
    private readonly object _trim = new();
    private long _epoch;

    public ToolAccessResolver(
        IServiceScopeFactory scopes,
        IServiceProviderIsService registrations,
        IOptions<SezzleeOptions> options,
        TimeProvider time,
        ILogger<ToolAccessResolver> logger)
    {
        this.scopes = scopes;
        this.options = options;
        this.time = time;
        this.logger = logger;
        HasAuthorizer = registrations.IsService(typeof(IToolAuthorizer));
    }

    public bool HasAuthorizer { get; }

    public async ValueTask<IToolAccess?> ResolveAsync(
        CallerScope scope, HttpRequest? outerRequest, CancellationToken cancellationToken)
    {
        if (!HasAuthorizer)
        {
            return null;
        }
        TimeSpan lifetime = options.Value.Cache.Lifetime;
        if (lifetime <= TimeSpan.Zero)
        {
            return await CreateAsync(outerRequest, cancellationToken);
        }

        long epoch = Volatile.Read(ref _epoch);
        long now = time.GetTimestamp();
        Cached fresh = new(
            new TaskCompletionSource<IToolAccess>(TaskCreationOptions.RunContinuationsAsynchronously),
            now + (long)(lifetime.TotalSeconds * time.TimestampFrequency));
        Cached current = _entries.AddOrUpdate(scope.Key, fresh, (_, existing) => existing.ExpiresAt > now ? existing : fresh);
        if (!ReferenceEquals(current, fresh))
        {
            logger.LogDebug("sezzlee authorizer access for a caller scope served from the cache");
            return await current.Completion.Task.WaitAsync(cancellationToken);
        }

        try
        {
            fresh.Completion.SetResult(await CreateAsync(outerRequest, CancellationToken.None));
        }
        catch (Exception ex)
        {
            fresh.Completion.SetException(ex);
            _entries.TryRemove(new KeyValuePair<string, Cached>(scope.Key, fresh));
        }
        if (Volatile.Read(ref _epoch) != epoch)
        {
            _entries.TryRemove(new KeyValuePair<string, Cached>(scope.Key, fresh));
        }
        Trim(now);
        return await fresh.Completion.Task.WaitAsync(cancellationToken);
    }

    public void Forget(CallerScope scope)
    {
        Interlocked.Increment(ref _epoch);
        _entries.TryRemove(scope.Key, out _);
    }

    public void ForgetAll()
    {
        Interlocked.Increment(ref _epoch);
        _entries.Clear();
    }

    /// <summary>
    /// Lends the authorizer's <see cref="IToolAuthorizer.Covers"/> for one pass over the catalog, in a
    /// service scope that ends with the call. Without an authorizer it covers nothing.
    /// </summary>
    public T WithCoverage<T>(Func<Func<McpToolInfo, bool>, T> use)
    {
        if (!HasAuthorizer)
        {
            return use(_ => false);
        }
        using IServiceScope scope = scopes.CreateScope();
        return use(scope.ServiceProvider.GetRequiredService<IToolAuthorizer>().Covers);
    }

    private async ValueTask<IToolAccess> CreateAsync(HttpRequest? outerRequest, CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        await using AsyncServiceScope scope = scopes.CreateAsyncScope();
        IToolAccess access = await scope.ServiceProvider.GetRequiredService<IToolAuthorizer>()
            .ResolveAsync(outerRequest, cancellationToken);
        logger.LogDebug(
            "sezzlee authorizer resolved a caller's access in {Elapsed} ms",
            (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        return access;
    }

    private void Trim(long now)
    {
        int capacity = Math.Max(1, options.Value.Cache.MaxCallers);
        if (_entries.Count <= capacity)
        {
            return;
        }
        lock (_trim)
        {
            foreach (KeyValuePair<string, Cached> entry in _entries)
            {
                if (_entries.Count <= capacity)
                {
                    return;
                }
                if (entry.Value.ExpiresAt <= now && entry.Value.Completion.Task.IsCompleted)
                {
                    _entries.TryRemove(entry);
                }
            }
            foreach (KeyValuePair<string, Cached> entry in _entries.OrderBy(e => e.Value.ExpiresAt).ToArray())
            {
                if (_entries.Count <= capacity)
                {
                    return;
                }
                if (entry.Value.Completion.Task.IsCompleted)
                {
                    _entries.TryRemove(entry);
                }
            }
        }
    }
}
