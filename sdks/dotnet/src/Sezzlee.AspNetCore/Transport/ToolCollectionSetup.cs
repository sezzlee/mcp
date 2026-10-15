using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using Sezzlee.AspNetCore.RateLimiting;

namespace Sezzlee.AspNetCore.Transport;

internal sealed class ToolCollectionSetup(IOptions<SezzleeOptions> sezzleeOptions, IServiceProvider services) : IPostConfigureOptions<McpServerOptions>
{
    public void PostConfigure(string? name, McpServerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        MetaToolRateLimiter? limiter = sezzleeOptions.Value.RateLimiting.IsConfigured
            ? services.GetRequiredService<MetaToolRateLimiter>()
            : null;
        SezzleeToolCollection collection = new();
        IEnumerable<McpServerTool> existing = options.ToolCollection ?? [];
        foreach (McpServerTool tool in existing)
        {
            collection.Add(new SezzleeBudgetTool(
                limiter is null ? tool : new RateLimitingTool(tool, limiter),
                sezzleeOptions));
        }
        options.ToolCollection = collection;

        options.Capabilities ??= new ServerCapabilities();
        options.Capabilities.Tools ??= new ToolsCapability();
        options.Capabilities.Tools.ListChanged = true;
    }
}
