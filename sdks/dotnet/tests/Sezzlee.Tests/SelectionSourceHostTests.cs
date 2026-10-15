using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;

namespace Sezzlee.Tests;

internal sealed class RecordedLog : ILoggerProvider
{
    private readonly ConcurrentQueue<(LogLevel Level, string Message)> _entries = new();

    public IReadOnlyCollection<(LogLevel Level, string Message)> Entries => _entries;

    public ILogger CreateLogger(string categoryName) => new Sink(_entries);

    public void Dispose()
    {
    }

    private sealed class Sink(ConcurrentQueue<(LogLevel, string)> entries) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            entries.Enqueue((logLevel, formatter(state, exception)));
    }
}

internal sealed class SelectionSourceHarness(WebApplication app, RecordedLog log) : IAsyncDisposable
{
    public WebApplication App { get; } = app;

    public RecordedLog Log { get; } = log;

    public SezzleeCatalogProvider Catalog => App.Services.GetRequiredService<SezzleeCatalogProvider>();

    public string[] Targets => [.. Catalog.Result.Entries
        .Select(e => $"{e.Descriptor.Method} {e.Descriptor.Route}")
        .Order(StringComparer.Ordinal)];

    public string[] Codes => [.. Catalog.Result.Diagnostics.Select(d => d.Code)];

    public CatalogEntry Entry(string route) => Catalog.Result.Entries.Single(e => e.Descriptor.Route == route);

    public ValueTask DisposeAsync() => App.DisposeAsync();
}

internal static class SelectionSourceHost
{
    public static McpSelectionSource Rows(params McpSelectionEntry[] rows) =>
        (_, _) => ValueTask.FromResult<IReadOnlyList<McpSelectionEntry>>(rows);

    public static async Task<SelectionSourceHarness> StartAsync(
        McpSelectionSource source, Action<SezzleeOptions>? configure = null)
    {
        RecordedLog log = new();
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(log);
        builder.Services.AddSezzlee(options =>
        {
            options.Selection.Provide(source);
            configure?.Invoke(options);
        });

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.MapGet("/orders", () => "ok");
        app.MapGet("/reports", () => "ok");
        app.MapGet("/admin/users", () => "ok");
        app.MapGet("/admin/audit", () => "ok");
        app.MapGet("/legacy", () => "ok").WithMetadata(new McpIgnoreAttribute());
        app.MapGet("/public", () => "ok").WithMetadata(new McpToolAttribute
        {
            Name = "public_info",
            Description = "Declared description.",
            Tags = ["declared"],
            SearchTerms = ["declaredterm"],
        });
        app.MapSezzlee("/mcp");
        try
        {
            await app.StartAsync();
        }
        catch
        {
            await app.DisposeAsync();
            throw;
        }
        return new SelectionSourceHarness(app, log);
    }
}

public sealed class SelectionSourceHostTests
{
    private static McpSelectionEntry Include(string route, string method = "GET") => new(method, route, SelectionDefault.Include);

    private static McpSelectionEntry Exclude(string route, string method = "GET") => new(method, route, SelectionDefault.Exclude);

    [Fact]
    public async Task SP1_AnAttributeBeatsAProvidedRowInBothDirections()
    {
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            SelectionSourceHost.Rows(Include("/legacy"), Exclude("/public"), Include("/orders")));

        Assert.Equal(["GET /orders", "GET /public"], host.Targets);
    }

    [Fact]
    public async Task SP2_AProvidedRowBeatsARuleAndTheDefault()
    {
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            SelectionSourceHost.Rows(Include("/admin/users"), Exclude("/orders")),
            options =>
            {
                options.Selection.Default = SelectionDefault.Include;
                options.Selection.Rules.Add(new SelectionRule(SelectionDefault.Exclude, Route: "/admin/**"));
            });

        Assert.Equal(["GET /admin/users", "GET /public", "GET /reports"], host.Targets);
    }

    [Fact]
    public async Task SP3_ARowOverridesNameDescriptionTagsAndSearchTerms_BelowAnAttributeAndAboveTheHooks()
    {
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            SelectionSourceHost.Rows(
                Include("/orders") with
                {
                    Name = "open_orders",
                    Description = "Row description.",
                    Tags = ["row-tag"],
                    SearchTerms = ["rowterm"],
                },
                Include("/reports"),
                Include("/public") with
                {
                    Name = "row_name",
                    Description = "Row description.",
                    Tags = ["row-tag"],
                    SearchTerms = ["rowterm"],
                }),
            options =>
            {
                options.EndpointTags = _ => ["hook-tag"];
                options.EndpointSearchTerms = _ => ["hookterm"];
                options.Description = _ => "Hook description.";
            });

        CatalogEntry orders = host.Entry("/orders");
        Assert.Equal("open_orders", orders.Tool.Name);
        Assert.Equal("Row description.", orders.Descriptor.Description);
        Assert.Equal(["row-tag"], orders.Descriptor.Tags);
        Assert.Equal(["rowterm"], orders.Descriptor.SearchTerms);

        CatalogEntry reports = host.Entry("/reports");
        Assert.Equal("Hook description.", reports.Descriptor.Description);
        Assert.Equal(["hook-tag"], reports.Descriptor.Tags);
        Assert.Equal(["hookterm"], reports.Descriptor.SearchTerms);

        CatalogEntry declared = host.Entry("/public");
        Assert.Equal("public_info", declared.Tool.Name);
        Assert.Equal("Declared description.", declared.Descriptor.Description);
        Assert.Equal(["declared"], declared.Descriptor.Tags);
        Assert.Equal(["declaredterm"], declared.Descriptor.SearchTerms);
    }

    [Fact]
    public async Task SP3a_TheEndpointHooksSeeTheProvidedDescriptionAsDeclared_AndTheDescriptionHookIsNotConsulted()
    {
        List<string?> declared = [];
        bool consulted = false;
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            SelectionSourceHost.Rows(Include("/orders") with { Description = "Row description." }),
            options =>
            {
                options.EndpointTags = info =>
                {
                    lock (declared)
                    {
                        declared.Add(info.Route == "/orders" ? info.Declared : null);
                    }
                    return null;
                };
                options.Description = _ =>
                {
                    consulted = true;
                    return "Hook description.";
                };
            });

        Assert.Contains("Row description.", declared);
        Assert.False(consulted);
        Assert.Equal("Row description.", host.Entry("/orders").Descriptor.Description);
    }

    [Fact]
    public async Task SP3b_RowVocabularyIsCleanedAndReportedLikeADeclaration()
    {
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            SelectionSourceHost.Rows(Include("/orders") with { Tags = ["Dup", "dup"] }));

        Assert.Equal(["Dup"], host.Entry("/orders").Descriptor.Tags);
        Assert.Contains(DiagnosticCodes.DuplicateTag, host.Codes);
    }

    [Fact]
    public async Task SP4_ARowDefectIsTheRowsAlone_AConflictExcludes_AndTheRestApplies()
    {
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            SelectionSourceHost.Rows(
                Exclude("/orders"),
                Include("/nowhere"),
                Include("/reports") with { Name = "from_row" },
                Exclude("/reports"),
                Include(" ", "GET"),
                new McpSelectionEntry("GET", "/admin/audit", (SelectionDefault)7)),
            options =>
            {
                options.Selection.Default = SelectionDefault.Include;
                options.Selection.Rules.Add(new SelectionRule(SelectionDefault.Exclude, Route: "/admin/**"));
            });

        Assert.Equal(["GET /public"], host.Targets);
        Assert.Single(host.Codes, DiagnosticCodes.SelectionTargetUnknown);
        Assert.Single(host.Codes, DiagnosticCodes.SelectionEntryConflict);
        Assert.Equal(2, host.Codes.Count(code => code == DiagnosticCodes.SelectionEntryRejected));
        Assert.All(
            host.Catalog.Result.Diagnostics.Where(d => d.Code.StartsWith("selection_", StringComparison.Ordinal)),
            d => Assert.Equal(CatalogSeverity.Warning, DiagnosticCodes.SeverityOf(d.Code)));
        host.Catalog.EnsureValid();
    }

    [Fact]
    public async Task SP4a_AnInvalidOverrideLosesOnlyItself_AndTheDecisionStays()
    {
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            SelectionSourceHost.Rows(
                Include("/orders") with { Name = "Bad Name", Description = "  ", Tags = ["row-tag"] }),
            options => options.EndpointTags = _ => ["hook-tag"]);

        CatalogEntry orders = host.Entry("/orders");
        Assert.NotEqual("Bad Name", orders.Tool.Name);
        Assert.NotEqual("  ", orders.Descriptor.Description);
        Assert.Equal(["row-tag"], orders.Descriptor.Tags);
        Assert.Equal(2, host.Codes.Count(code => code == DiagnosticCodes.SelectionEntryRejected));
        host.Catalog.EnsureValid();
    }

    [Fact]
    public async Task SP4b_RowsThatRepeatOneDecisionAreNotAConflict()
    {
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            SelectionSourceHost.Rows(Include("/orders"), Include("/orders", "get")));

        Assert.Contains("GET /orders", host.Targets);
        Assert.DoesNotContain(DiagnosticCodes.SelectionEntryConflict, host.Codes);
    }

    [Fact]
    public async Task SP5_BeforeTheFirstLoadAnUnmarkedEndpointIsNotExposed_AndJoinsWhenTheSourceReturns()
    {
        TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            async (_, _) =>
            {
                await release.Task;
                return [Exclude("/orders")];
            },
            options =>
            {
                options.Selection.Default = SelectionDefault.Include;
                options.Selection.Source.LoadMode = FamilyLoadMode.Background;
            });
        SezzleeOpenApiExtensions published = host.App.Services.GetRequiredService<SezzleeOpenApiExtensions>();

        Assert.Equal(["GET /public"], host.Targets);
        Assert.Contains(DiagnosticCodes.SelectionNotLoaded, host.Codes);
        Assert.False(published.Current.Operations["GET /reports"]["tool"]!.GetValue<bool>());

        TaskCompletionSource rebuilt = new(TaskCreationOptions.RunContinuationsAsynchronously);
        using IDisposable _ = host.Catalog.GetChangeToken().RegisterChangeCallback(_ => rebuilt.TrySetResult(), null);
        release.SetResult();
        await rebuilt.Task.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(["GET /admin/audit", "GET /admin/users", "GET /public", "GET /reports"], host.Targets);
        Assert.DoesNotContain(DiagnosticCodes.SelectionNotLoaded, host.Codes);
        Assert.True(published.Current.Operations["GET /reports"]["tool"]!.GetValue<bool>());
    }

    [Fact]
    public async Task SP5b_ASourceThatNeverReturned_KeepsEndpointsUnexposed_AndIsLoggedAsAWarning()
    {
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            (_, _) => throw new InvalidOperationException("database unreachable"),
            options => options.Selection.Default = SelectionDefault.Include);

        Assert.Equal(["GET /public"], host.Targets);
        CatalogDiagnostic notLoaded = Assert.Single(
            host.Catalog.Result.Diagnostics, d => d.Code == DiagnosticCodes.SelectionNotLoaded);
        Assert.Contains("database unreachable", notLoaded.Message, StringComparison.Ordinal);

        host.Catalog.WarmUp();
        Assert.Contains(host.Log.Entries, e =>
            e.Level == LogLevel.Warning && e.Message.Contains("selection_not_loaded", StringComparison.Ordinal));
    }

    [Fact]
    public async Task SP5c_InBackgroundMode_ThePendingLoadIsLoggedAsInformation()
    {
        TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            async (_, _) =>
            {
                await release.Task;
                return [];
            },
            options => options.Selection.Source.LoadMode = FamilyLoadMode.Background);

        host.Catalog.WarmUp();
        release.SetResult();

        Assert.Contains(host.Log.Entries, e =>
            e.Level == LogLevel.Information && e.Message.Contains("selection_not_loaded", StringComparison.Ordinal));
        Assert.DoesNotContain(host.Log.Entries, e =>
            e.Level >= LogLevel.Warning && e.Message.Contains("selection_not_loaded", StringComparison.Ordinal));
    }

    [Fact]
    public async Task SP6_ARefreshWithEqualRowsChangesNothing_AndOneWithNewRowsRebuilds()
    {
        int loads = 0;
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            (_, _) =>
            {
                loads += 1;
                IReadOnlyList<McpSelectionEntry> rows = loads < 3
                    ? [Include("/orders") with { Tags = ["a"], SearchTerms = ["b"] }]
                    : [Include("/orders") with { Tags = ["a"], SearchTerms = ["b"] }, Include("/reports")];
                return ValueTask.FromResult(rows);
            });
        long generation = host.Catalog.Generation;

        await host.Catalog.RefreshSourcesAsync(CatalogSources.Selection, CancellationToken.None);
        Assert.Equal(generation, host.Catalog.Generation);
        Assert.Equal(["GET /orders", "GET /public"], host.Targets);

        await host.Catalog.RefreshSourcesAsync(CatalogSources.Selection, CancellationToken.None);
        Assert.Equal(generation + 1, host.Catalog.Generation);
        Assert.Equal(["GET /orders", "GET /public", "GET /reports"], host.Targets);
    }

    [Fact]
    /// <remarks>
    /// Guard: the source holds its thread until the test has asserted, rather than sleeping for a
    /// fixed time. Under thread-pool pressure the deadline's timer callback can run after a fixed
    /// sleep ends, the source then counts as returned in time, and the test fails on a slow runner.
    /// </remarks>
    public async Task SP7_ASourceThatOutlivesItsDeadline_IsReportedAsATimeout_NamingTheOption()
    {
        using ManualResetEventSlim held = new();
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            (_, _) =>
            {
                held.Wait(TimeSpan.FromSeconds(30));
                return ValueTask.FromResult<IReadOnlyList<McpSelectionEntry>>([Include("/orders")]);
            },
            options => options.Selection.Source.LoadTimeout = TimeSpan.FromMilliseconds(50));

        try
        {
            CatalogDiagnostic notLoaded = Assert.Single(
                host.Catalog.Result.Diagnostics, d => d.Code == DiagnosticCodes.SelectionNotLoaded);

            Assert.Contains("timeout", notLoaded.Message, StringComparison.Ordinal);
            Assert.Contains("Selection.Source.LoadTimeout", notLoaded.Message, StringComparison.Ordinal);
        }
        finally
        {
            held.Set();
        }
    }

    [Fact]
    public async Task SP8_WithOnFailureFatal_ASourceThatNeverReturnedStopsStartup()
    {
        SezzleeCatalogException refused = await Assert.ThrowsAsync<SezzleeCatalogException>(() =>
            SelectionSourceHost.StartAsync(
                (_, _) => throw new InvalidOperationException("database unreachable"),
                options => options.Selection.Source.OnFailure = FamilyLoadFailure.Fatal));

        Assert.Equal(DiagnosticCodes.SelectionSourceFailed, refused.Code);
        Assert.Contains("database unreachable", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SP9_ProvidedDecisionsAndNamesArePublishedAsXSezzleeMarkers()
    {
        await using SelectionSourceHarness host = await SelectionSourceHost.StartAsync(
            SelectionSourceHost.Rows(
                Include("/orders") with { Name = "open_orders", SearchTerms = ["rowterm"] },
                Exclude("/reports")));

        IReadOnlyDictionary<string, JsonObject> operations =
            host.App.Services.GetRequiredService<SezzleeOpenApiExtensions>().Current.Operations;

        Assert.True(operations["GET /orders"]["tool"]!.GetValue<bool>());
        Assert.Equal("open_orders", operations["GET /orders"]["toolName"]!.GetValue<string>());
        Assert.Equal("rowterm", operations["GET /orders"]["searchTerms"]!.AsArray().Single()!.GetValue<string>());
        Assert.False(operations["GET /reports"]["tool"]!.GetValue<bool>());
    }
}

public sealed class SelectionSourceWithFamiliesHostTests : FamilyHost
{
    private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

    protected override IReadOnlyList<Func<IReadOnlyList<McpFamilyMember>>> Answers => [() => [Members.Balances]];

    protected override void Map(Microsoft.AspNetCore.Builder.WebApplication app) =>
        app.MapGet("/plain", () => "ok");

    protected override void Configure(IMvcBuilder mvc)
    {
        base.Configure(mvc);
        mvc.Services.Configure<SezzleeOptions>(options =>
        {
            options.Selection.Provide(async (_, _) =>
            {
                await _release.Task;
                return [new McpSelectionEntry("GET", "/plain", SelectionDefault.Include)];
            });
            options.Selection.Source.LoadMode = FamilyLoadMode.Background;
        });
    }

    private string[] Routes => [.. Catalog.Result.Entries.Select(e => e.Descriptor.Route).Order(StringComparer.Ordinal)];

    [Fact]
    public async Task SF1_OneLoaderDrivesBothSources_EachInItsOwnMode()
    {
        Assert.Equal(["list_customer_balances", "list_orders"], Names);
        Assert.DoesNotContain("/plain", Routes);

        TaskCompletionSource rebuilt = new(TaskCreationOptions.RunContinuationsAsynchronously);
        using IDisposable _ = Catalog.GetChangeToken().RegisterChangeCallback(_ => rebuilt.TrySetResult(), null);
        _release.SetResult();
        await rebuilt.Task.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Contains("/plain", Routes);
        Assert.Contains("list_customer_balances", Names);
    }
}
