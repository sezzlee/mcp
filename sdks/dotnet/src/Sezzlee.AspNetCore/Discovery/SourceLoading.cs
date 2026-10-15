global using FamilyLoad = Sezzlee.AspNetCore.Discovery.SourceLoad<System.Collections.Generic.IReadOnlyList<Sezzlee.AspNetCore.Discovery.McpFamilyMember>>;
global using SelectionLoad = Sezzlee.AspNetCore.Discovery.SourceLoad<System.Collections.Generic.IReadOnlyList<Sezzlee.AspNetCore.Discovery.McpSelectionEntry>>;
using Microsoft.Extensions.DependencyInjection;

namespace Sezzlee.AspNetCore.Discovery;

/// <summary>How a host's data source is loaded, shared by every source the SDK reads.</summary>
public abstract class SourceLoadOptions
{
    public TimeSpan LoadTimeout { get; set; } = TimeSpan.FromSeconds(10);

    public FamilyLoadMode LoadMode { get; set; } = FamilyLoadMode.Blocking;

    /// <summary>
    /// How often the source is loaded again after the first load. <see cref="TimeSpan.Zero"/> loads
    /// it once. A refresh whose rows equal the published ones changes nothing.
    /// </summary>
    public TimeSpan RefreshInterval { get; set; } = TimeSpan.Zero;

    public FamilyLoadFailure OnFailure { get; set; } = FamilyLoadFailure.Drop;
}

[Flags]
internal enum CatalogSources
{
    None = 0,
    Families = 1,
    Selection = 2,
    All = Families | Selection,
}

internal abstract record SourceLoad<T> where T : class
{
    internal sealed record Loaded(T Value) : SourceLoad<T>;

    internal sealed record Stale(T Value, Exception Error) : SourceLoad<T>;

    internal sealed record Failed(Exception Error) : SourceLoad<T>;

    internal T? Published => this switch
    {
        Loaded loaded => loaded.Value,
        Stale stale => stale.Value,
        _ => null,
    };
}

internal sealed record SourceLoads(
    IReadOnlyDictionary<string, FamilyLoad> Families,
    SelectionLoad? Selection)
{
    public static readonly SourceLoads None = new(new Dictionary<string, FamilyLoad>(), null);

    public SourceLoads With(CatalogSources read, SourceLoads loaded) => new(
        read.HasFlag(CatalogSources.Families) ? loaded.Families : Families,
        read.HasFlag(CatalogSources.Selection) ? loaded.Selection : Selection);
}

internal static class SourceReader
{
    /// <summary>Loads one source in its own service scope, outside any request.</summary>
    /// <remarks>
    /// Guard: a source runs on the thread pool because a source that does its work synchronously
    /// before returning would otherwise hold the caller past the load timeout, and hold startup in
    /// <see cref="FamilyLoadMode.Background"/>.
    /// A failing source keeps the rows it last returned: dropping them because the source was briefly
    /// unreachable would take working tools offline on every transient error.
    /// </remarks>
    public static async Task<SourceLoad<T>> LoadAsync<T>(
        Func<IServiceProvider, CancellationToken, ValueTask<T>> source,
        IServiceScopeFactory? scopes,
        TimeSpan timeout,
        string timeoutMessage,
        SourceLoad<T>? previous,
        CancellationToken cancellationToken)
        where T : class
    {
        try
        {
            using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(timeout);
            try
            {
                T value = await Task.Run(() => LoadOneAsync(source, scopes, deadline.Token), deadline.Token)
                    .WaitAsync(deadline.Token);
                return new SourceLoad<T>.Loaded(value);
            }
            catch (OperationCanceledException canceled)
                when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                throw new TimeoutException(timeoutMessage, canceled);
            }
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            return previous switch
            {
                SourceLoad<T>.Loaded last => new SourceLoad<T>.Stale(last.Value, ex),
                SourceLoad<T>.Stale last => new SourceLoad<T>.Stale(last.Value, ex),
                _ => new SourceLoad<T>.Failed(ex),
            };
        }
    }

    private static async Task<T> LoadOneAsync<T>(
        Func<IServiceProvider, CancellationToken, ValueTask<T>> source,
        IServiceScopeFactory? scopes,
        CancellationToken cancellationToken)
    {
        if (scopes is null)
        {
            return await source(EmptyServices.Instance, cancellationToken);
        }
        await using AsyncServiceScope scope = scopes.CreateAsyncScope();
        return await source(scope.ServiceProvider, cancellationToken);
    }

    private sealed class EmptyServices : IServiceProvider
    {
        public static readonly EmptyServices Instance = new();

        public object? GetService(Type serviceType) => null;
    }
}
