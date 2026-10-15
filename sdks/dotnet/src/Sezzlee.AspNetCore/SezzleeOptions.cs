using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using ModelContextProtocol.Authentication;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Errors;
using Sezzlee.AspNetCore.Naming;

using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore;

public sealed class SezzleeOptions
{
    public IdentityForwardingOptions Identity { get; } = new();
    public SyntheticRequestOptions Synthetic { get; } = new();
    public SelectionOptions Selection { get; } = new();
    public QueryOptions Query { get; } = new();
    public SchemaOptions Schema { get; } = new();
    public NamingOptions Naming { get; } = new();
    public VisibilityOptions Visibility { get; } = new();
    public CacheOptions Cache { get; } = new();
    public ErrorMappingOptions Errors { get; } = new();
    public ResourceServerOptions ResourceServer { get; } = new();
    public DiagnosticsOptions Diagnostics { get; } = new();
    public ArgumentCurationOptions Arguments { get; } = new();

    public ToolFamilyOptions Families { get; } = new();
    public InvokeOptions Invoke { get; } = new();
    public Search.SearchOptions Search { get; } = new();

    /// <summary>
    /// Grouping labels for a container the host cannot decorate, keyed by the container's full
    /// type name. It sits below a <c>[McpTool(Tags = ...)]</c> declaration and above the
    /// container-derived default, and like a declaration it replaces that default.
    /// </summary>
    public Func<string, IReadOnlyList<string>?>? Tags { get; set; }

    /// <summary>
    /// Search vocabulary for a container the host cannot decorate, keyed like <see cref="Tags"/>. It
    /// sits below a <c>[McpTool(SearchTerms = ...)]</c> declaration; there is no default.
    /// </summary>
    public Func<string, IReadOnlyList<string>?>? SearchTerms { get; set; }

    /// <summary>
    /// A description for an endpoint the host documents elsewhere, such as in generated code
    /// documentation. It sits below a <c>[McpTool(Description = ...)]</c> declaration and above the
    /// endpoint's description metadata, which it receives as <see cref="McpEndpointInfo.Declared"/>;
    /// returning null or blank keeps that.
    /// </summary>
    public Func<McpEndpointInfo, string?>? Description { get; set; }

    /// <summary>The behaviour revision of the whole catalog; raising it changes every tool version.</summary>
    public int? Revision { get; set; }

    /// <summary>
    /// A behaviour revision for a container the host cannot decorate, keyed like <see cref="Tags"/>.
    /// It sits below a <c>[McpTool(Revision = ...)]</c> on that container.
    /// </summary>
    public Func<string, int?>? ContainerRevision { get; set; }
}

/// <summary>What a per-endpoint catalog rule sees.</summary>
/// <param name="Method">The upper-case HTTP method.</param>
/// <param name="Route">The normalized route template.</param>
/// <param name="Container">The controller's full type name; null for a minimal API endpoint.</param>
/// <param name="Action">The controller action's method; null for a minimal API endpoint.</param>
/// <param name="Declared">The description the endpoint's metadata declares, if any.</param>
public sealed record McpEndpointInfo(
    string Method,
    string Route,
    string? Container,
    MethodInfo? Action,
    IReadOnlyList<object> Metadata,
    string? Declared);

/// <summary>What a per-endpoint budget or timeout override sees.</summary>
public readonly record struct InvokeTarget(string Tool, string Method, string Route);

public sealed class InvokeOptions
{
    /// <summary>The largest tool response, in UTF-8 bytes, that may reach the agent.</summary>
    public int MaxResponseBytes { get; set; } = SdkErrors.DefaultMaxResponseBytes;

    /// <summary>
    /// How long an invocation waits for the backend. <see cref="TimeSpan.Zero"/> means no deadline.
    /// Values at or above one minute are unreachable through a stock MCP client, whose own request
    /// timeout cancels first.
    /// </summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromMilliseconds(SdkErrors.DefaultInvokeTimeoutMs);

    public Func<InvokeTarget, int?>? MaxResponseBytesFor { get; set; }
    public Func<InvokeTarget, TimeSpan?>? TimeoutFor { get; set; }

    /// <summary>Decoded base64 file bytes one call may carry inline.</summary>
    public int MaxInlineFileBytes { get; set; } = Requests.RequestBodyEncoder.DefaultMaxInlineFileBytes;

    /// <summary>The bytes one resolved <c>ref</c> file may carry.</summary>
    public int MaxFileBytes { get; set; } = SdkErrors.DefaultMaxFileBytes;
}

public sealed class DiagnosticsOptions
{
    public CatalogSeverity FailOn { get; set; } = CatalogSeverity.Fatal;
    public HashSet<string> Downgrade { get; } = new(StringComparer.Ordinal);
    public HashSet<string> Escalate { get; } = new(StringComparer.Ordinal);

    public CatalogSeverity SeverityOf(string code)
    {
        if (Escalate.Contains(code))
        {
            return CatalogSeverity.Fatal;
        }
        if (Downgrade.Contains(code))
        {
            return CatalogSeverity.Warning;
        }
        return DiagnosticCodes.SeverityOf(code);
    }
}

public sealed class ResourceServerOptions
{
    public ProtectedResourceMetadata? Metadata { get; set; }
}

public sealed class CacheOptions
{
    public TimeSpan Lifetime { get; set; } = TimeSpan.FromSeconds(30);
    public int MaxCallers { get; set; } = 128;
}

public enum UnknownVisibility { Show, Hide }

public enum VisibilityTier { Declarative, Probe }

public sealed class VisibilityOptions
{
    public UnknownVisibility OnUnknown { get; set; } = UnknownVisibility.Show;
    public VisibilityTier Tier { get; set; } = VisibilityTier.Declarative;
    public int ProbeTopK { get; set; } = 25;
    public int ProbeConcurrency { get; set; } = 4;
    public Dictionary<string, string> ProbeValues { get; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed class SelectionOptions
{
    public SelectionDefault Default { get; set; } = SelectionDefault.Exclude;

    /// <summary>
    /// Config-level rules, for routes the host cannot or will not decorate. They sit below both
    /// attribute levels and above <see cref="Default"/>; order carries no meaning, and equally
    /// specific rules that disagree are a build error rather than a silent first-match win.
    /// </summary>
    public List<SelectionRule> Rules { get; } = [];
}

public enum QueryObjectGrouping { Flatten, Group }

public sealed class QueryOptions
{
    /// <summary>
    /// How a whole-object query binding reaches the agent. <see cref="QueryObjectGrouping.Flatten"/>
    /// keeps every member a top-level tool argument; <see cref="QueryObjectGrouping.Group"/>
    /// publishes one object argument the composer writes in ASP.NET's dotted form.
    /// </summary>
    /// <remarks>
    /// The default is <see cref="QueryObjectGrouping.Flatten"/> because switching rewrites the
    /// <c>inputSchema</c> of every affected tool and renames the namespace argument curation is
    /// keyed by, so an existing <c>[McpArgument("Status", ...)]</c> stops resolving.
    /// </remarks>
    public QueryObjectGrouping Grouping { get; set; } = QueryObjectGrouping.Flatten;
}

public sealed class NamingOptions
{
    public PrefixMode PrefixMode { get; set; } = PrefixMode.Always;
    public Func<string, string?>? Prefix { get; set; }
}

public sealed class SchemaOptions
{
    public Func<PropertyInfo, string>? PropertyName { get; set; }
    public Func<Type, EnumFacts>? EnumShape { get; set; }

    public Func<Type, string>? TypeName { get; set; }

    public Func<Type, JsonObject?>? TypeSchema { get; set; }

    public int? MaxDepth { get; set; }
    public bool DropReadOnlyProperties { get; set; } = true;
}

public sealed class SyntheticRequestOptions
{
    public string? Host { get; set; }
    public string? Scheme { get; set; }
    public string Accept { get; set; } = "application/json";
    public string? UserAgent { get; set; }
}

public sealed class IdentityForwardingOptions
{
    private readonly HashSet<string> _carriers = new(StringComparer.OrdinalIgnoreCase) { "Authorization" };

    public IReadOnlyCollection<string> Carriers => _carriers;

    public Action<HttpRequest, HttpRequest>? Projector { get; private set; }

    public IdentityForwardingOptions Forward(string headerName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(headerName);
        _carriers.Add(headerName);
        return this;
    }

    public IdentityForwardingOptions Clear()
    {
        _carriers.Clear();
        return this;
    }

    public IdentityForwardingOptions Project(Action<HttpRequest, HttpRequest> projector)
    {
        ArgumentNullException.ThrowIfNull(projector);
        Projector = projector;
        return this;
    }
}
