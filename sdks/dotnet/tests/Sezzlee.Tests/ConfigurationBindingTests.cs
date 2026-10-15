using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;

namespace Sezzlee.Tests;

public sealed class ConfigurationBindingTests
{
    private static SezzleeOptions Bind(Dictionary<string, string?> values, Action<SezzleeOptions>? configure = null)
    {
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        ServiceCollection services = new();
        services.AddLogging();
        services.AddSezzlee(configuration, configure);
        return services.BuildServiceProvider().GetRequiredService<IOptions<SezzleeOptions>>().Value;
    }

    [Fact]
    public void CB1_EnvironmentDependentSettings_BindFromConfiguration()
    {
        SezzleeOptions options = Bind(new()
        {
            ["Invoke:Timeout"] = "00:00:45",
            ["Invoke:MaxResponseBytes"] = "200000",
            ["Cache:Lifetime"] = "00:01:00",
            ["Visibility:OnUnknown"] = "Hide",
            ["Selection:Default"] = "Include",
            ["Selection:Rules:0:Decision"] = "Exclude",
            ["Selection:Rules:0:Route"] = "/Rest/Admin/**",
            ["Families:LoadMode"] = "Background",
            ["Families:RefreshInterval"] = "00:05:00",
            ["Diagnostics:Downgrade:0"] = "family_not_loaded",
        });

        Assert.Equal(TimeSpan.FromSeconds(45), options.Invoke.Timeout);
        Assert.Equal(200_000, options.Invoke.MaxResponseBytes);
        Assert.Equal(TimeSpan.FromMinutes(1), options.Cache.Lifetime);
        Assert.Equal(UnknownVisibility.Hide, options.Visibility.OnUnknown);
        Assert.Equal(SelectionDefault.Include, options.Selection.Default);
        Assert.Equal(new SelectionRule(SelectionDefault.Exclude, "/Rest/Admin/**"), Assert.Single(options.Selection.Rules));
        Assert.Equal(FamilyLoadMode.Background, options.Families.LoadMode);
        Assert.Equal(TimeSpan.FromMinutes(5), options.Families.RefreshInterval);
        Assert.Contains("family_not_loaded", options.Diagnostics.Downgrade);
    }

    [Fact]
    public void CB2_CodeIsAppliedAfterConfiguration()
    {
        SezzleeOptions options = Bind(
            new() { ["Invoke:MaxResponseBytes"] = "200000" },
            configured => configured.Invoke.MaxResponseBytes = 1000);

        Assert.Equal(1000, options.Invoke.MaxResponseBytes);
    }

    [Fact]
    public void CB3_AKeyThatNamesNoOption_FailsInsteadOfBeingIgnored()
    {
        InvalidOperationException refused = Assert.Throws<InvalidOperationException>(
            () => Bind(new() { ["Invoke:Timout"] = "00:00:45" }));

        Assert.Contains("Timout", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CB4_FatalFailureWithABackgroundLoad_IsRefused()
    {
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Families:LoadMode"] = "Background",
            ["Families:OnFailure"] = "Fatal",
        }).Build();
        ServiceCollection services = new();
        services.AddLogging();
        services.AddSezzlee(configuration);

        OptionsValidationException refused = Assert.Throws<OptionsValidationException>(
            () => services.BuildServiceProvider().GetRequiredService<IOptions<SezzleeOptions>>().Value);

        Assert.Contains(refused.Failures, f => f.Contains("Families.OnFailure", StringComparison.Ordinal));
    }
}
