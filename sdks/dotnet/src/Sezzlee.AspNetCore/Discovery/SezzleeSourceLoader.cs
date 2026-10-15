using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Sezzlee.AspNetCore.Discovery;

internal sealed class SezzleeSourceLoader(
    SezzleeCatalogProvider catalog,
    IOptions<SezzleeOptions> options,
    TimeProvider time,
    ILogger<SezzleeSourceLoader> logger) : IHostedService, IDisposable
{
    private readonly CancellationTokenSource _stopping = new();
    private Task _running = Task.CompletedTask;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        SezzleeOptions value = options.Value;
        List<(CatalogSources Source, SourceLoadOptions Load)> sources = [];
        if (value.Families.Sources.Count > 0)
        {
            sources.Add((CatalogSources.Families, value.Families));
        }
        if (value.Selection.Provider is not null)
        {
            sources.Add((CatalogSources.Selection, value.Selection.Source));
        }
        (CatalogSources Source, SourceLoadOptions Load)[] blocking =
            [.. sources.Where(s => s.Load.LoadMode == FamilyLoadMode.Blocking)];
        (CatalogSources Source, SourceLoadOptions Load)[] background =
            [.. sources.Where(s => s.Load.LoadMode == FamilyLoadMode.Background)];

        List<Task> running = [];
        if (blocking.Length > 0)
        {
            await catalog.LoadSourcesAsync(Combine(blocking), cancellationToken);
            running.AddRange(blocking.Select(s => RefreshAsync(s.Source, s.Load.RefreshInterval, _stopping.Token)));
        }
        if (background.Length > 0)
        {
            running.Add(Task.Run(() => LoadInBackgroundAsync(background, _stopping.Token), CancellationToken.None));
        }
        _running = Task.WhenAll(running);
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await _stopping.CancelAsync();
        await Task.WhenAny(_running, Task.Delay(Timeout.Infinite, cancellationToken));
    }

    public void Dispose() => _stopping.Dispose();

    private static CatalogSources Combine((CatalogSources Source, SourceLoadOptions Load)[] sources) =>
        sources.Aggregate(CatalogSources.None, (all, s) => all | s.Source);

    private async Task LoadInBackgroundAsync(
        (CatalogSources Source, SourceLoadOptions Load)[] sources, CancellationToken stopping)
    {
        try
        {
            await catalog.LoadSourcesAsync(Combine(sources), stopping);
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "sezzlee {Sources} load failed: {Reason}", Combine(sources), ex.Message);
        }
        await Task.WhenAll(sources.Select(s => RefreshAsync(s.Source, s.Load.RefreshInterval, stopping)));
    }

    private async Task RefreshAsync(CatalogSources source, TimeSpan interval, CancellationToken stopping)
    {
        if (interval <= TimeSpan.Zero)
        {
            return;
        }
        using PeriodicTimer timer = new(interval, time);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping))
            {
                try
                {
                    await catalog.RefreshSourcesAsync(source, stopping);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "sezzlee {Sources} refresh failed: {Reason}", source, ex.Message);
                }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
        }
    }
}
