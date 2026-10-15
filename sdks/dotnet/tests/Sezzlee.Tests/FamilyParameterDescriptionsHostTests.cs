using System.ComponentModel;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Sezzlee.AspNetCore.Discovery;

namespace Sezzlee.Tests;

internal static class DescribedSignatures
{
    public static void Assign(
        [Description("From the attribute.")] string orderNumber,
        [Description("Kept.")] int courierId,
        [Description("Fallback.")] string? note = null)
    {
    }

    public static McpFamilyMember Member(string orderDescription) => new(
        "assign",
        "assign_courier",
        "Assigns a courier.",
        typeof(DescribedSignatures).GetMethod(nameof(Assign))!.GetParameters())
    {
        ParameterDescriptions = new Dictionary<string, string>
        {
            ["orderNumber"] = orderDescription,
            ["note"] = "   ",
            ["noSuchParameter"] = "ignored",
        },
    };
}

public sealed class FamilyParameterDescriptionsHostTests : FamilyHost
{
    protected override IReadOnlyList<Func<IReadOnlyList<McpFamilyMember>>> Answers =>
        [() => [DescribedSignatures.Member("Order to assign.")]];

    [Fact]
    public async Task PD1_ADescriptionFromTheSourceWinsOverTheAttribute_AndABlankOneFallsBackToIt()
    {
        JsonNode properties = (await LoadInputSchemaAsync("assign_courier"))["properties"]!;

        Assert.Equal("Order to assign.", (string?)properties["orderNumber"]!["description"]);
        Assert.Equal("Kept.", (string?)properties["courierId"]!["description"]);
        Assert.Equal("Fallback.", (string?)properties["note"]!["description"]);
    }

    [Fact]
    public async Task PD2_ARefreshThatReturnsEqualDescriptionsInANewDictionary_ChangesNothing()
    {
        long generation = Catalog.Generation;

        await Catalog.RefreshFamiliesAsync(CancellationToken.None);

        Assert.Equal(generation, Catalog.Generation);
    }
}

public sealed class FamilyParameterDescriptionsChangeHostTests : FamilyHost
{
    protected override IReadOnlyList<Func<IReadOnlyList<McpFamilyMember>>> Answers =>
    [
        () => [DescribedSignatures.Member("Order to assign.")],
        () => [DescribedSignatures.Member("Order to hand over.")],
    ];

    [Fact]
    public async Task PD3_ARefreshThatChangesADescription_RebuildsTheCatalog()
    {
        long generation = Catalog.Generation;

        await Catalog.RefreshFamiliesAsync(CancellationToken.None);

        Assert.Equal(generation + 1, Catalog.Generation);
        JsonNode properties = (await LoadInputSchemaAsync("assign_courier"))["properties"]!;
        Assert.Equal("Order to hand over.", (string?)properties["orderNumber"]!["description"]);
    }
}
