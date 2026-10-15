using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using Sezzlee.AspNetCore.Errors;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore.Transport;

/// <summary>
/// The backstop for the payload budget. <c>SezzleeMetaTools.Respond</c> is the primary gate, but
/// <c>[McpServerToolType]</c> turns any method added to that type later into a tool that skips it.
/// This wrapper sees the final <see cref="CallToolResult"/>, so nothing registered on the server can
/// reach the agent over budget. Pinned by ResponseBudgetTests.
/// </summary>
/// <remarks>
/// Guard: it is also the only place that sees a throw. A meta-tool argument the agent misnames never
/// reaches the handler — the framework's own binder rejects it first — so without this catch the
/// agent gets a bare "An error occurred invoking 'load_tool'", which names neither the argument it
/// sent nor the one the tool wanted, and the turn dies with nothing to repair from. Measured, not
/// theorised: a model called <c>load_tool</c> with <c>operation</c> instead of <c>name</c>.
/// </remarks>
internal sealed class SezzleeBudgetTool(McpServerTool inner, IOptions<SezzleeOptions> options)
    : DelegatingMcpServerTool(inner)
{
    public override async ValueTask<CallToolResult> InvokeAsync(
        RequestContext<CallToolRequestParams> request,
        CancellationToken cancellationToken = default)
    {
        CallToolResult result;
        try
        {
            result = await base.InvokeAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (ArgumentException)
        {
            return Refuse(SdkErrors.Create(SdkErrorCode.UnknownArgument, DescribeBindingFailure(request)));
        }
        catch (JsonException)
        {
            return Refuse(SdkErrors.Create(SdkErrorCode.UnknownArgument, DescribeBindingFailure(request)));
        }
        catch (Exception ex)
        {
            string? forwardable = LeakFilter.Forwardable(ex.Message);
            return Refuse(SdkErrors.Create(
                SdkErrorCode.InternalError,
                forwardable is null
                    ? "The operation failed inside the sezzlee layer. Details were withheld."
                    : $"The operation failed inside the sezzlee layer: {forwardable}"));
        }

        int limit = options.Value.Invoke.MaxResponseBytes;
        int bytes = 0;
        foreach (ContentBlock block in result.Content)
        {
            if (block is TextContentBlock text)
            {
                bytes += Encoding.UTF8.GetByteCount(text.Text);
            }
        }
        if (bytes <= limit)
        {
            return result;
        }
        return Refuse(SdkErrors.RefuseOversize(new OversizeResponse(
            bytes,
            limit,
            new PayloadShape { Kind = PayloadShapeKind.Text, Count = bytes },
            null)));
    }

    internal static CallToolResult Refuse(SdkError error) => new()
    {
        IsError = true,
        Content = [new TextContentBlock { Text = JsonSerializer.Serialize(error, SezzleeJson.Wire) }],
    };

    private string DescribeBindingFailure(RequestContext<CallToolRequestParams> request)
    {
        IReadOnlyList<string> declared = DeclaredArguments();
        IDictionary<string, JsonElement>? sent = request.Params?.Arguments;
        List<string> unexpected = [];
        if (sent is not null)
        {
            foreach (string name in sent.Keys)
            {
                if (!declared.Contains(name, StringComparer.Ordinal))
                {
                    unexpected.Add(name);
                }
            }
        }

        StringBuilder message = new();
        message.Append("Tool '").Append(ProtocolTool.Name).Append("' was called with arguments it could not bind.");
        if (unexpected.Count > 0)
        {
            message.Append(" It does not take ").Append(Quote(unexpected)).Append('.');
        }
        message.Append(declared.Count == 0
            ? " It takes no arguments."
            : $" It takes {Quote(declared)}.");
        message.Append(" Call it again using those names exactly.");

        return message.ToString();
    }

    private IReadOnlyList<string> DeclaredArguments()
    {
        JsonElement schema = ProtocolTool.InputSchema;
        if (schema.ValueKind != JsonValueKind.Object
            || !schema.TryGetProperty("properties", out JsonElement properties)
            || properties.ValueKind != JsonValueKind.Object)
        {
            return [];
        }
        List<string> names = [];
        foreach (JsonProperty property in properties.EnumerateObject())
        {
            names.Add(property.Name);
        }
        return names;
    }

    private static string Quote(IReadOnlyList<string> names) =>
        string.Join(", ", names.Select(name => $"'{name}'"));
}
