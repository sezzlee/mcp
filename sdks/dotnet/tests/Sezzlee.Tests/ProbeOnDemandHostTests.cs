using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Protocol;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Tools;
using Sezzlee.AspNetCore.Visibility.Probe;
using static Sezzlee.Tests.VisibilityHost;

namespace Sezzlee.Tests;

public sealed class FleetControllers
{
    [ApiController]
    [Route("/fleet")]
    public sealed class Fleet : ControllerBase
    {
        [HttpPost("dispatch/{methodId}")]
        [McpTool(Description = "Runs a fleet method by its id.")]
        [McpToolFamily("methodId", Source = "fleet")]
        public IActionResult Dispatch(string methodId, [FromBody] JsonElement body) => Ok(new { methodId });
    }
}

internal sealed class FleetProbes
{
    private readonly ConcurrentDictionary<string, int> _hits = new(StringComparer.Ordinal);

    public Func<string, int?> Answer { get; set; } = _ => null;

    public int Total => _hits.Values.Sum();

    public int HitsOf(int member) => _hits.GetValueOrDefault(KeyOf(member));

    public void Record(string key) => _hits.AddOrUpdate(key, 1, (_, count) => count + 1);

    public static string KeyOf(int member) => $"k-{member:000}";

    public static string NameOf(int member) => $"member_{member:000}";
}

internal sealed class WarningLog : ILoggerProvider
{
    private readonly ConcurrentQueue<string> _warnings = new();

    public IReadOnlyCollection<string> Warnings => _warnings;

    public ILogger CreateLogger(string categoryName) => new Sink(_warnings);

    public void Dispose()
    {
    }

    private sealed class Sink(ConcurrentQueue<string> warnings) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning;

        public void Log<TState>(
            LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (logLevel == LogLevel.Warning)
            {
                warnings.Enqueue(formatter(state, exception));
            }
        }
    }
}

internal sealed record Fleet(Harness Host, FleetProbes Probes, WarningLog Log) : IAsyncDisposable
{
    public ValueTask DisposeAsync() => Host.DisposeAsync();
}

public sealed class ProbeOnDemandHostTests
{
    private const int Members = 100;
    private const int DeniedPrefix = 60;

    private static int? DenyFirstSixty(string key) =>
        int.Parse(key.AsSpan(2), System.Globalization.CultureInfo.InvariantCulture) < DeniedPrefix
            ? StatusCodes.Status403Forbidden
            : null;

    private static async Task<Fleet> StartAsync(
        Action<SezzleeOptions>? configure = null,
        Action<IServiceCollection>? services = null,
        int members = Members)
    {
        FleetProbes probes = new();
        WarningLog log = new();
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(log);
        builder.Services.AddControllers().ConfigureApplicationPartManager(manager =>
            manager.FeatureProviders.Add(new ExplicitControllers(typeof(FleetControllers.Fleet))));
        services?.Invoke(builder.Services);
        builder.Services.AddSezzlee(options =>
        {
            options.Visibility.Tier = VisibilityTier.Probe;
            options.Families.Provide("fleet", (_, _) => ValueTask.FromResult<IReadOnlyList<McpFamilyMember>>(
            [
                .. Enumerable.Range(0, members).Select(index => new McpFamilyMember(
                    FleetProbes.KeyOf(index),
                    FleetProbes.NameOf(index),
                    $"Handles fleet case {index:000}.",
                    new JsonObject { ["type"] = "object", ["properties"] = new JsonObject() })),
            ]));
            configure?.Invoke(options);
        });

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.Use(async (context, next) =>
        {
            const string prefix = "/fleet/dispatch";
            if (context.IsSezzleeProbe() && context.Request.Path.StartsWithSegments(prefix, out PathString rest))
            {
                string key = rest.Value!.TrimStart('/');
                probes.Record(key);
                if (probes.Answer(key) is { } status)
                {
                    context.Response.StatusCode = status;
                    return;
                }
            }
            await next();
        });
        app.MapControllers();
        app.MapSezzlee("/mcp");
        await app.StartAsync();
        Harness host = new(app, app.Services.GetRequiredService<SezzleeDispatcher>(), new ProbeCounter());
        return new Fleet(host, probes, log);
    }

    private static async Task<(string[] Names, string[] Uncertain)> PageAsync(SezzleeMetaTools tools, int limit)
    {
        using JsonDocument document = JsonDocument.Parse(TextOf(await tools.SearchTools("", limit)));
        JsonElement[] cards = [.. document.RootElement.GetProperty("results").EnumerateArray().Select(card => card.Clone())];
        return (
            [.. cards.Select(card => card.GetProperty("name").GetString()!)],
            [.. cards
                .Where(card => card.TryGetProperty("authUncertain", out JsonElement flag) && flag.GetBoolean())
                .Select(card => card.GetProperty("name").GetString()!)]);
    }

    private static string[] Range(int from, int count) =>
        [.. Enumerable.Range(from, count).Select(FleetProbes.NameOf)];

    [Fact]
    public async Task PR1_ASmallPageIsFilledWithAllowedToolsFoundFarBeyondTheFirstCandidates()
    {
        await using Fleet fleet = await StartAsync(o => o.Visibility.MaxProbesPerSearch = 200);
        fleet.Probes.Answer = DenyFirstSixty;

        (string[] names, string[] uncertain) = await PageAsync(fleet.Host.ToolsFor("caller"), 5);

        Assert.Equal(Range(DeniedPrefix, 5), names);
        Assert.Empty(uncertain);
        Assert.InRange(fleet.Probes.Total, DeniedPrefix + 5, DeniedPrefix + 5 + 4);
    }

    [Theory]
    [InlineData(UnknownVisibility.Show)]
    [InlineData(UnknownVisibility.Hide)]
    public async Task PR2_TheCapEndsProbing_ThePageReturnsAsItStands_AndOneWarningNamesTheCap(UnknownVisibility onUnknown)
    {
        await using Fleet fleet = await StartAsync(o => o.Visibility.OnUnknown = onUnknown);
        fleet.Probes.Answer = DenyFirstSixty;

        (string[] names, string[] uncertain) = await PageAsync(fleet.Host.ToolsFor("caller"), 5);

        Assert.Equal(50, fleet.Probes.Total);
        Assert.Equal(onUnknown == UnknownVisibility.Show ? Range(50, 5) : [], names);
        Assert.Equal(names, uncertain);
        string warning = Assert.Single(fleet.Log.Warnings, line => line.Contains("MaxProbesPerSearch", StringComparison.Ordinal));
        Assert.Contains("50", warning, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PR3_AVerdictServedFromTheCacheCostsNoBudget_SoTheNextSearchReachesFurther()
    {
        await using Fleet fleet = await StartAsync(o => o.Visibility.OnUnknown = UnknownVisibility.Hide);
        fleet.Probes.Answer = DenyFirstSixty;
        SezzleeMetaTools tools = fleet.Host.ToolsFor("caller");

        (string[] first, _) = await PageAsync(tools, 5);
        (string[] second, _) = await PageAsync(tools, 5);

        Assert.Empty(first);
        Assert.Equal(Range(DeniedPrefix, 5), second);
        Assert.Equal(1, fleet.Probes.HitsOf(0));
        Assert.Equal(1, fleet.Probes.HitsOf(49));
    }

    [Fact]
    public async Task PR4_ZeroMaxProbesPerSearch_NeverProbesFromASearch()
    {
        await using Fleet fleet = await StartAsync(o => o.Visibility.MaxProbesPerSearch = 0);
        fleet.Probes.Answer = DenyFirstSixty;

        (string[] names, string[] uncertain) = await PageAsync(fleet.Host.ToolsFor("caller"), 5);

        Assert.Equal(Range(0, 5), names);
        Assert.Equal(names, uncertain);
        Assert.Equal(0, fleet.Probes.Total);
        Assert.DoesNotContain(fleet.Log.Warnings, line => line.Contains("MaxProbesPerSearch", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(StatusCodes.Status429TooManyRequests)]
    [InlineData(StatusCodes.Status500InternalServerError)]
    [InlineData(StatusCodes.Status503ServiceUnavailable)]
    [InlineData(StatusCodes.Status409Conflict)]
    public async Task PR5_ARefusalThatIsNotAnAuthorizationAnswer_IsUnknownAndAskedAgainNextSearch(int status)
    {
        await using Fleet fleet = await StartAsync(members: 3);
        fleet.Probes.Answer = key => key == FleetProbes.KeyOf(0) ? status : null;
        SezzleeMetaTools tools = fleet.Host.ToolsFor("caller");

        (string[] first, string[] firstUncertain) = await PageAsync(tools, 10);
        (string[] second, _) = await PageAsync(tools, 10);

        Assert.Equal(Range(0, 3), first);
        Assert.Equal([FleetProbes.NameOf(0)], firstUncertain);
        Assert.Equal(first, second);
        Assert.Equal(2, fleet.Probes.HitsOf(0));
        Assert.Equal(1, fleet.Probes.HitsOf(1));
        Assert.True(fleet.Host.App.Services.GetRequiredService<IProbeEvaluator>()
            .CanProbe(fleet.Host.App.Services.GetRequiredService<SezzleeCatalogProvider>().Find(FleetProbes.NameOf(0))!));
    }

    [Theory]
    [InlineData(StatusCodes.Status404NotFound)]
    [InlineData(StatusCodes.Status200OK)]
    public async Task PR6_AnAnswerThatShowsTheProbeCannotWork_StopsProbingThatTool(int status)
    {
        await using Fleet fleet = await StartAsync(members: 3);
        fleet.Probes.Answer = key => key == FleetProbes.KeyOf(0) ? status : null;
        SezzleeMetaTools tools = fleet.Host.ToolsFor("caller");

        await PageAsync(tools, 10);
        await PageAsync(tools, 10);

        Assert.Equal(1, fleet.Probes.HitsOf(0));
        Assert.False(fleet.Host.App.Services.GetRequiredService<IProbeEvaluator>()
            .CanProbe(fleet.Host.App.Services.GetRequiredService<SezzleeCatalogProvider>().Find(FleetProbes.NameOf(0))!));
    }

    [Fact]
    public async Task PR7_AProbeVerdictIsCachedPerCaller()
    {
        await using Fleet fleet = await StartAsync(members: 3);
        SezzleeMetaTools alice = fleet.Host.ToolsFor("alice");
        SezzleeMetaTools bob = fleet.Host.ToolsFor("bob");

        await PageAsync(alice, 10);
        await PageAsync(alice, 10);
        Assert.Equal(1, fleet.Probes.HitsOf(1));

        await PageAsync(bob, 10);
        Assert.Equal(2, fleet.Probes.HitsOf(1));
    }

    [Fact]
    public async Task PR8_LoadToolProbesOnlyTheNamedTool()
    {
        await using Fleet fleet = await StartAsync();
        fleet.Probes.Answer = DenyFirstSixty;
        SezzleeMetaTools tools = fleet.Host.ToolsFor("caller");

        CallToolResult allowed = await tools.LoadTool(FleetProbes.NameOf(70), CancellationToken.None);
        CallToolResult denied = await tools.LoadTool(FleetProbes.NameOf(10), CancellationToken.None);
        CallToolResult missing = await tools.LoadTool("no_such_member", CancellationToken.None);

        Assert.NotEqual(true, allowed.IsError);
        Assert.True(denied.IsError);
        Assert.Contains("unknown_tool", TextOf(denied), StringComparison.Ordinal);
        Assert.Contains("unknown_tool", TextOf(missing), StringComparison.Ordinal);
        Assert.Equal(2, fleet.Probes.Total);
        Assert.Equal(1, fleet.Probes.HitsOf(70));
        Assert.Equal(1, fleet.Probes.HitsOf(10));
    }
}
