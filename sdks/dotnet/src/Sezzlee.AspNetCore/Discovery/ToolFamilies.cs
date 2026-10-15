using System.Globalization;
using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Sezzlee.AspNetCore.Naming;
using Sezzlee.AspNetCore.Spec;
using Microsoft.Extensions.DependencyInjection;
using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.AspNetCore.Discovery;

/// <summary>The value a family member writes into the dispatch parameter; it never reaches the agent.</summary>
public readonly record struct McpFamilyKey
{
    private readonly string? _text;
    private readonly long? _number;

    private McpFamilyKey(string? text, long? number)
    {
        _text = text;
        _number = number;
    }

    public static implicit operator McpFamilyKey(string value) =>
        new(value ?? throw new ArgumentNullException(nameof(value)), null);

    public static implicit operator McpFamilyKey(long value) => new(null, value);

    public static implicit operator McpFamilyKey(Guid value) => new(value.ToString("D"), null);

    internal JsonNode ToNode() => _number is { } number ? JsonValue.Create(number) : JsonValue.Create(_text ?? string.Empty);

    public override string ToString() =>
        _number?.ToString(CultureInfo.InvariantCulture) ?? _text ?? string.Empty;
}

/// <summary>
/// A family member's request body: a JSON Schema the host wrote, or a CLR shape the SDK maps the
/// same way it maps an action's body, through <c>options.Schema</c>.
/// </summary>
public abstract record McpFamilyBody
{
    private McpFamilyBody()
    {
    }

    public sealed record JsonSchema(JsonObject Value) : McpFamilyBody
    {
        public bool Equals(JsonSchema? other) =>
            other is not null && JsonNode.DeepEquals(Value, other.Value);

        public override int GetHashCode() => Value.ToJsonString().GetHashCode(StringComparison.Ordinal);
    }

    /// <summary>The body is one instance of <paramref name="Type"/>.</summary>
    public sealed record ClrType(Type Type) : McpFamilyBody;

    /// <summary>The body is an object with one property per parameter, named as declared.</summary>
    public sealed record Parameters(IReadOnlyList<ParameterInfo> Values) : McpFamilyBody
    {
        public bool Equals(Parameters? other) =>
            other is not null
            && Values.Count == other.Values.Count
            && Values.Zip(other.Values).All(pair =>
                pair.First.Member == pair.Second.Member && pair.First.Position == pair.Second.Position);

        public override int GetHashCode() => Values.Count;
    }

    public static implicit operator McpFamilyBody(JsonObject schema) =>
        new JsonSchema(schema ?? throw new ArgumentNullException(nameof(schema)));
}

/// <summary>One capability behind a dispatching operation, as a host's member source returns it.</summary>
/// <param name="Body">The member's own request body, published as its input schema.</param>
public sealed record McpFamilyMember(McpFamilyKey Key, string Name, string Description, McpFamilyBody Body)
{
    /// <summary>A member whose body is one instance of <paramref name="body"/>.</summary>
    public McpFamilyMember(McpFamilyKey key, string name, string description, Type body)
        : this(key, name, description, new McpFamilyBody.ClrType(body ?? throw new ArgumentNullException(nameof(body))))
    {
    }

    /// <summary>A member whose body carries <paramref name="body"/> as properties, such as a method's parameters.</summary>
    public McpFamilyMember(McpFamilyKey key, string name, string description, IReadOnlyList<ParameterInfo> body)
        : this(key, name, description, new McpFamilyBody.Parameters(body ?? throw new ArgumentNullException(nameof(body))))
    {
    }

    public bool? BodyRequired { get; init; }
    public bool? ReadOnly { get; init; }
    public bool? Destructive { get; init; }
    public bool? Idempotent { get; init; }

    /// <summary>
    /// Descriptions keyed by parameter name, for a member whose body is a method's parameters. One here
    /// wins over the parameter's <c>[Description]</c>; a blank one is ignored. Other bodies carry their own.
    /// </summary>
    public IReadOnlyDictionary<string, string>? ParameterDescriptions { get; init; }

    /// <remarks>
    /// Guard: written by hand because the synthesized comparison would compare
    /// <see cref="ParameterDescriptions"/> by reference. A source that builds a new dictionary on every
    /// load would then look changed on every refresh, rebuild the catalog and signal a tool-list change
    /// to every connected client each time.
    /// </remarks>
    public bool Equals(McpFamilyMember? other) =>
        other is not null
        && Key.Equals(other.Key)
        && string.Equals(Name, other.Name, StringComparison.Ordinal)
        && string.Equals(Description, other.Description, StringComparison.Ordinal)
        && Equals(Body, other.Body)
        && BodyRequired == other.BodyRequired
        && ReadOnly == other.ReadOnly
        && Destructive == other.Destructive
        && Idempotent == other.Idempotent
        && SameDescriptions(ParameterDescriptions, other.ParameterDescriptions);

    public override int GetHashCode() => HashCode.Combine(Key, Name, Description, Body);

    private static bool SameDescriptions(
        IReadOnlyDictionary<string, string>? left, IReadOnlyDictionary<string, string>? right)
    {
        if (left is null || right is null)
        {
            return left is null && right is null;
        }
        return left.Count == right.Count
            && left.All(pair => right.TryGetValue(pair.Key, out string? other)
                && string.Equals(pair.Value, other, StringComparison.Ordinal));
    }
}

/// <summary>Returns a family's members. It runs in its own service scope, outside any request.</summary>
public delegate ValueTask<IReadOnlyList<McpFamilyMember>> McpFamilySource(
    IServiceProvider services, CancellationToken cancellationToken);

public enum FamilyLoadMode
{
    /// <summary>Startup waits for the first load.</summary>
    Blocking,

    /// <summary>Startup does not wait; family operations join the catalog when their source returns.</summary>
    Background,
}

public enum FamilyLoadFailure
{
    /// <summary>A source that never returned drops its families and startup goes on.</summary>
    Drop,

    /// <summary>A source whose first load fails stops startup. Requires <see cref="FamilyLoadMode.Blocking"/>.</summary>
    Fatal,
}

public sealed class ToolFamilyOptions
{
    private readonly Dictionary<string, McpFamilySource> _sources = new(StringComparer.Ordinal);

    public IReadOnlyDictionary<string, McpFamilySource> Sources => _sources;

    public TimeSpan LoadTimeout { get; set; } = TimeSpan.FromSeconds(10);

    public FamilyLoadMode LoadMode { get; set; } = FamilyLoadMode.Blocking;

    /// <summary>
    /// How often sources are loaded again after the first load. <see cref="TimeSpan.Zero"/> loads
    /// them once. A refresh whose members equal the published ones changes nothing.
    /// </summary>
    public TimeSpan RefreshInterval { get; set; } = TimeSpan.Zero;

    public FamilyLoadFailure OnFailure { get; set; } = FamilyLoadFailure.Drop;

    public ToolFamilyOptions Provide(string name, McpFamilySource source)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(source);
        _sources[name] = source;
        return this;
    }
}

internal abstract record FamilyLoad
{
    internal sealed record Loaded(IReadOnlyList<McpFamilyMember> Members) : FamilyLoad;

    internal sealed record Stale(IReadOnlyList<McpFamilyMember> Members, Exception Error) : FamilyLoad;

    internal sealed record Failed(Exception Error) : FamilyLoad;

    internal IReadOnlyList<McpFamilyMember>? Published => this switch
    {
        Loaded loaded => loaded.Members,
        Stale stale => stale.Members,
        _ => null,
    };
}

internal abstract record FamilyResolution
{
    internal sealed record Members(
        ToolFamily Family,
        IReadOnlyList<ToolVariant> Variants,
        IReadOnlyList<CatalogDiagnostic> Diagnostics,
        IReadOnlyDictionary<string, McpFamilyMemberInfo> Origins)
        : FamilyResolution;

    internal sealed record Refused(CatalogDiagnostic Diagnostic) : FamilyResolution;
}

internal static partial class FamilyReader
{
    /// <summary>Loads every registered source once.</summary>
    /// <remarks>
    /// Guard: a source runs on the thread pool because a source that does its work synchronously
    /// before returning would otherwise hold the caller past <see cref="ToolFamilyOptions.LoadTimeout"/>,
    /// and hold startup in <see cref="FamilyLoadMode.Background"/>.
    /// A failing source keeps the members it last returned: dropping a family because its source
    /// was briefly unreachable would take working tools offline on every transient error.
    /// </remarks>
    public static async Task<IReadOnlyDictionary<string, FamilyLoad>> LoadAsync(
        ToolFamilyOptions options,
        IServiceScopeFactory? scopes,
        IReadOnlyDictionary<string, FamilyLoad>? previous,
        CancellationToken cancellationToken)
    {
        (string Name, FamilyLoad Load)[] loads = await Task.WhenAll(options.Sources.Select(async entry =>
        {
            try
            {
                using CancellationTokenSource deadline =
                    CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                deadline.CancelAfter(options.LoadTimeout);
                try
                {
                    IReadOnlyList<McpFamilyMember> members = await Task.Run(
                        () => LoadOneAsync(entry.Value, scopes, deadline.Token), deadline.Token)
                        .WaitAsync(deadline.Token);
                    return (entry.Key, (FamilyLoad)new FamilyLoad.Loaded(members ?? []));
                }
                catch (OperationCanceledException canceled)
                    when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
                {
                    throw new TimeoutException(
                        $"timeout: source '{entry.Key}' did not return within Families.LoadTimeout ({options.LoadTimeout}); raise options.Families.LoadTimeout or set options.Families.LoadMode to Background",
                        canceled);
                }
            }
            catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
            {
                FamilyLoad load = previous?.GetValueOrDefault(entry.Key) switch
                {
                    FamilyLoad.Loaded last => new FamilyLoad.Stale(last.Members, ex),
                    FamilyLoad.Stale last => new FamilyLoad.Stale(last.Members, ex),
                    _ => new FamilyLoad.Failed(ex),
                };
                return (entry.Key, load);
            }
        }));
        return loads.ToDictionary(l => l.Name, l => l.Load, StringComparer.Ordinal);
    }

    private static async Task<IReadOnlyList<McpFamilyMember>> LoadOneAsync(
        McpFamilySource source, IServiceScopeFactory? scopes, CancellationToken cancellationToken)
    {
        if (scopes is null)
        {
            return await source(EmptyServices.Instance, cancellationToken);
        }
        await using AsyncServiceScope scope = scopes.CreateAsyncScope();
        return await source(scope.ServiceProvider, cancellationToken);
    }

    /// <summary>Lowers one operation's family declaration into the variants its members become.</summary>
    /// <remarks>
    /// A defect in one member is that member's alone: the rest of the family stays published,
    /// because members are host data and one bad row should not take every sibling offline. Only
    /// a defect in the declaration itself refuses the operation.
    /// </remarks>
    public static FamilyResolution Resolve(
        McpToolFamilyAttribute declaration,
        string owner,
        IReadOnlyList<ToolVariant>? declared,
        ToolFamilyOptions options,
        IReadOnlyDictionary<string, FamilyLoad>? loads,
        SchemaMapperOptions schema)
    {
        ToolFamily family = new() { Parameter = declaration.Parameter };
        if (declaration.Source is null)
        {
            return new FamilyResolution.Members(family, [], [], new Dictionary<string, McpFamilyMemberInfo>());
        }
        if (!options.Sources.ContainsKey(declaration.Source))
        {
            return Refused(
                DiagnosticCodes.UnknownFamilySource,
                $"{owner} takes its members from source '{declaration.Source}', which is not registered; register it with options.Families.Provide.");
        }
        FamilyLoad? load = loads?.GetValueOrDefault(declaration.Source);
        List<CatalogDiagnostic> diagnostics = [];
        IReadOnlyList<McpFamilyMember> members;
        switch (load)
        {
            case null:
                return Refused(
                    DiagnosticCodes.FamilyNotLoaded,
                    $"{owner} was built before source '{declaration.Source}' finished loading; the catalog is rebuilt when it does.");
            case FamilyLoad.Failed failed:
                return Refused(
                    DiagnosticCodes.FamilySourceFailed,
                    $"{owner} has no members: source '{declaration.Source}' failed and has never returned any ({failed.Error.Message}).");
            case FamilyLoad.Stale stale:
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.FamilySourceStale,
                    $"{owner} keeps the members source '{declaration.Source}' last returned; the latest load failed ({stale.Error.Message})."));
                members = stale.Members;
                break;
            case FamilyLoad.Loaded loaded:
                members = loaded.Members;
                break;
            default:
                throw new InvalidOperationException($"Unhandled family load {load.GetType().Name}.");
        }

        HashSet<string> names = new((declared ?? []).Select(v => v.Name), StringComparer.Ordinal);
        HashSet<string> keys = new(StringComparer.Ordinal);
        List<ToolVariant> variants = [];
        Dictionary<string, McpFamilyMemberInfo> origins = new(StringComparer.Ordinal);
        foreach (McpFamilyMember member in members)
        {
            string? problem = ProblemOf(member, names, keys);
            JsonObject? body = null;
            if (problem is null)
            {
                (body, problem) = BodyOf(member, owner, schema, diagnostics);
            }
            if (problem is not null || body is null)
            {
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.FamilyMemberRejected,
                    $"{owner} drops member '{member.Name}': {problem}."));
                continue;
            }
            names.Add(member.Name);
            keys.Add(member.Key.ToNode().ToJsonString());
            variants.Add(Lower(member, body, declaration.Parameter));
            origins[member.Name] = new McpFamilyMemberInfo(declaration.Source, member.Key);
        }
        return new FamilyResolution.Members(family, variants, diagnostics, origins);
    }

    private static string? ProblemOf(McpFamilyMember member, HashSet<string> names, HashSet<string> keys)
    {
        if (member.Name is null || !ToolName().IsMatch(member.Name))
        {
            return "its name does not match the tool-name pattern";
        }
        if (string.IsNullOrWhiteSpace(member.Description))
        {
            return "it has no description";
        }
        if (names.Contains(member.Name))
        {
            return "another member or variant has the same name";
        }
        if (keys.Contains(member.Key.ToNode().ToJsonString()))
        {
            return "its key repeats another member's";
        }
        return null;
    }

    private static (JsonObject? Body, string? Problem) BodyOf(
        McpFamilyMember member, string owner, SchemaMapperOptions schema, List<CatalogDiagnostic> diagnostics)
    {
        SchemaMapperOptions reporting = schema with
        {
            Report = note => diagnostics.Add(note with { Message = $"{owner} member '{member.Name}': {note.Message}" }),
        };
        JsonObject? body = member.Body switch
        {
            McpFamilyBody.JsonSchema declared => declared.Value,
            McpFamilyBody.ClrType clr => JsonSchemaMapper.Map(clr.Type, reporting),
            McpFamilyBody.Parameters parameters => JsonSchemaMapper.Map(parameters.Values, reporting, member.ParameterDescriptions),
            _ => null,
        };
        if (body is null)
        {
            return (null, "its body is not a JSON Schema object");
        }
        string? invalid = FamilyRules.DeclaredSchemaProblem(body);
        return invalid is null ? (body, null) : (null, $"its body {invalid}");
    }

    private static ToolVariant Lower(McpFamilyMember member, JsonObject body, string parameter)
    {
        bool annotated = member.ReadOnly is not null || member.Destructive is not null || member.Idempotent is not null;
        return new ToolVariant
        {
            Name = member.Name,
            Description = member.Description,
            Arguments =
            [
                new ArgumentCuration
                {
                    Name = parameter,
                    Hidden = new ArgumentFill { Kind = ArgumentFillKind.Constant, Value = member.Key.ToNode() },
                },
            ],
            RequestBody = new VariantRequestBody
            {
                Schema = (JsonObject)body.DeepClone(),
                Required = member.BodyRequired
                    ?? (member.Body is McpFamilyBody.Parameters
                        ? body["required"] is JsonArray { Count: > 0 }
                        : null),
            },
            Annotations = annotated
                ? new ToolAnnotations
                {
                    ReadOnlyHint = member.ReadOnly,
                    DestructiveHint = member.Destructive,
                    IdempotentHint = member.Idempotent,
                }
                : null,
        };
    }

    private static FamilyResolution Refused(string code, string message) =>
        new FamilyResolution.Refused(new CatalogDiagnostic(code, message));

    [GeneratedRegex("^[a-z][a-z0-9_]{0,255}$")]
    private static partial Regex ToolName();

    private sealed class EmptyServices : IServiceProvider
    {
        public static readonly EmptyServices Instance = new();

        public object? GetService(Type serviceType) => null;
    }
}
