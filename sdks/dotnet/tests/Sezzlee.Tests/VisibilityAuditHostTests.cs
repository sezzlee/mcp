using System.Collections.Concurrent;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Caching;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Tools;
using Sezzlee.AspNetCore.Testing;
using Sezzlee.AspNetCore.Visibility;
using Sezzlee.AspNetCore.Visibility.Probe;
using static Sezzlee.Tests.VisibilityHost;

namespace Sezzlee.Tests;

internal sealed class AuditBackend
{
    private readonly ConcurrentDictionary<string, int> _probed = new(StringComparer.Ordinal);
    private int _inFlight;
    private int _peak;

    public Func<string, string, int?> Answer { get; set; } = (_, _) => null;

    public TimeSpan ProbeDelay { get; set; }

    public int Peak => Volatile.Read(ref _peak);

    public int ProbeTotal => _probed.Values.Sum();

    public IEnumerable<string> ProbedActions => _probed.Keys;

    public async Task RecordProbeAsync(string action)
    {
        _probed.AddOrUpdate(action, 1, (_, count) => count + 1);
        int now = Interlocked.Increment(ref _inFlight);
        int seen;
        while (now > (seen = Volatile.Read(ref _peak)) && Interlocked.CompareExchange(ref _peak, now, seen) != seen)
        {
        }
        await Task.Delay(ProbeDelay);
        Interlocked.Decrement(ref _inFlight);
    }
}

[AttributeUsage(AttributeTargets.Class)]
public sealed class AuditGateAttribute : Attribute, IAsyncAuthorizationFilter
{
    public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
    {
        AuditBackend backend = context.HttpContext.RequestServices.GetRequiredService<AuditBackend>();
        string action = ((ControllerActionDescriptor)context.ActionDescriptor).ActionName;
        string user = context.HttpContext.Request.Headers.Authorization.ToString()
            .Replace("Bearer ", string.Empty, StringComparison.Ordinal);
        if (context.HttpContext.IsSezzleeProbe())
        {
            await backend.RecordProbeAsync(action);
        }
        if (backend.Answer(user, action) is { } status)
        {
            context.Result = new StatusCodeResult(status);
        }
    }
}

public sealed class AuditControllers
{
    [ApiController]
    [Route("/reports")]
    [AuditGate]
    public sealed class Reports : ControllerBase
    {
        [HttpGet("payroll")]
        [McpTool(Name = "payroll_report", Description = "Payroll totals.")]
        public IActionResult Payroll() => Ok();

        [HttpGet("sales")]
        [McpTool(Name = "sales_report", Description = "Sales by region.")]
        public IActionResult Sales() => Ok();

        [HttpGet("notes")]
        [McpTool(Name = "open_notes", Description = "Shared notes.")]
        public IActionResult Notes() => Ok();

        [HttpGet("audit")]
        [McpTool(Name = "audit_log", Description = "Audit trail.")]
        public IActionResult AuditTrail() => Ok();

        [HttpGet("throttled")]
        [McpTool(Name = "throttled_report", Description = "A rate limited one.")]
        public IActionResult Throttled() => Ok();

        [HttpGet("dispatch")]
        [McpTool(Name = "method_dispatch", Description = "Dispatches a method.")]
        public IActionResult Dispatch() =>
            Request.Headers.Authorization == "Bearer bob" ? StatusCode(StatusCodes.Status403Forbidden) : Ok();
    }
}

internal sealed class CountingCache(ISezzleeCache inner) : ISezzleeCache
{
    private int _reads;
    private int _writes;

    public int Reads => Volatile.Read(ref _reads);

    public int Writes => Volatile.Read(ref _writes);

    public ValueTask<string?> GetAsync(CacheKey key, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _reads);
        return inner.GetAsync(key, cancellationToken);
    }

    public ValueTask SetAsync(CacheKey key, string value, TimeSpan lifetime, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _writes);
        return inner.SetAsync(key, value, lifetime, cancellationToken);
    }

    public ValueTask RemoveScopeAsync(string scopeKey, CancellationToken cancellationToken) =>
        inner.RemoveScopeAsync(scopeKey, cancellationToken);

    public ValueTask RemoveTagAsync(string tag, CancellationToken cancellationToken) =>
        inner.RemoveTagAsync(tag, cancellationToken);

    public ValueTask ClearAsync(CancellationToken cancellationToken) => inner.ClearAsync(cancellationToken);
}

public sealed class VisibilityAuditHostTests
{
    private static readonly AuditCaller Alice = AuditCaller.WithHeaders("alice", ("Authorization", "Bearer alice"));
    private static readonly AuditCaller Bob = AuditCaller.WithHeaders("bob", ("Authorization", "Bearer bob"));

    private sealed record Audited(WebApplication App, AuditBackend Backend, RecordingAuthorizer Authorizer) : IAsyncDisposable
    {
        public SezzleeMetaTools ToolsFor(string token) =>
            new Harness(App, App.Services.GetRequiredService<SezzleeDispatcher>(), new ProbeCounter()).ToolsFor(token);

        public async ValueTask DisposeAsync()
        {
            await App.StopAsync();
            await App.DisposeAsync();
        }
    }

    private static int? Forbids(string user, string action) =>
        (user, action) switch
        {
            ("bob", "Payroll" or "AuditTrail") => StatusCodes.Status403Forbidden,
            (_, "Throttled") => StatusCodes.Status429TooManyRequests,
            _ => null,
        };

    private static VisibilityDecision Hides(string user, McpToolInfo tool) =>
        (user, tool.Name) switch
        {
            ("alice", "sales_report") or ("bob", "audit_log" or "method_dispatch") => VisibilityDecision.Deny,
            _ => VisibilityDecision.Allow,
        };

    private static async Task<Audited> StartAsync(
        Func<string, string, int?>? backendAnswer = null,
        Func<string, McpToolInfo, VisibilityDecision>? hides = null,
        Action<SezzleeOptions>? configure = null,
        Action<IServiceCollection>? services = null,
        TimeSpan probeDelay = default)
    {
        AuditBackend backend = new() { Answer = backendAnswer ?? ((_, _) => null), ProbeDelay = probeDelay };
        Func<string, McpToolInfo, VisibilityDecision> rule = hides ?? ((_, _) => VisibilityDecision.Allow);
        RecordingAuthorizer authorizer = new(rule);
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddControllers().ConfigureApplicationPartManager(manager =>
            manager.FeatureProviders.Add(new ExplicitControllers(typeof(AuditControllers.Reports))));
        builder.Services.AddSingleton(backend);
        builder.Services.AddSingleton<IToolAuthorizer>(authorizer);
        services?.Invoke(builder.Services);
        builder.Services.AddSezzlee(configure);

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.MapControllers();
        app.MapSezzlee("/mcp");
        await app.StartAsync();
        return new Audited(app, backend, authorizer);
    }

    [Fact]
    public async Task AUD1_ReportsEachWayAHostsVisibilityCanDisagreeWithItsPipeline()
    {
        await using Audited host = await StartAsync(Forbids, Hides);

        VisibilityAuditReport report = await SezzleeVisibilityAudit.RunAsync(host.App.Services, [Alice, Bob]);

        Assert.Equal(
            [
                ("alice", "sales_report", VisibilityAuditKind.HiddenButAllowed),
                ("alice", "throttled_report", VisibilityAuditKind.NotComparable),
                ("bob", "payroll_report", VisibilityAuditKind.ListedButDenied),
                ("bob", "throttled_report", VisibilityAuditKind.NotComparable),
                ("bob", "method_dispatch", VisibilityAuditKind.HiddenButAllowed),
            ],
            report.Findings.Select(finding => (finding.Caller, finding.Tool, finding.Kind)));
        Assert.All(
            report.Findings.Where(finding => finding.Kind == VisibilityAuditKind.NotComparable),
            finding => Assert.Contains("inconclusive", finding.Reason, StringComparison.Ordinal));
        Assert.All(
            report.Findings.Where(finding => finding.Kind != VisibilityAuditKind.NotComparable),
            finding => Assert.Null(finding.Reason));
        Assert.Equal(
            new Dictionary<VisibilityAuditKind, int>
            {
                [VisibilityAuditKind.ListedButDenied] = 1,
                [VisibilityAuditKind.HiddenButAllowed] = 2,
                [VisibilityAuditKind.NotComparable] = 2,
                [VisibilityAuditKind.Excluded] = 0,
            },
            report.Counts);
        Assert.Equal((2, 6, 12, 7, 10), (report.Callers, report.Tools, report.Total, report.Consistent, report.Compared));
    }

    [Fact]
    public async Task AUD2_AToolWhoseHandlerDecidesAccess_ShowsAsHiddenButAllowed_BecauseTheProbeStopsBeforeTheHandler()
    {
        await using Audited host = await StartAsync(hides: Hides);
        using HttpClient client = host.App.GetTestClient();
        using HttpRequestMessage direct = new(HttpMethod.Get, "/reports/dispatch");
        direct.Headers.Authorization = new("Bearer", "bob");
        Assert.Equal(StatusCodes.Status403Forbidden, (int)(await client.SendAsync(direct)).StatusCode);

        VisibilityAuditReport report = await SezzleeVisibilityAudit.RunAsync(host.App.Services, [Bob]);

        VisibilityAuditFinding finding = Assert.Single(report.Findings, f => f.Tool == "method_dispatch");
        Assert.Equal(VisibilityAuditKind.HiddenButAllowed, finding.Kind);
    }

    [Fact]
    public async Task AUD3_EnsureConsistentThrowsOneGroupedMessage_AndTheExceptionCarriesTheReport()
    {
        await using Audited host = await StartAsync(
            (user, action) => user == "bob" && action is "Payroll" or "AuditTrail" ? StatusCodes.Status403Forbidden : null,
            (user, tool) => user == "alice" && tool.Name == "sales_report" ? VisibilityDecision.Deny : VisibilityDecision.Allow);
        VisibilityAuditReport report = await SezzleeVisibilityAudit.RunAsync(host.App.Services, [Alice, Bob]);

        VisibilityAuditException thrown = Assert.Throws<VisibilityAuditException>(report.EnsureConsistent);

        Assert.Same(report, thrown.Report);
        Assert.Equal(
            string.Join(
                '\n',
                "Visibility audit: 3 of 12 caller and tool pairs are not consistent (2 callers, 6 tools, 0 excluded).",
                string.Empty,
                "ListedButDenied (2): listed by search_tools and load_tool, but the real pipeline answers 401 or 403",
                "  bob: payroll_report",
                "  bob: audit_log",
                string.Empty,
                "HiddenButAllowed (1): hidden by search_tools and load_tool, but the real pipeline lets the caller through",
                "  alice: sales_report"),
            thrown.Message);
    }

    [Fact]
    public async Task AUD4_AConsistentSetupPassesEnsureConsistent()
    {
        Func<string, string, int?> forbids = (user, action) =>
            user == "bob" && action is "Payroll" or "AuditTrail" ? StatusCodes.Status403Forbidden : null;
        await using Audited host = await StartAsync(
            forbids,
            (user, tool) => user == "bob" && tool.Name is "payroll_report" or "audit_log"
                ? VisibilityDecision.Deny
                : VisibilityDecision.Allow);

        VisibilityAuditReport report = await SezzleeVisibilityAudit.RunAsync(host.App.Services, [Alice, Bob]);

        report.EnsureConsistent();
        Assert.Empty(report.Findings);
        Assert.Equal((12, 12), (report.Consistent, report.Compared));
    }

    [Fact]
    public async Task AUD5_ANotComparablePairFailsEnsureConsistent_WithItsReasonInTheMessage()
    {
        await using Audited host = await StartAsync(Forbids, (user, tool) =>
            user == "bob" && tool.Name is "payroll_report" or "audit_log" ? VisibilityDecision.Deny : VisibilityDecision.Allow);
        VisibilityAuditReport report = await SezzleeVisibilityAudit.RunAsync(host.App.Services, [Alice]);

        VisibilityAuditException thrown = Assert.Throws<VisibilityAuditException>(report.EnsureConsistent);

        Assert.StartsWith(
            "Visibility audit: 1 of 6 caller and tool pairs are not consistent (1 callers, 6 tools, 0 excluded).\n\n"
            + "NotComparable (1): the probe could not judge the tool, so nothing was compared\n"
            + "  alice: throttled_report - the probe was inconclusive:",
            thrown.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task AUD6_AnExcludedToolIsReportedForEveryCaller_AndDoesNotFailEnsureConsistent()
    {
        await using Audited host = await StartAsync(hides: Hides);

        VisibilityAuditReport report = await SezzleeVisibilityAudit.RunAsync(
            host.App.Services,
            [Alice, Bob],
            new VisibilityAuditOptions { Exclude = tool => tool.Name == "method_dispatch" });

        Assert.Equal(
            [
                ("alice", "sales_report", VisibilityAuditKind.HiddenButAllowed),
                ("alice", "method_dispatch", VisibilityAuditKind.Excluded),
                ("bob", "audit_log", VisibilityAuditKind.HiddenButAllowed),
                ("bob", "method_dispatch", VisibilityAuditKind.Excluded),
            ],
            report.Findings.Select(finding => (finding.Caller, finding.Tool, finding.Kind)));
        Assert.DoesNotContain("method_dispatch", host.Backend.ProbedActions);
        Assert.Equal(2, report.Counts[VisibilityAuditKind.Excluded]);
        Assert.Equal((12, 8, 10), (report.Total, report.Consistent, report.Compared));

        VisibilityAuditReport onlyExcluded = await SezzleeVisibilityAudit.RunAsync(
            host.App.Services,
            [AuditCaller.WithHeaders("carol", ("Authorization", "Bearer carol"))],
            new VisibilityAuditOptions { Exclude = tool => tool.Name == "method_dispatch" });
        onlyExcluded.EnsureConsistent();
    }

    [Fact]
    public async Task AUD7_EveryToolIsProbedForEveryCaller_WhateverTheSearchCapOrTier()
    {
        await using Audited host = await StartAsync(configure: options =>
        {
            options.Visibility.MaxProbesPerSearch = 1;
            options.Visibility.Tier = VisibilityTier.Declarative;
        });

        VisibilityAuditReport report = await SezzleeVisibilityAudit.RunAsync(host.App.Services, [Alice, Bob]);

        Assert.Equal(12, report.Consistent);
        Assert.Equal(12, host.Backend.ProbeTotal);
        Assert.Equal(["AuditTrail", "Dispatch", "Notes", "Payroll", "Sales", "Throttled"], host.Backend.ProbedActions.Order(StringComparer.Ordinal));
    }

    [Theory]
    [InlineData(2, 2)]
    [InlineData(null, 4)]
    public async Task AUD8_NoMoreProbesRunAtOnceThanTheConcurrencyAllows_FourByDefault(int? concurrency, int peak)
    {
        await using Audited host = await StartAsync(probeDelay: TimeSpan.FromMilliseconds(25));
        VisibilityAuditOptions options = concurrency is { } limit
            ? new VisibilityAuditOptions { Concurrency = limit }
            : new VisibilityAuditOptions();

        await SezzleeVisibilityAudit.RunAsync(host.App.Services, [Alice, Bob], options);

        Assert.Equal(peak, host.Backend.Peak);
    }

    [Fact]
    public async Task AUD9_TheAuditNeitherReadsNorWritesTheVerdictCache_NorTheHeldAuthorizerAccesses()
    {
        CountingCache cache = new(new MemorySezzleeCache(Microsoft.Extensions.Options.Options.Create(new SezzleeOptions()), TimeProvider.System));
        await using Audited host = await StartAsync(
            services: services => services.AddSingleton<ISezzleeCache>(cache));
        IServiceProvider app = host.App.Services;
        HttpRequest bobRequest = new DefaultHttpContext { Request = { Headers = { Authorization = "Bearer bob" } } }.Request;
        CallerScope scope = app.GetRequiredService<ICallerScopeResolver>().Resolve(bobRequest);
        CallerVisibilityProvider provider = app.GetRequiredService<CallerVisibilityProvider>();
        CatalogEntry sales = app.GetRequiredService<SezzleeCatalogProvider>().Find("sales_report")!;
        Assert.Equal(VisibilityDecision.Allow, await provider.ProbeAsync(scope, bobRequest, sales, CancellationToken.None));
        host.Backend.Answer = (user, action) => user == "bob" && action == "Sales" ? StatusCodes.Status403Forbidden : null;
        (int reads, int writes, int probes) = (cache.Reads, cache.Writes, host.Backend.ProbeTotal);

        VisibilityAuditReport report = await SezzleeVisibilityAudit.RunAsync(app, [Bob]);

        VisibilityAuditFinding finding = Assert.Single(report.Findings);
        Assert.Equal(("bob", "sales_report", VisibilityAuditKind.ListedButDenied), (finding.Caller, finding.Tool, finding.Kind));
        Assert.Equal((reads, writes, probes + 6), (cache.Reads, cache.Writes, host.Backend.ProbeTotal));
        Assert.Equal(VisibilityDecision.Allow, await provider.ProbeAsync(scope, bobRequest, sales, CancellationToken.None));
        Assert.Equal(1, host.Authorizer.Resolutions);
        await SearchAsync(host.ToolsFor("bob"));
        Assert.Equal(2, host.Authorizer.Resolutions);
    }

    [Fact]
    public async Task AUD10_AConcurrencyBelowOneAndARepeatedOrBlankCallerNameAreRefused()
    {
        await using Audited host = await StartAsync();
        IServiceProvider app = host.App.Services;

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            SezzleeVisibilityAudit.RunAsync(app, [Alice], new VisibilityAuditOptions { Concurrency = 0 }));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            SezzleeVisibilityAudit.RunAsync(app, [Alice], new VisibilityAuditOptions { Concurrency = -3 }));
        ArgumentException repeated = await Assert.ThrowsAsync<ArgumentException>(() =>
            SezzleeVisibilityAudit.RunAsync(app, [Alice, Alice]));
        Assert.Contains("Caller name 'alice' is used twice", repeated.Message, StringComparison.Ordinal);
        await Assert.ThrowsAsync<ArgumentException>(() =>
            SezzleeVisibilityAudit.RunAsync(app, [AuditCaller.WithHeaders(" ")]));
    }
}
