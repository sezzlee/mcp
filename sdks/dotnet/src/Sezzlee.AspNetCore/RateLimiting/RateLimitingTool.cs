using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using Sezzlee.AspNetCore.Transport;

namespace Sezzlee.AspNetCore.RateLimiting;

/// <remarks>
/// Guard: it sits inside <see cref="SezzleeBudgetTool"/> so a throwing host key or partition function still
/// becomes that wrapper's <c>internal_error</c>, and the permits are released in <c>finally</c> only after
/// the inner call has returned, because a concurrency limiter frees its slot then and not before.
/// </remarks>
internal sealed class RateLimitingTool(McpServerTool inner, MetaToolRateLimiter limiter) : DelegatingMcpServerTool(inner)
{
    public override async ValueTask<CallToolResult> InvokeAsync(
        RequestContext<CallToolRequestParams> request,
        CancellationToken cancellationToken = default)
    {
        using MetaCallAdmission admission = await limiter
            .AdmitAsync(ProtocolTool.Name, request.Params?.Arguments, cancellationToken)
            .ConfigureAwait(false);
        if (admission.Refusal is { } refusal)
        {
            return SezzleeBudgetTool.Refuse(refusal);
        }
        return await base.InvokeAsync(request, cancellationToken).ConfigureAwait(false);
    }
}
