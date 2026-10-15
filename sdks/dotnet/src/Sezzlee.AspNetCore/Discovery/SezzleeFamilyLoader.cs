using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Sezzlee.AspNetCore.Discovery;

internal sealed class SezzleeFamilyLoader(
    SezzleeCatalogProvider catalog,
    IOptions<SezzleeOptions> options,
    TimeProvider time,
    ILogger<SezzleeFamilyLoader> logger) : IHostedService, IDisposable
{
    private readonly CancellationTokenSource _stopping = new();
    private Task _running = Task.CompletedTask;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        ToolFamilyOptions families = options.Value.Families;
        if (families.Sources.Count == 0)
        {
            return;
        }
        if (families.LoadMode == FamilyLoadMode.Blocking)
        {
            await catalog.LoadFamiliesAsync(cancellationToken);
            _running = RefreshAsync(families.RefreshInterval, _stopping.Token);
            return;
        }
        _running = Task.Run(() => LoadInBackgroundAsync(families.RefreshInterval, _stopping.Token), CancellationToken.None);
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await _stopping.CancelAsync();
        await Task.WhenAny(_running, Task.Delay(Timeout.Infinite, cancellationToken));
    }

    public void Dispose() => _stopping.Dispose();

    private async Task LoadInBackgroundAsync(TimeSpan interval, CancellationToken stopping)
    {
        try
        {
            await catalog.LoadFamiliesAsync(stopping);
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "sezzlee family load failed: {Reason}", ex.Message);
        }
        await RefreshAsync(interval, stopping);
    }

    private async Task RefreshAsync(TimeSpan interval, CancellationToken stopping)
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
                    await catalog.RefreshFamiliesAsync(stopping);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "sezzlee family refresh failed: {Reason}", ex.Message);
                }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
        }
    }
}
