using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.Tests;

public sealed class ShopControllers
{
    public static int Closed;

    [ApiController]
    [Route("/shop")]
    public sealed class Shop : ControllerBase
    {
        [HttpGet("orders")]
        [McpTool(Name = "list_orders", Description = "Lists customer orders.", Tags = new[] { "sales" })]
        public IActionResult ListOrders() => Ok();

        [HttpGet("invoices")]
        [McpTool(Name = "list_invoices", Description = "Lists invoices.", Tags = new[] { "billing" })]
        public IActionResult ListInvoices() => Ok();

        [HttpPost("close-books")]
        [McpTool(Name = "admin_close_books", Description = "Closes the books for the period.", Tags = new[] { "admin" })]
        public IActionResult CloseBooks()
        {
            Interlocked.Increment(ref Closed);
            return Ok();
        }

        [HttpGet("public")]
        [AllowAnonymous]
        [McpTool(Name = "list_public", Description = "Lists public announcements.", Tags = new[] { "public" })]
        public IActionResult ListPublic() => Ok();

        [HttpGet("gated")]
        [CustomGate]
        [McpTool(Name = "list_gated", Description = "Lists gated records.", Tags = new[] { "gated" })]
        public IActionResult ListGated() => Ok();

        [HttpPost("dispatch/{methodId}")]
        [McpTool(Description = "Runs a server method by its id.", Tags = new[] { "dynamic" })]
        [McpToolFamily("methodId", Source = "methods")]
        public IActionResult Dispatch(string methodId, [FromBody] JsonElement body) => Ok(new { methodId });
    }
}

internal sealed class ExplicitControllers(params Type[] controllers) : IApplicationFeatureProvider<ControllerFeature>
{
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature)
    {
        foreach (TypeInfo controller in controllers.Select(type => type.GetTypeInfo()))
        {
            if (!feature.Controllers.Contains(controller))
            {
                feature.Controllers.Add(controller);
            }
        }
    }
}

internal sealed class RecordingAuthorizer(
    Func<string, McpToolInfo, VisibilityDecision> rule,
    Func<McpToolInfo, bool>? covers = null,
    Func<Task>? gate = null) : IToolAuthorizer
{
    private int _resolutions;
    private int _failures;
    private readonly List<McpToolInfo> _inspected = [];
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, int> _decisions = new(StringComparer.Ordinal);

    public int FailFirstResolutions { get; init; }

    public int DecisionsFor(string tool) => _decisions.GetValueOrDefault(tool);

    public int Resolutions => Volatile.Read(ref _resolutions);

    public IReadOnlyList<McpToolInfo> Inspected
    {
        get
        {
            lock (_inspected)
            {
                return [.. _inspected];
            }
        }
    }

    public bool Covers(McpToolInfo tool)
    {
        lock (_inspected)
        {
            _inspected.Add(tool);
        }
        return covers?.Invoke(tool) ?? true;
    }

    public async ValueTask<IToolAccess> ResolveAsync(HttpRequest? outerRequest, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _resolutions);
        if (Interlocked.Increment(ref _failures) <= FailFirstResolutions)
        {
            throw new InvalidOperationException("permission store unreachable");
        }
        if (gate is not null)
        {
            await gate();
        }
        string user = outerRequest?.Headers.Authorization.ToString().Replace("Bearer ", string.Empty, StringComparison.Ordinal)
            ?? string.Empty;
        return new Access(user, rule, _decisions);
    }

    private sealed class Access(
        string user,
        Func<string, McpToolInfo, VisibilityDecision> rule,
        System.Collections.Concurrent.ConcurrentDictionary<string, int> decisions) : IToolAccess
    {
        public VisibilityDecision Decide(McpToolInfo tool)
        {
            decisions.AddOrUpdate(tool.Name, 1, (_, count) => count + 1);
            return rule(user, tool);
        }
    }
}

internal sealed class ManualTime : TimeProvider
{
    private long _timestamp;

    public override long TimestampFrequency => 1000;

    public override long GetTimestamp() => Interlocked.Read(ref _timestamp);

    public void Advance(TimeSpan span) => Interlocked.Add(ref _timestamp, (long)span.TotalMilliseconds);
}

internal static class ShopHost
{
    public const string BalancesKey = "k-balances";
    public const string SalariesKey = "k-salaries";

    public static IReadOnlyList<McpFamilyMember> DefaultMembers() =>
    [
        new McpFamilyMember(
            BalancesKey,
            "list_balances",
            "Lists customer balances.",
            new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject { ["minBalance"] = new JsonObject { ["type"] = "number" } },
            }),
        new McpFamilyMember(
            SalariesKey,
            "admin_list_salaries",
            "Lists salaries.",
            new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject { ["month"] = new JsonObject { ["type"] = "string" } },
            }),
    ];

    public static VisibilityDecision ManagerSeesAllClerkSeesTheirOwn(string user, McpToolInfo tool)
    {
        if (user == "manager")
        {
            return VisibilityDecision.Allow;
        }
        if (tool.Member is { } member)
        {
            return member.Key.ToString() == BalancesKey ? VisibilityDecision.Allow : VisibilityDecision.Deny;
        }
        return tool.Name == "admin_close_books" ? VisibilityDecision.Deny : VisibilityDecision.Allow;
    }

    public static async Task<Harness> StartAsync(
        IToolAuthorizer? authorizer = null,
        Action<SezzleeOptions>? configure = null,
        Func<IReadOnlyList<McpFamilyMember>>? members = null,
        Action<IServiceCollection>? services = null,
        Type[]? controllers = null)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        Type[] mapped = controllers ?? [typeof(ShopControllers.Shop)];
        builder.Services.AddControllers().ConfigureApplicationPartManager(manager =>
            manager.FeatureProviders.Add(new ExplicitControllers(mapped)));
        if (authorizer is not null)
        {
            builder.Services.AddSingleton(authorizer);
        }
        Func<IReadOnlyList<McpFamilyMember>> source = members ?? DefaultMembers;
        services?.Invoke(builder.Services);
        builder.Services.AddSezzlee(options =>
        {
            options.Families.Provide("methods", (_, _) => ValueTask.FromResult(source()));
            configure?.Invoke(options);
        });

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.MapControllers();
        app.MapSezzlee("/mcp");
        await app.StartAsync();
        return new Harness(app, app.Services.GetRequiredService<SezzleeDispatcher>(), new ProbeCounter());
    }
}
