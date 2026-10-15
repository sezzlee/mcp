using System.Reflection;
using Microsoft.AspNetCore.Http;
using Sezzlee.AspNetCore.Discovery;

namespace Sezzlee.AspNetCore.Visibility;

/// <summary>The family member a tool was lowered from.</summary>
/// <param name="Source">The name the family source was registered under in <c>options.Families.Provide</c>.</param>
/// <param name="Key">The member's key, the value the tool writes into the dispatch parameter.</param>
public sealed record McpFamilyMemberInfo(string Source, McpFamilyKey Key);

/// <summary>What a host authorizer sees of one published tool.</summary>
/// <param name="Name">The published tool name.</param>
/// <param name="Method">The upper-case HTTP method.</param>
/// <param name="Route">The normalized route template; a family member carries its operation's.</param>
/// <param name="Container">The controller's full type name; null for a minimal API endpoint.</param>
/// <param name="Action">The controller action's method; null for a minimal API endpoint.</param>
/// <param name="Metadata">The endpoint's metadata.</param>
/// <param name="Member">The family member the tool was lowered from; null for any other tool.</param>
public sealed record McpToolInfo(
    string Name,
    string Method,
    string Route,
    string? Container,
    MethodInfo? Action,
    IReadOnlyList<object> Metadata,
    McpFamilyMemberInfo? Member);

/// <summary>
/// Decides tool visibility from the host's own authorization, above the declarative and probe tiers.
/// Register it with the container; with none registered visibility behaves as without this tier.
/// </summary>
public interface IToolAuthorizer
{
    /// <summary>
    /// Whether this authorizer decides <paramref name="tool"/> for every caller. Caller-independent: the
    /// startup coverage check reports a tool no tier covers.
    /// </summary>
    bool Covers(McpToolInfo tool);

    /// <summary>
    /// Resolves what the caller may use. Called once per caller scope for <c>Cache.Lifetime</c>, so the
    /// returned object is kept beyond the call and must not hold a service scope or the request.
    /// </summary>
    /// <param name="outerRequest">The request that carries the MCP call; null outside a request.</param>
    /// <param name="cancellationToken">Cancelled when the caller stops waiting.</param>
    ValueTask<IToolAccess> ResolveAsync(HttpRequest? outerRequest, CancellationToken cancellationToken);
}

/// <summary>What one caller may use.</summary>
public interface IToolAccess
{
    /// <summary>
    /// Synchronous and cheap, because it runs for every tool of a search.
    /// <see cref="VisibilityDecision.Unknown"/> falls through to the declarative and probe tiers.
    /// </summary>
    VisibilityDecision Decide(McpToolInfo tool);
}
