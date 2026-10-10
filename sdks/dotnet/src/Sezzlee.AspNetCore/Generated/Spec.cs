using System.Text.Json.Nodes;

namespace Sezzlee.AspNetCore.Spec;

public static class SezzleeSpec
{
    public const string Version = "1.0.0";
}

public static class ProtocolRevision
{
    public const string V20251125 = "2025-11-25";
    public const string V20260728 = "2026-07-28";

    public const string Default = "2026-07-28";

    public static readonly IReadOnlyList<string> All = [V20251125, V20260728];
}

public sealed record EndpointDescriptor
{
    public string? OperationId { get; init; }
    public string? Container { get; init; }
    public string? ContainerPrefix { get; init; }
    public string? ToolName { get; init; }
    public required string Method { get; init; }
    public required string Route { get; init; }
    public string? Description { get; init; }
    public bool? Deprecated { get; init; }
    public IReadOnlyList<Parameter>? Parameters { get; init; }
    public RequestBody? RequestBody { get; init; }
    public IReadOnlyDictionary<string, ResponseBody>? Responses { get; init; }
    public required Auth Auth { get; init; }
    public IReadOnlyList<string>? Tags { get; init; }
    public IReadOnlyList<string>? SearchTerms { get; init; }
    public IReadOnlyList<ArgumentCuration>? Arguments { get; init; }
    public IReadOnlyList<ToolVariant>? Variants { get; init; }
    public ToolFamily? Family { get; init; }
    public ToolAnnotations? Annotations { get; init; }
}

public sealed record Parameter
{
    public required string Name { get; init; }
    public required string In { get; init; }
    public required bool Required { get; init; }
    public required JsonObject Schema { get; init; }
    public string? Style { get; init; }
    public bool? Explode { get; init; }
    public string? ObjectNotation { get; init; }
    public string? Description { get; init; }
    public string? ContentType { get; init; }
    public bool? AllowReserved { get; init; }
}

public sealed record RequestBody
{
    public required JsonObject Schema { get; init; }
    public bool? Required { get; init; }
    public string? Description { get; init; }
    public string? ContentType { get; init; }
    public string? ObjectNotation { get; init; }
}

public sealed record ResponseBody
{
    public JsonObject? Schema { get; init; }
    public string? Description { get; init; }
}

public sealed record ArgumentCuration
{
    public required string Name { get; init; }
    public string? As { get; init; }
    public string? Description { get; init; }
    public ArgumentFill? Hidden { get; init; }
}

public enum ArgumentFillKind { Constant, Deferred, Omit }

public sealed record ArgumentFill
{
    public required ArgumentFillKind Kind { get; init; }
    public JsonNode? Value { get; init; }
    public string? Source { get; init; }
}

public sealed record ToolVariant
{
    public required string Name { get; init; }
    public required string Description { get; init; }
    public IReadOnlyList<ArgumentCuration>? Arguments { get; init; }
    public VariantRequestBody? RequestBody { get; init; }
    public ToolAnnotations? Annotations { get; init; }
}

public sealed record ToolFamily
{
    public required string Parameter { get; init; }
}

public sealed record VariantRequestBody
{
    public required JsonObject Schema { get; init; }
    public bool? Required { get; init; }
    public string? Description { get; init; }
}

public sealed record Auth
{
    public required Anonymity Anonymous { get; init; }
    public required IReadOnlyList<string> Policies { get; init; }
    public required bool Imperative { get; init; }
    public IReadOnlyList<IdentityCarrier>? Carriers { get; init; }
}

public enum Anonymity { Yes, No, Unknown }

public sealed record IdentityCarrier
{
    public required string In { get; init; }
    public required string Name { get; init; }
}

public sealed record ToolDefinition
{
    public required string Name { get; init; }
    public required string Description { get; init; }
    public bool? Deprecated { get; init; }
    public required JsonObject InputSchema { get; init; }
    public JsonObject? OutputSchema { get; init; }
    public required ToolAnnotations Annotations { get; init; }
    public required Auth Auth { get; init; }
}

public sealed record ToolAnnotations
{
    public bool? ReadOnlyHint { get; init; }
    public bool? DestructiveHint { get; init; }
    public bool? IdempotentHint { get; init; }
}

public enum BackendErrorCode { ValidationFailed, BadRequest, Unauthenticated, Forbidden, NotFound, Conflict, RateLimited, BackendError, BackendUnavailable }

public sealed record FieldError
{
    public string? Name { get; init; }
    public required string Message { get; init; }
}

public sealed record MappedError
{
    public required BackendErrorCode Error { get; init; }
    public required string Message { get; init; }
    public required int Status { get; init; }
    public required bool Retryable { get; init; }
    public IReadOnlyList<FieldError>? Fields { get; init; }
    public int? RetryAfterSeconds { get; init; }
    public string? Reference { get; init; }
}

public sealed record InvokeSuccess
{
    public required int Status { get; init; }
    public JsonNode? Body { get; init; }
    public string? ContentType { get; init; }
    public string? Location { get; init; }
}

public enum SdkErrorCode { UnknownTool, NotInvocable, UnknownArgument, InvalidPathType, MissingPathParameter, HeaderInjection, NullNotAllowed, InvalidType, DeferredValueMissing, DeferredValueInvalid, InvalidCookieValue, CookieCarrierCollision, InvalidFileArgument, FileTooLarge, FileUnresolved, ResponseTooLarge, InvokeTimeout, SearchRankerUnavailable, InternalError, ToolChanged }

public enum PayloadShapeKind { Array, Object, Text }

public sealed record PayloadShape
{
    public required PayloadShapeKind Kind { get; init; }
    public int? Count { get; init; }
}

public sealed record PayloadFacts
{
    public required int Bytes { get; init; }
    public required int Limit { get; init; }
    public required PayloadShape Shape { get; init; }
}

public sealed record SdkError
{
    public required SdkErrorCode Error { get; init; }
    public required string Message { get; init; }
    public required bool Retryable { get; init; }
    public IReadOnlyList<FieldError>? Fields { get; init; }
    public PayloadFacts? Payload { get; init; }
}

public sealed record TypeShape
{
    public required TypeNode Root { get; init; }
    public required IReadOnlyDictionary<string, ObjectType> Types { get; init; }
}

public sealed record TypeNode
{
    public required TypeKind Kind { get; init; }
    public ScalarKind? Scalar { get; init; }
    public string? Format { get; init; }
    public TypeNode? Items { get; init; }
    public TypeNode? Values { get; init; }
    public MapKey? Keys { get; init; }
    public EnumFacts? EnumFacts { get; init; }
    public string? Ref { get; init; }
    public JsonObject? Schema { get; init; }
    public string? Reason { get; init; }
}

public enum TypeKind { Scalar, Binary, Enum, Map, Array, Ref, Verbatim, Unknown }

public enum ScalarKind { String, Boolean, Integer, Number }

public sealed record MapKey
{
    public required bool Writable { get; init; }
    public ScalarKind? Scalar { get; init; }
    public string? Format { get; init; }
}

public sealed record EnumFacts
{
    public required EnumWireForm WireForm { get; init; }
    public bool? Combinable { get; init; }
    public required IReadOnlyList<string> Names { get; init; }
    public required IReadOnlyList<int> Numbers { get; init; }
}

public enum EnumWireForm { String, Integer, Unresolved }

public sealed record ObjectType
{
    public required string Name { get; init; }
    public string? Description { get; init; }
    public bool? Wrapper { get; init; }
    public required IReadOnlyList<Member> Members { get; init; }
}

public sealed record Member
{
    public required string Name { get; init; }
    public required TypeNode Type { get; init; }
    public required bool Required { get; init; }
    public required bool ReadOnly { get; init; }
    public required bool ConstructorBound { get; init; }
    public string? Description { get; init; }
    public Constraints? Constraints { get; init; }
}

public sealed record Constraints
{
    public int? MinSize { get; init; }
    public int? MaxSize { get; init; }
    public double? Minimum { get; init; }
    public double? Maximum { get; init; }
    public string? Pattern { get; init; }
    public string? Format { get; init; }
}
