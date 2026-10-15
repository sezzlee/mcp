using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;
using Newtonsoft.Json.Linq;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.NewtonsoftJson;

namespace Sezzlee.Tests;

public enum ParcelStatus
{
    Waiting = 1,
    Delivered = 2,
}

public sealed class ParcelUpdate
{
    public string ParcelNumber { get; set; } = string.Empty;

    [JsonProperty("courier_code")]
    public string CourierCode { get; set; } = string.Empty;

    public ParcelStatus Status { get; set; }

    public JObject? Extra { get; set; }

    public JToken? Payload { get; set; }
}

public sealed class NewtonsoftAdapterHostTests : InvokeHost
{
    [ApiController]
    [Route("/parcels")]
    public sealed class ParcelsController : ControllerBase
    {
        [HttpPost]
        [McpTool(Name = "update_parcel", Description = "Updates a parcel.")]
        public IActionResult Update([FromBody] ParcelUpdate update) => Ok(update);
    }

    protected override Type[] Controllers => [typeof(ParcelsController)];

    protected override void Configure(IMvcBuilder mvc)
    {
        mvc.AddNewtonsoftJson(json => json.SerializerSettings.Converters.Add(new StringEnumConverter()));
        mvc.Services.AddSezzleeNewtonsoftJson();
    }

    [Fact]
    public async Task NA1_TheSchemaUsesTheNamesAndEnumFormNewtonsoftBinds()
    {
        JsonNode schema = await LoadInputSchemaAsync("update_parcel");

        Assert.Equal(
            ["parcelNumber", "courier_code", "status", "extra", "payload"],
            schema["properties"]!.AsObject().Select(p => p.Key).ToArray());
        Assert.Equal("object", schema["properties"]!["extra"]!["type"]!.GetValue<string>());
        Assert.False(schema["properties"]!["payload"]!.AsObject().ContainsKey("type"));
        Assert.Equal(
            ["Waiting", "Delivered"],
            schema["properties"]!["status"]!["enum"]!.AsArray().Select(n => n!.GetValue<string>()).ToArray());
        string[] codes = [.. Services.GetRequiredService<SezzleeCatalogProvider>().Result.Diagnostics.Select(d => d.Code)];
        Assert.DoesNotContain(DiagnosticCodes.NamingPolicyUnresolved, codes);
        Assert.DoesNotContain(DiagnosticCodes.EnumFormatUnresolved, codes);
        Assert.DoesNotContain(DiagnosticCodes.UnreadableShape, codes);
    }

    [Fact]
    public async Task NA2_ACallWrittenFromThatSchema_BindsOnTheBackend()
    {
        JsonElement body = await InvokeAsync(
            "update_parcel", new Dictionary<string, object> { ["parcelNumber"] = "P-9", ["courier_code"] = "C-4", ["status"] = "Delivered" });

        Assert.Equal("P-9", body.GetProperty("parcelNumber").GetString());
        Assert.Equal("C-4", body.GetProperty("courier_code").GetString());
        Assert.Equal("Delivered", body.GetProperty("status").GetString());
    }
}
