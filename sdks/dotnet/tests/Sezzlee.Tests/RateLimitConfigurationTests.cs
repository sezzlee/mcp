using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Client;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.RateLimiting;
using static Sezzlee.Tests.RateLimitHost;

namespace Sezzlee.Tests;

public sealed class RateLimitConfigurationTests
{
    private static IConfiguration Configuration(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    private static SezzleeOptions Bind(Dictionary<string, string?> values)
    {
        ServiceCollection services = new();
        services.AddLogging();
        services.AddSezzlee(Configuration(values));
        return services.BuildServiceProvider().GetRequiredService<IOptions<SezzleeOptions>>().Value;
    }

    private static IReadOnlyList<string> Failures(Action<RateLimitingOptions> configure)
    {
        SezzleeOptions options = new();
        configure(options.RateLimiting);
        ValidateOptionsResult result = new SezzleeOptionsValidator().Validate(null, options);
        return result.Failures?.ToList() ?? [];
    }

    [Fact]
    public void RLC1_TheDeclaredLimits_BindFromTheSezzleeConfigurationSection()
    {
        SezzleeOptions options = Bind(new()
        {
            ["RateLimiting:Default:Kind"] = "TokenBucket",
            ["RateLimiting:Default:TokenLimit"] = "120",
            ["RateLimiting:Default:TokensPerPeriod"] = "2",
            ["RateLimiting:Default:Period"] = "00:00:01",
            ["RateLimiting:Invoke:Kind"] = "SlidingWindow",
            ["RateLimiting:Invoke:PermitLimit"] = "30",
            ["RateLimiting:Invoke:Window"] = "00:01:00",
            ["RateLimiting:Invoke:SegmentsPerWindow"] = "6",
            ["RateLimiting:Invoke:QueueLimit"] = "2",
            ["RateLimiting:InvokeConcurrency"] = "4",
        });

        RateLimitingOptions limits = options.RateLimiting;
        Assert.True(limits.IsConfigured);
        RateLimitSettings fallback = Assert.IsType<RateLimitSettings>(limits.Default);
        Assert.Equal(RateLimitKind.TokenBucket, fallback.Kind);
        Assert.Equal(120, fallback.TokenLimit);
        Assert.Equal(2, fallback.TokensPerPeriod);
        Assert.Equal(TimeSpan.FromSeconds(1), fallback.Period);
        RateLimitSettings invoke = Assert.IsType<RateLimitSettings>(limits.Invoke);
        Assert.Equal(RateLimitKind.SlidingWindow, invoke.Kind);
        Assert.Equal(30, invoke.PermitLimit);
        Assert.Equal(TimeSpan.FromMinutes(1), invoke.Window);
        Assert.Equal(6, invoke.SegmentsPerWindow);
        Assert.Equal(2, invoke.QueueLimit);
        Assert.Equal(4, limits.InvokeConcurrency);
        Assert.Null(limits.Search);
        Assert.Null(limits.Load);
    }

    [Fact]
    public void RLC2_WithNoRateLimitingKeys_NothingIsConfigured()
    {
        Assert.False(Bind(new()).RateLimiting.IsConfigured);
    }

    [Fact]
    public void RLC3_ARateLimitingKeyThatNamesNoOption_FailsInsteadOfBeingIgnored()
    {
        InvalidOperationException refused = Assert.Throws<InvalidOperationException>(
            () => Bind(new() { ["RateLimiting:Invoke:PermitLimt"] = "3" }));

        Assert.Contains("PermitLimt", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RLC4_LimitsBoundFromConfiguration_AreEnforced()
    {
        await using RateLimitApp host = await StartAsync(configuration: Configuration(new()
        {
            ["RateLimiting:Invoke:Kind"] = "FixedWindow",
            ["RateLimiting:Invoke:PermitLimit"] = "1",
            ["RateLimiting:Invoke:Window"] = HourLong,
        }));
        McpClient client = await host.ConnectAsync();

        Assert.False((await InvokeAsync(client, "ping")).IsError);
        Assert.True(IsRateLimited((await InvokeAsync(client, "ping")).Body));
    }

    [Theory]
    [InlineData(RateLimitKind.TokenBucket, "TokenLimit")]
    [InlineData(RateLimitKind.TokenBucket, "TokensPerPeriod")]
    [InlineData(RateLimitKind.TokenBucket, "Period")]
    [InlineData(RateLimitKind.FixedWindow, "PermitLimit")]
    [InlineData(RateLimitKind.FixedWindow, "Window")]
    [InlineData(RateLimitKind.SlidingWindow, "PermitLimit")]
    [InlineData(RateLimitKind.SlidingWindow, "Window")]
    [InlineData(RateLimitKind.SlidingWindow, "SegmentsPerWindow")]
    [InlineData(RateLimitKind.Concurrency, "PermitLimit")]
    public void RLC5_AFieldItsKindNeeds_MustBePositive(RateLimitKind kind, string field)
    {
        IReadOnlyList<string> failures = Failures(limits => limits.Search = Complete(kind));
        Assert.Empty(failures);

        failures = Failures(limits =>
        {
            RateLimitSettings settings = Complete(kind);
            Zero(settings, field);
            limits.Search = settings;
        });

        string failure = Assert.Single(failures);
        Assert.Contains($"RateLimiting.Search.{field}", failure, StringComparison.Ordinal);
    }

    [Fact]
    public void RLC6_AFieldTheKindDoesNotUse_IsNotRequired()
    {
        Assert.Empty(Failures(limits => limits.Default = new RateLimitSettings
        {
            Kind = RateLimitKind.Concurrency,
            PermitLimit = 1,
        }));
    }

    [Fact]
    public void RLC7_AnUndefinedKind_IsRefused()
    {
        IReadOnlyList<string> failures = Failures(limits => limits.Invoke = new RateLimitSettings { Kind = (RateLimitKind)99 });

        Assert.Contains(failures, failure => failure.Contains("RateLimiting.Invoke.Kind", StringComparison.Ordinal));
    }

    [Fact]
    public void RLC8_AConcurrencyOfZero_AndANegativeQueue_AreRefused()
    {
        IReadOnlyList<string> failures = Failures(limits =>
        {
            limits.InvokeConcurrency = 0;
            RateLimitSettings settings = Complete(RateLimitKind.Concurrency);
            settings.QueueLimit = -1;
            limits.Load = settings;
        });

        Assert.Contains(failures, failure => failure.Contains("RateLimiting.InvokeConcurrency", StringComparison.Ordinal));
        Assert.Contains(failures, failure => failure.Contains("RateLimiting.Load.QueueLimit", StringComparison.Ordinal));
    }

    [Fact]
    public void RLC9_APartitionFunctionBesideDeclaredLimits_IsRefused()
    {
        IReadOnlyList<string> failures = Failures(limits =>
        {
            limits.Invoke = Complete(RateLimitKind.Concurrency);
            limits.Partitions(_ => []);
        });

        Assert.Contains(failures, failure => failure.Contains("RateLimiting.Partition", StringComparison.Ordinal));
        Assert.Empty(Failures(limits => limits.Partitions(_ => [])));
    }

    [Fact]
    public void RLC10_AKeyWithoutDeclaredLimits_IsRefused()
    {
        IReadOnlyList<string> failures = Failures(limits => limits.Key(_ => "user"));

        Assert.Contains(failures, failure => failure.Contains("RateLimiting.Key", StringComparison.Ordinal));
        Assert.Empty(Failures(limits =>
        {
            limits.Key(_ => "user");
            limits.InvokeConcurrency = 2;
        }));
    }

    [Fact]
    public async Task RLC11_InvalidRateLimiting_FailsStartup()
    {
        OptionsValidationException refused = await Assert.ThrowsAsync<OptionsValidationException>(
            async () => await StartAsync(o => o.RateLimiting.Invoke = new RateLimitSettings
            {
                Kind = RateLimitKind.FixedWindow,
            }));

        Assert.Contains(refused.Failures, failure => failure.Contains("RateLimiting.Invoke.PermitLimit", StringComparison.Ordinal));
    }

    private static RateLimitSettings Complete(RateLimitKind kind) => new()
    {
        Kind = kind,
        PermitLimit = 1,
        TokenLimit = 1,
        TokensPerPeriod = 1,
        Period = TimeSpan.FromSeconds(1),
        Window = TimeSpan.FromSeconds(1),
        SegmentsPerWindow = 1,
    };

    private static void Zero(RateLimitSettings settings, string field)
    {
        switch (field)
        {
            case "PermitLimit": settings.PermitLimit = 0; break;
            case "TokenLimit": settings.TokenLimit = 0; break;
            case "TokensPerPeriod": settings.TokensPerPeriod = 0; break;
            case "SegmentsPerWindow": settings.SegmentsPerWindow = 0; break;
            case "Period": settings.Period = TimeSpan.Zero; break;
            default: settings.Window = TimeSpan.Zero; break;
        }
    }
}
