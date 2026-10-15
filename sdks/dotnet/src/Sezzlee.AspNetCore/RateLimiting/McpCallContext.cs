using Microsoft.AspNetCore.Http;
using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.AspNetCore.RateLimiting;

/// <summary>How a <c>tools/call</c> request is classified: by <c>search_tools</c>, <c>load_tool</c>, <c>invoke_tool</c>, or any other tool on the server.</summary>
public enum McpMetaTool
{
    Search,
    Load,
    Invoke,
    Other,
}

/// <summary>What a rate-limit key or partition function sees of one <c>tools/call</c> request.</summary>
/// <param name="HttpContext">The request that carries the MCP call, from which the host reads its own identity; null outside a request.</param>
/// <param name="MetaTool">How the call is classified.</param>
/// <param name="Target">
/// The catalog tool a <c>load_tool</c> or <c>invoke_tool</c> call names, looked up without consulting
/// visibility; null for any other call, and when the <c>name</c> argument is missing, not a string or unknown.
/// </param>
/// <param name="ToolName">The name of the MCP tool the request calls.</param>
/// <param name="CallerScope">The caller scope key.</param>
public sealed record McpCallContext(
    HttpContext? HttpContext,
    McpMetaTool MetaTool,
    McpToolInfo? Target,
    string ToolName,
    string CallerScope);
