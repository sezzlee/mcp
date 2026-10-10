using System.Globalization;
using System.Text.Json.Nodes;
using Sezzlee.AspNetCore.Search;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore.Errors;

/// <summary>The size and structure facts a refusal carries in place of the discarded body.</summary>
internal readonly record struct OversizeResponse(int Bytes, int Limit, PayloadShape Shape, IReadOnlyList<FieldError>? Narrowing);

internal static class SdkErrors
{
    public const int DefaultMaxResponseBytes = 262_144;
    public const int DefaultInvokeTimeoutMs = 30_000;
    public const int DefaultMaxFileBytes = 16_777_216;

    public const string NarrowingFallback = "Constrains the result set.";

    public const int MaxNarrowingArguments = 8;

    private static readonly HashSet<string> CardinalityTokens = new(StringComparer.Ordinal)
    {
        "limit", "top", "take", "max", "count", "size", "page", "per",
    };

    private static readonly HashSet<string> SelectionTokens = new(StringComparer.Ordinal)
    {
        "offset", "skip", "cursor", "after", "before", "filter", "query",
        "search", "field", "select", "since", "from", "until", "status",
    };

    /// <summary>A fact about a value, never a string taken from it.</summary>
    /// <remarks>
    /// A text count is in UTF-16 code units, so <c>string.Length</c> and JavaScript's <c>.length</c>
    /// agree on the number a fixture pins; "characters" would not survive a non-BMP character.
    /// Pinned by conformance/error-mapping/oversize-text-utf16-count.json.
    /// </remarks>
    /// <param name="value">The parsed body, or the meta-tool payload about to be emitted.</param>
    public static PayloadShape Describe(JsonNode? value) => value switch
    {
        JsonArray array => new PayloadShape { Kind = PayloadShapeKind.Array, Count = array.Count },
        JsonObject o => new PayloadShape { Kind = PayloadShapeKind.Object, Count = o.Count },
        JsonValue v when v.TryGetValue(out string? text) => new PayloadShape
        {
            Kind = PayloadShapeKind.Text,
            Count = text!.Length,
        },
        _ => new PayloadShape { Kind = PayloadShapeKind.Text },
    };

    /// <summary>The published arguments that reduce how much an operation returns, most effective first.</summary>
    /// <param name="schema">The tool's published input schema.</param>
    public static IReadOnlyList<FieldError> NarrowingArguments(JsonObject? schema)
    {
        if (schema?["properties"] is not JsonObject properties)
        {
            return [];
        }
        List<FieldError> cardinality = [];
        List<FieldError> selection = [];
        foreach ((string name, JsonNode? property) in properties)
        {
            IReadOnlyList<string> tokens = ToolIndex.Tokenize(name);
            List<FieldError>? target =
                tokens.Any(CardinalityTokens.Contains) ? cardinality
                : tokens.Any(SelectionTokens.Contains) ? selection
                : null;
            target?.Add(new FieldError
            {
                Name = name,
                Message = (property as JsonObject)?["description"]?.GetValue<string>() ?? NarrowingFallback,
            });
        }
        return [.. cardinality.Concat(selection).Take(MaxNarrowingArguments)];
    }

    /// <summary>The shared SDK-side envelope, for codes that build their own message.</summary>
    public static SdkError Create(SdkErrorCode code, string message) =>
        new() { Error = code, Message = message, Retryable = false };

    /// <summary>Refuses a response that exceeded the payload budget.</summary>
    public static SdkError RefuseOversize(OversizeResponse refusal)
    {
        IReadOnlyList<FieldError> fields = refusal.Narrowing ?? [];
        string advice = fields.Count == 0
            ? "No argument of this call narrows the response."
            : $"Narrow it and call again: {string.Join(", ", fields.Select(field => field.Name))}.";
        string message = string.Format(
            CultureInfo.InvariantCulture,
            "The response is {0} bytes; the limit is {1} bytes. It is refused, not truncated: no part of the body was returned. {2} {3}",
            refusal.Bytes,
            refusal.Limit,
            ShapeSentence(refusal.Shape),
            advice);
        return new SdkError
        {
            Error = SdkErrorCode.ResponseTooLarge,
            Message = message,
            Retryable = false,
            Fields = fields.Count == 0 ? null : fields,
            Payload = new PayloadFacts { Bytes = refusal.Bytes, Limit = refusal.Limit, Shape = refusal.Shape },
        };
    }

    /// <summary>Refuses an invocation that outlived its deadline.</summary>
    /// <param name="limitMs">The deadline in whole milliseconds.</param>
    public static SdkError RefuseTimedOut(int limitMs) => new()
    {
        Error = SdkErrorCode.InvokeTimeout,
        Message = string.Format(
            CultureInfo.InvariantCulture,
            "The backend did not answer within {0} ms and the call was abandoned. The operation may already have been applied; re-read before retrying.",
            limitMs),
        Retryable = true,
    };

    public static SdkError RefuseChangedTool(string name) => new()
    {
        Error = SdkErrorCode.ToolChanged,
        Message = $"The tool '{name}' changed after it was loaded, so the call was refused before reaching the backend. Load it again with load_tool and retry with the new version.",
        Retryable = false,
    };

    public static SdkError RefuseRankerUnavailable() => new()
    {
        Error = SdkErrorCode.SearchRankerUnavailable,
        Message = "Search is unavailable: the ranker did not answer this query. Call search_tools again later.",
        Retryable = true,
    };

    /// <summary>Refuses a call whose <c>ref</c> file argument the resolver did not deliver.</summary>
    /// <remarks>
    /// Guard: <c>not_found</c> and <c>forbidden</c> produce one message. A ref is a string the agent
    /// wrote, and a refusal that told the two apart would let it probe which refs exist for other
    /// callers. The twin is <c>refuseUnresolvedFile</c> in packages/http/core/src/invoke-guard.ts.
    /// </remarks>
    public static SdkError RefuseUnresolvedFile(string field, string reason, int limit) => reason switch
    {
        "too_large" => new SdkError
        {
            Error = SdkErrorCode.FileTooLarge,
            Message = string.Format(
                CultureInfo.InvariantCulture,
                "File argument '{0}' is over the limit of {1} bytes and was not sent.",
                field,
                limit),
            Retryable = false,
        },
        "unavailable" => new SdkError
        {
            Error = SdkErrorCode.FileUnresolved,
            Message = $"File argument '{field}' could not be resolved right now. Retry the call.",
            Retryable = true,
        },
        _ => new SdkError
        {
            Error = SdkErrorCode.FileUnresolved,
            Message = $"File argument '{field}' names a ref that could not be resolved. Retrying with the same ref will not help.",
            Retryable = false,
        },
    };

    private static string ShapeSentence(PayloadShape shape)
    {
        if (shape.Count is not int count)
        {
            return "The body is not a JSON array or object.";
        }
        return shape.Kind switch
        {
            PayloadShapeKind.Array => string.Format(CultureInfo.InvariantCulture, "The body is an array of {0} items.", count),
            PayloadShapeKind.Object => string.Format(CultureInfo.InvariantCulture, "The body is an object with {0} properties.", count),
            _ => string.Format(CultureInfo.InvariantCulture, "The body is a text value of {0} characters.", count),
        };
    }
}
