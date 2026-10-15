using Microsoft.AspNetCore.Http;

namespace Sezzlee.AspNetCore.Testing;

/// <summary>One identity to audit.</summary>
/// <param name="Name">Names the caller in findings; unique within one audit.</param>
/// <param name="Prepare">Sets on the outer request what the caller's MCP requests carry, such as its authorization header.</param>
public sealed record AuditCaller(string Name, Action<HttpRequest> Prepare)
{
    /// <summary>A caller whose requests carry exactly these headers.</summary>
    public static AuditCaller WithHeaders(string name, params (string Name, string Value)[] headers) =>
        new(name, request =>
        {
            foreach ((string header, string value) in headers)
            {
                request.Headers[header] = value;
            }
        });
}
