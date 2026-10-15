using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Requests;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore.Visibility.Probe;

public interface IProbeEvaluator
{
    bool CanProbe(CatalogEntry entry);

    Task<VisibilityDecision> ProbeAsync(CatalogEntry entry, HttpRequest? outerRequest, CancellationToken cancellationToken);
}

internal sealed class ProbeEvaluator : IProbeEvaluator
{
    private readonly SezzleeDispatcher _dispatcher;
    private readonly IOptions<SezzleeOptions> _options;
    private readonly ILogger<ProbeEvaluator> _logger;
    private readonly ConcurrentDictionary<string, string> _disabled = new(StringComparer.Ordinal);

    public ProbeEvaluator(
        SezzleeDispatcher dispatcher,
        IOptions<SezzleeOptions> options,
        ILogger<ProbeEvaluator> logger,
        ISezzleeCatalogChangeSource changeSource)
    {
        _dispatcher = dispatcher;
        _options = options;
        _logger = logger;
        ChangeToken.OnChange(changeSource.GetChangeToken, () => _disabled.Clear());
    }

    public bool CanProbe(CatalogEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        if (entry.Endpoint is not RouteEndpoint endpoint || _disabled.ContainsKey(entry.Tool.Name))
        {
            return false;
        }
        bool mvc = endpoint.Metadata.GetMetadata<ControllerActionDescriptor>() is not null;
        bool declarative = endpoint.Metadata.GetMetadata<IAuthorizeData>() is not null;
        bool safe = entry.Descriptor.Method is "GET" or "HEAD";
        return mvc || (declarative && safe);
    }

    public async Task<VisibilityDecision> ProbeAsync(
        CatalogEntry entry, HttpRequest? outerRequest, CancellationToken cancellationToken)
    {
        if (!CanProbe(entry))
        {
            return VisibilityDecision.Unknown;
        }

        RouteEndpoint endpoint = (RouteEndpoint)entry.Endpoint!;
        string path = ProbePath(endpoint.RoutePattern, _options.Value.Visibility.ProbeValues, entry.Template);
        ProbeOutcome outcome = await _dispatcher.ProbeAsync(
            new HttpMethod(entry.Descriptor.Method), path, outerRequest, cancellationToken);

        if (outcome.Status is StatusCodes.Status401Unauthorized or StatusCodes.Status403Forbidden)
        {
            return VisibilityDecision.Deny;
        }
        if (outcome.ShortCircuited && outcome.Status < 400)
        {
            return VisibilityDecision.Allow;
        }

        string? disabledBecause = DisabledReason(outcome);
        if (disabledBecause is null)
        {
            _logger.LogDebug(
                "sezzlee probe for '{Tool}' ({Method} {Path}) answered {Status}; treated as unknown and probed again next time",
                entry.Tool.Name, entry.Descriptor.Method, path, outcome.Status);
        }
        else if (_disabled.TryAdd(entry.Tool.Name, disabledBecause))
        {
            _logger.LogWarning(
                "sezzlee probe disabled for '{Tool}' ({Method} {Path} -> {Status}): {Reason}",
                entry.Tool.Name, entry.Descriptor.Method, path, outcome.Status, disabledBecause);
        }
        return VisibilityDecision.Unknown;
    }

    /// <remarks>
    /// Guard: only an answer that proves this probe cannot work for the tool disables it until the
    /// catalog changes: a path that did not route, or a response that carries no short-circuit marker yet
    /// succeeded, which means the handler may have run. A 429, a 5xx or any other refusal says nothing
    /// about the tool and the next search should ask again.
    /// </remarks>
    private static string? DisabledReason(ProbeOutcome outcome)
    {
        if (outcome.ShortCircuited)
        {
            return null;
        }
        if (outcome.Status == StatusCodes.Status404NotFound)
        {
            return "probe path did not route; declare a value in Visibility.ProbeValues for its route parameters";
        }
        return outcome.Status < StatusCodes.Status400BadRequest
            ? "response came back without the short-circuit marker, so the handler may have run"
            : null;
    }

    private static string ProbePath(
        RoutePattern pattern, IReadOnlyDictionary<string, string> overrides, RequestTemplate? template)
    {
        StringBuilder path = new();
        foreach (RoutePatternPathSegment segment in pattern.PathSegments)
        {
            path.Append('/');
            foreach (RoutePatternPart part in segment.Parts)
            {
                path.Append(part switch
                {
                    RoutePatternLiteralPart literal => literal.Content,
                    RoutePatternSeparatorPart separator => separator.Content,
                    RoutePatternParameterPart parameter => Uri.EscapeDataString(
                        ConstantFor(template, parameter.Name) ?? Placeholder(parameter, overrides)),
                    _ => string.Empty,
                });
            }
        }
        return path.Length == 0 ? "/" : path.ToString();
    }

    /// <summary>
    /// Guard: a family member is reachable only through its own key, so a placeholder or a host
    /// probe value would probe a different member, or none, and report its verdict for this one.
    /// </summary>
    private static string? ConstantFor(RequestTemplate? template, string name)
    {
        ParameterBinding? binding = template?.Parameters.FirstOrDefault(p =>
            p.Location == ParameterLocation.Path
            && string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
        if (binding?.Fill is not { Kind: ArgumentFillKind.Constant, Value: JsonValue value })
        {
            return null;
        }
        return value.GetValueKind() switch
        {
            JsonValueKind.String => value.GetValue<string>(),
            JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => value.ToJsonString(),
            _ => null,
        };
    }

    private static string Placeholder(RoutePatternParameterPart parameter, IReadOnlyDictionary<string, string> overrides)
    {
        if (overrides.TryGetValue(parameter.Name, out string? declared))
        {
            return declared;
        }
        foreach (RoutePatternParameterPolicyReference policy in parameter.ParameterPolicies)
        {
            string constraint = (policy.Content ?? string.Empty).ToLowerInvariant();
            if (constraint is "int" or "long" or "decimal" or "double" or "float"
                || constraint.StartsWith("min", StringComparison.Ordinal)
                || constraint.StartsWith("range", StringComparison.Ordinal))
            {
                return "1";
            }
            if (constraint == "guid")
            {
                return Guid.Empty.ToString();
            }
            if (constraint == "bool")
            {
                return "true";
            }
            if (constraint == "datetime")
            {
                return "2000-01-01";
            }
            if (constraint == "alpha")
            {
                return "probe";
            }
        }
        return "probe";
    }
}
