using System.Text.Json.Nodes;
using Newtonsoft.Json.Linq;
using Sezzlee.AspNetCore.Discovery;

namespace Sezzlee.Tests;

public sealed class SelfList : List<SelfList>;

public sealed class AlternatingList : List<AlternatingMap>;

public sealed class AlternatingMap : Dictionary<string, AlternatingList>;

public sealed class Tree
{
    public string Name { get; set; } = string.Empty;
    public List<Tree> Children { get; set; } = [];
}

public sealed class TokenHolder
{
    public JToken? Payload { get; set; }
    public JObject? Settings { get; set; }
    public JArray? Rows { get; set; }
}

/// <remarks>
/// Before the guard each of these overflowed the stack inside the binder, which kills the test
/// host instead of failing a test, so the regression shows as a crashed run, not a red one.
/// </remarks>
public sealed class SelfContainingTypeTests
{
    [Theory]
    [InlineData(typeof(JToken))]
    [InlineData(typeof(JArray))]
    [InlineData(typeof(JValue))]
    [InlineData(typeof(SelfList))]
    public void SC1_ACollectionOfItsOwnKind_IsAnyValue_NotAnArray(Type type)
    {
        JsonObject schema = JsonSchemaMapper.Map(type);

        Assert.False(schema.ContainsKey("items"), schema.ToJsonString());
    }

    [Fact]
    public void SC2_AMapOfAnyValue_StaysAnObject()
    {
        JsonObject schema = JsonSchemaMapper.Map(typeof(JObject));

        Assert.Equal("object", schema["type"]!.GetValue<string>());
    }

    [Fact]
    public void SC3_ACycleThroughCollectionsAndMaps_Ends()
    {
        JsonObject schema = JsonSchemaMapper.Map(typeof(AlternatingList));

        Assert.Equal("array", schema["type"]!.GetValue<string>());
        Assert.Equal("object", schema["items"]!["type"]!.GetValue<string>());
    }

    [Fact]
    public void SC4_ARecursiveObjectBehindACollection_KeepsItsShape()
    {
        JsonObject schema = JsonSchemaMapper.Map(typeof(List<Tree>));

        Assert.Equal("array", schema["type"]!.GetValue<string>());
        Assert.Equal("#/$defs/Tree", schema["items"]!["$ref"]!.GetValue<string>());
        JsonNode children = schema["$defs"]!["Tree"]!["properties"]!["Children"]!;
        Assert.Equal("array", children["type"]!.GetValue<string>());
        Assert.Equal("#/$defs/Tree", children["items"]!["$ref"]!.GetValue<string>());
    }

    [Fact]
    public void SC5_NewtonsoftTokensAsMembers_DoNotStopTheOwner()
    {
        JsonObject properties = (JsonObject)JsonSchemaMapper.Map(typeof(TokenHolder))["properties"]!;

        Assert.Equal(["Payload", "Settings", "Rows"], properties.Select(p => p.Key).ToArray());
        Assert.Equal("object", properties["Settings"]!["type"]!.GetValue<string>());
    }
}
