using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;

namespace Sezzlee.Tests;

public readonly record struct Money(decimal Amount);

public sealed class CourierAssignment
{
    [System.ComponentModel.DataAnnotations.Required]
    public string OrderNumber { get; set; } = string.Empty;

    public Money Fee { get; set; }
}

internal static class DynamicMethodSignatures
{
    public static void Assign(string orderNumber, int courierId, int priority = 0, string? note = null)
    {
    }

    public static JsonObject Schema(params (string Name, JsonNode Schema)[] properties) =>
        new(properties.Select(p => KeyValuePair.Create(p.Name, (JsonNode?)p.Schema)));
}

#nullable disable
internal static class UnannotatedSignatures
{
    public static void Save(WorkflowDraft draft, string comment, int? priority)
    {
    }
}

public sealed class WorkflowDraft
{
    public string Title { get; set; }
}
#nullable restore

public sealed class FamilyBodyHostTests : FamilyHost
{
    protected override IReadOnlyList<Func<IReadOnlyList<McpFamilyMember>>> Answers =>
    [
        () =>
        [
            new McpFamilyMember("assign-dto", "assign_by_dto", "Assigns a courier from a request object.", typeof(CourierAssignment)),
            new McpFamilyMember(
                "assign-args",
                "assign_by_arguments",
                "Assigns a courier from method arguments.",
                typeof(DynamicMethodSignatures).GetMethod(nameof(DynamicMethodSignatures.Assign))!.GetParameters()),
            new McpFamilyMember(
                "save-draft",
                "save_draft",
                "Saves a workflow draft.",
                typeof(UnannotatedSignatures).GetMethod(nameof(UnannotatedSignatures.Save))!.GetParameters()),
        ],
    ];

    protected override void Configure(IMvcBuilder mvc)
    {
        base.Configure(mvc);
        mvc.Services.Configure<SezzleeOptions>(options =>
            options.Schema.TypeSchema = type => type == typeof(Money) ? new JsonObject { ["type"] = "string" } : null);
    }

    [Fact]
    public async Task FB1_ATypeBody_IsMappedLikeAnActionBody_ThroughTheSchemaHooks()
    {
        JsonNode schema = await LoadInputSchemaAsync("assign_by_dto");

        Assert.Equal("string", schema["properties"]!["orderNumber"]!["type"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(new JsonObject { ["type"] = "string" }, schema["properties"]!["fee"]), schema.ToJsonString());
        Assert.Equal(["orderNumber"], schema["required"]!.AsArray().Select(n => n!.GetValue<string>()).ToArray());
    }

    [Fact]
    public async Task FB2_AParameterBody_NamesPropertiesAsDeclared_AndRequiresOnlyWhatCannotBeOmitted()
    {
        JsonNode schema = await LoadInputSchemaAsync("assign_by_arguments");

        Assert.Equal(
            ["orderNumber", "courierId", "priority", "note"],
            schema["properties"]!.AsObject().Select(p => p.Key).ToArray());
        Assert.Equal(
            ["orderNumber", "courierId"],
            schema["required"]!.AsArray().Select(n => n!.GetValue<string>()).ToArray());
        Assert.Equal("integer", schema["properties"]!["courierId"]!["type"]!.GetValue<string>());
    }

    [Fact]
    public async Task FB2b_WithoutNullableAnnotations_AnObjectWithoutADefaultIsRequired_AndAStringIsNot()
    {
        JsonNode schema = await LoadInputSchemaAsync("save_draft");

        Assert.Equal(
            ["draft"],
            schema["required"]!.AsArray().Select(n => n!.GetValue<string>()).ToArray());
    }

    [Fact]
    public async Task FB3_AParameterBody_IsSentAsOneJsonObject()
    {
        System.Text.Json.JsonElement body = await InvokeAsync(
            "assign_by_arguments", new { orderNumber = "A-1", courierId = 7 });

        Assert.Equal("assign-args", body.GetProperty("methodId").GetString());
        Assert.Equal(7, body.GetProperty("received").GetProperty("courierId").GetInt32());
    }
}

public sealed class FamilyRefreshHostTests : FamilyHost
{
    protected override IReadOnlyList<Func<IReadOnlyList<McpFamilyMember>>> Answers =>
        [() => [Members.Balances], () => [Members.Balances], () => [Members.Balances, Members.Delayed]];

    [Fact]
    public async Task FU1_ARefreshWithEqualMembersChangesNothing_AndOneWithNewMembersRebuilds()
    {
        long generation = Catalog.Generation;

        await Catalog.RefreshSourcesAsync(CatalogSources.Families, CancellationToken.None);
        Assert.Equal(generation, Catalog.Generation);
        Assert.Equal(["list_customer_balances", "list_orders"], Names);

        await Catalog.RefreshSourcesAsync(CatalogSources.Families, CancellationToken.None);
        Assert.Equal(generation + 1, Catalog.Generation);
        Assert.Equal(["list_customer_balances", "list_delayed_orders", "list_orders"], Names);
    }
}

public sealed class FamilyTimeoutHostTests : FamilyHost
{
    protected override IReadOnlyList<Func<IReadOnlyList<McpFamilyMember>>> Answers =>
        [() => { Thread.Sleep(TimeSpan.FromSeconds(1)); return [Members.Balances]; }];

    protected override void Configure(IMvcBuilder mvc)
    {
        base.Configure(mvc);
        mvc.Services.Configure<SezzleeOptions>(options => options.Families.LoadTimeout = TimeSpan.FromMilliseconds(50));
    }

    [Fact]
    public void FT1_ASourceThatOutlivesItsDeadline_IsReportedAsATimeout_NamingTheOption()
    {
        CatalogDiagnostic failed = Assert.Single(
            Catalog.Result.Diagnostics, d => d.Code == DiagnosticCodes.FamilySourceFailed);

        Assert.Contains("timeout", failed.Message, StringComparison.Ordinal);
        Assert.Contains("Families.LoadTimeout", failed.Message, StringComparison.Ordinal);
    }
}

public sealed class FamilyBackgroundHostTests : FamilyHost
{
    private static readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);

    protected override IReadOnlyList<Func<IReadOnlyList<McpFamilyMember>>> Answers =>
        [() => { Release.Task.Wait(TimeSpan.FromSeconds(10)); return [Members.Balances]; }];

    protected override void Configure(IMvcBuilder mvc)
    {
        base.Configure(mvc);
        mvc.Services.Configure<SezzleeOptions>(options => options.Families.LoadMode = FamilyLoadMode.Background);
    }

    [Fact]
    public async Task FG1_StartupDoesNotWait_AndTheMembersJoinWhenTheSourceReturns()
    {
        Assert.Equal(["list_orders"], Names);
        Assert.Contains(DiagnosticCodes.FamilyNotLoaded, Codes);

        TaskCompletionSource rebuilt = new(TaskCreationOptions.RunContinuationsAsynchronously);
        using IDisposable _ = Catalog.GetChangeToken().RegisterChangeCallback(_ => rebuilt.TrySetResult(), null);
        Release.SetResult();
        await rebuilt.Task.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(["list_customer_balances", "list_orders"], Names);
    }
}

public sealed class FamilyFatalStartupTests
{
    private sealed class FailingHost : FamilyHost
    {
        protected override IReadOnlyList<Func<IReadOnlyList<McpFamilyMember>>> Answers =>
            [() => throw new InvalidOperationException("database unreachable")];

        protected override void Configure(IMvcBuilder mvc)
        {
            base.Configure(mvc);
            mvc.Services.Configure<SezzleeOptions>(options => options.Families.OnFailure = FamilyLoadFailure.Fatal);
        }
    }

    [Fact]
    public async Task FZ1_WithOnFailureFatal_ASourceThatNeverReturnedStopsStartup()
    {
        FailingHost host = new();

        SezzleeCatalogException refused = await Assert.ThrowsAsync<SezzleeCatalogException>(host.InitializeAsync);

        Assert.Equal(DiagnosticCodes.FamilySourceFailed, refused.Code);
        Assert.Contains("database unreachable", refused.Message, StringComparison.Ordinal);
        await host.DisposeAsync();
    }
}
