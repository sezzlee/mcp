using System.Text.Json;
using System.Text.Json.Nodes;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore;

/// <summary>
/// The <c>x-sezzlee</c> extensions that let an OpenAPI gateway rebuild this backend's catalog from
/// its OpenAPI document (openapi-ingestion.md §The x-sezzlee extension).
/// </summary>
/// <param name="Document">The document root's extension, or <c>null</c> when it declares nothing.</param>
/// <param name="Paths">Each path item's extension, keyed by the OpenAPI path template.</param>
/// <param name="Operations">
/// Each operation's extension, keyed by <c>METHOD /path</c>; the same map is a valid
/// <c>operations</c> block of the gateway's configuration.
/// </param>
public sealed record SezzleeOpenApiSnapshot(
    JsonObject? Document,
    IReadOnlyDictionary<string, JsonObject> Paths,
    IReadOnlyDictionary<string, JsonObject> Operations)
{
    public const string Key = "x-sezzlee";
}

/// <summary>Reads the current catalog as <c>x-sezzlee</c> extensions; every read reflects the latest reload.</summary>
public sealed class SezzleeOpenApiExtensions
{
    private readonly SezzleeCatalogProvider _catalog;

    internal SezzleeOpenApiExtensions(SezzleeCatalogProvider catalog) => _catalog = catalog;

    public SezzleeOpenApiSnapshot Current => OpenApiExtensionWriter.Write(_catalog.Result);
}

internal static class OpenApiExtensionWriter
{
    public static SezzleeOpenApiSnapshot Write(CatalogBuildResult result)
    {
        Dictionary<string, JsonObject> operations = new(StringComparer.Ordinal);
        Dictionary<string, HashSet<int?>> containers = new(StringComparer.Ordinal);
        foreach ((string key, EndpointDescriptor? descriptor) in result.Operations)
        {
            operations[key] = Serialize(Extension(descriptor, result.ToolNames.GetValueOrDefault(key)));
            if (descriptor is not null)
            {
                string route = key[(key.IndexOf(' ') + 1)..];
                if (!containers.TryGetValue(route, out HashSet<int?>? levels))
                {
                    containers[route] = levels = [];
                }
                levels.Add(descriptor.Revision?.Container);
            }
        }
        Dictionary<string, JsonObject> paths = new(StringComparer.Ordinal);
        foreach ((string route, HashSet<int?> levels) in containers)
        {
            if (levels.Count == 1 && levels.Single() is int revision)
            {
                paths[route] = Serialize(new ScopeExtension { Revision = revision });
            }
        }
        JsonObject? document = result.CatalogRevision is int catalog
            ? Serialize(new ScopeExtension { Revision = catalog })
            : null;
        return new SezzleeOpenApiSnapshot(document, paths, operations);
    }

    /// <summary>
    /// Guard: the published name is written whole, prefix included, instead of the declarations it
    /// came from. A generator writes no operationId for most actions, so a gateway left to derive
    /// the name would read the route where the SDK read the action, and every such tool would be
    /// renamed between the two hosts.
    /// </summary>
    private static OperationExtension Extension(EndpointDescriptor? descriptor, string? toolName)
    {
        if (descriptor is null)
        {
            return new OperationExtension { Tool = false };
        }
        return new OperationExtension
        {
            Tool = true,
            ToolName = descriptor.Variants is null ? toolName : null,
            Annotations = descriptor.Annotations is { ReadOnlyHint: null, DestructiveHint: null, IdempotentHint: null }
                ? null
                : descriptor.Annotations,
            Arguments = descriptor.Arguments,
            Variants = descriptor.Family is null ? descriptor.Variants : null,
            Family = descriptor.Family is { } family ? FamilyOf(family, descriptor.Variants) : null,
            SearchTerms = descriptor.SearchTerms,
            Revision = descriptor.Revision?.Operation,
        };
    }

    /// <summary>
    /// Guard: a variant whose dispatch key is not a hidden constant cannot be written as a member,
    /// and the SDK itself refuses it as <c>family_key_unfilled</c>, so it is left out rather than
    /// published as a member with a guessed key.
    /// </summary>
    private static FamilyDeclaration FamilyOf(ToolFamily family, IReadOnlyList<ToolVariant>? variants)
    {
        List<FamilyMember> members = [];
        foreach (ToolVariant variant in variants ?? [])
        {
            ArgumentCuration? dispatch = variant.Arguments?.FirstOrDefault(argument =>
                argument.Name == family.Parameter && argument.Hidden?.Kind == ArgumentFillKind.Constant);
            if (dispatch?.Hidden?.Value is not { } key)
            {
                continue;
            }
            List<ArgumentCuration> rest = [.. variant.Arguments!.Where(argument => !ReferenceEquals(argument, dispatch))];
            members.Add(new FamilyMember
            {
                Key = key.DeepClone(),
                Name = variant.Name,
                Description = variant.Description,
                Arguments = rest.Count == 0 ? null : rest,
                RequestBody = variant.RequestBody,
                Annotations = variant.Annotations,
            });
        }
        return new FamilyDeclaration { Parameter = family.Parameter, Members = members };
    }

    private static JsonObject Serialize<T>(T value) =>
        JsonSerializer.SerializeToNode(value, SezzleeJson.Wire)?.AsObject()
        ?? throw new InvalidOperationException($"{typeof(T).Name} serialized to null.");
}
