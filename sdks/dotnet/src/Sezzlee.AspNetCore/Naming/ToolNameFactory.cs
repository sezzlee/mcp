using System.Text;
using System.Text.RegularExpressions;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore.Naming;

public enum PrefixMode { Always, OnCollision }

/// <param name="Operation">The declared operation: its identity folds routes and owns diagnostics.</param>
/// <param name="Endpoint">The descriptor the tool and its template are built from; a family member's carries the member's body.</param>
internal sealed record ToolProduction(EndpointDescriptor Operation, EndpointDescriptor Endpoint, ToolVariant? Variant);

internal static partial class ToolNameFactory
{
    public const int LongNameThreshold = 64;
    public const string NameDisambiguated = "name_disambiguated";

    private const string ControllerSuffix = "Controller";

    public static string Create(EndpointDescriptor endpoint, PrefixMode mode = PrefixMode.Always)
    {
        ArgumentNullException.ThrowIfNull(endpoint);

        if (endpoint.ToolName is not null)
        {
            return Validate(endpoint.ToolName, endpoint);
        }

        string body = CreateBody(endpoint);
        string name = mode == PrefixMode.Always ? ApplyPrefix(body, DerivePrefix(endpoint)) : body;
        return Validate(name, endpoint);
    }

    public static string CreateBody(EndpointDescriptor endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        return string.IsNullOrWhiteSpace(endpoint.OperationId)
            ? FromRoute(endpoint)
            : SnakeCase(endpoint.OperationId);
    }

    public static string? DerivePrefix(EndpointDescriptor endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);

        if (endpoint.ContainerPrefix is not null)
        {
            return SnakeCase(endpoint.ContainerPrefix);
        }
        if (string.IsNullOrWhiteSpace(endpoint.Container))
        {
            return null;
        }

        string last = endpoint.Container.Split('.', StringSplitOptions.RemoveEmptyEntries) is { Length: > 0 } segments
            ? segments[^1]
            : string.Empty;
        if (last.Length > ControllerSuffix.Length && last.EndsWith(ControllerSuffix, StringComparison.Ordinal))
        {
            last = last[..^ControllerSuffix.Length];
        }
        string prefix = SnakeCase(last);
        return prefix.Length == 0 ? null : prefix;
    }

    public static string ApplyPrefix(string body, string? prefix)
    {
        ArgumentNullException.ThrowIfNull(body);
        return string.IsNullOrEmpty(prefix) || IsRedundant(prefix, body)
            ? body
            : Collapse($"{prefix}_{body}");
    }

    public static bool IsValidName(string name) => ToolNamePattern().IsMatch(name);

    private static string Validate(string name, EndpointDescriptor endpoint)
    {
        if (!IsValidName(name))
        {
            throw new SezzleeCatalogException(
                SezzleeCatalogException.InvalidName,
                $"Generated tool name '{name}' for {endpoint.Method} {endpoint.Route} does not match the required pattern; define an operationId or a tool name.");
        }
        return name;
    }

    private static string Fold(string token) =>
        token.Length > 3 && token.EndsWith('s') ? token[..^1] : token;

    private static string[] TokensOf(string name) =>
        name.Split('_', StringSplitOptions.RemoveEmptyEntries).Select(Fold).ToArray();

    private static bool IsRedundant(string prefix, string body)
    {
        string[] prefixTokens = TokensOf(prefix);
        string[] bodyTokens = TokensOf(body);
        if (prefixTokens.Length == 0 || prefixTokens.Length > bodyTokens.Length)
        {
            return false;
        }
        for (int start = 0; start + prefixTokens.Length <= bodyTokens.Length; start++)
        {
            bool match = true;
            for (int offset = 0; offset < prefixTokens.Length; offset++)
            {
                if (!string.Equals(bodyTokens[start + offset], prefixTokens[offset], StringComparison.Ordinal))
                {
                    match = false;
                    break;
                }
            }
            if (match)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>Folds routes first, then expands variants.</summary>
    /// <remarks>
    /// The order is what keeps <see cref="Deduplicate"/> unchanged: it never sees a variant, so its
    /// grouping key stays the operation identity. It is also the single place productions are
    /// enumerated — naming used to fold internally while the catalog folded again, which is
    /// idempotent for plain operations and is not for variants, where a second fold would return
    /// fewer names than tools and misalign the catalog's positional zip.
    /// </remarks>
    public static IReadOnlyList<ToolProduction> ExpandProductions<T>(
        IEnumerable<T> items,
        Func<T, EndpointDescriptor> selector,
        Action<T, IReadOnlyList<T>>? onFolded = null)
    {
        List<ToolProduction> productions = [];
        foreach (T item in Deduplicate(items, selector, onFolded))
        {
            productions.AddRange(ProductionsOf(selector(item)));
        }
        return productions;
    }

    /// <summary>The productions of one already-folded operation.</summary>
    /// <exception cref="SezzleeTemplateException">The operation's variant or family declaration is refused.</exception>
    public static IReadOnlyList<ToolProduction> ProductionsOf(EndpointDescriptor operation)
    {
        if (operation.Variants is null)
        {
            FamilyRules.Assert(operation);
            return [new ToolProduction(operation, operation, null)];
        }
        if (operation.ToolName is not null)
        {
            throw new SezzleeTemplateException(
                SezzleeTemplateException.VariantDeclarationConflict,
                $"{operation.Method} {operation.Route} declares both a tool name and variants; a variant names itself.");
        }
        FamilyRules.Assert(operation);
        return [.. operation.Variants.Select(variant =>
            new ToolProduction(operation, FamilyRules.ProductionDescriptor(operation, variant), variant))];
    }

    public static string VariantName(ToolVariant variant, EndpointDescriptor operation)
    {
        if (!ToolNamePattern().IsMatch(variant.Name))
        {
            throw new SezzleeCatalogException(
                SezzleeCatalogException.InvalidName,
                $"Variant name '{variant.Name}' of {operation.Method} {operation.Route} does not match the required pattern.");
        }
        return variant.Name;
    }

    public static IReadOnlyList<string> CreateAll(
        IEnumerable<EndpointDescriptor> endpoints,
        PrefixMode mode = PrefixMode.Always,
        Action<string, string>? onDiagnostic = null)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        List<ToolProduction> operations = [.. ExpandProductions(endpoints, e => e)];
        List<string> names =
            [.. operations.Select(p => p.Variant is null ? Create(p.Operation, mode) : VariantName(p.Variant, p.Operation))];

        if (mode == PrefixMode.OnCollision)
        {
            Dictionary<string, List<int>> groups = new(StringComparer.Ordinal);
            for (int index = 0; index < operations.Count; index++)
            {
                if (operations[index].Operation.ToolName is not null
                    || operations[index].Variant is not null)
                {
                    continue;
                }
                if (!groups.TryGetValue(names[index], out List<int>? group))
                {
                    groups[names[index]] = [index];
                }
                else
                {
                    group.Add(index);
                }
            }
            foreach ((string body, List<int> group) in groups)
            {
                if (group.Count < 2)
                {
                    continue;
                }
                foreach (int index in group)
                {
                    EndpointDescriptor endpoint = operations[index].Operation;
                    string prefixed = ApplyPrefix(body, DerivePrefix(endpoint));
                    if (string.Equals(prefixed, body, StringComparison.Ordinal))
                    {
                        continue;
                    }
                    names[index] = prefixed;
                    onDiagnostic?.Invoke(
                        NameDisambiguated,
                        $"Tool name '{body}' collided; {endpoint.Method} {endpoint.Route} is exposed as '{prefixed}'.");
                }
            }
        }

        Dictionary<string, EndpointDescriptor> claimed = new(StringComparer.Ordinal);
        for (int index = 0; index < operations.Count; index++)
        {
            if (claimed.TryGetValue(names[index], out EndpointDescriptor? owner))
            {
                throw new SezzleeCatalogException(
                    SezzleeCatalogException.NameCollision,
                    $"Tool name '{names[index]}' is produced by both {owner.Method} {owner.Route} and {operations[index].Operation.Method} {operations[index].Operation.Route}; declare a tool name on one of them.");
            }
            claimed[names[index]] = operations[index].Operation;
        }
        return names;
    }

    public static IReadOnlyList<T> Deduplicate<T>(
        IEnumerable<T> items,
        Func<T, EndpointDescriptor> selector,
        Action<T, IReadOnlyList<T>>? onFolded = null)
    {
        ArgumentNullException.ThrowIfNull(items);
        ArgumentNullException.ThrowIfNull(selector);

        List<T> operations = [];
        Dictionary<(string Container, string OperationId, string Method), (int Operation, int Member)> seen = [];
        Dictionary<(string Container, string OperationId, string Method), List<T>> grouped = [];

        foreach (T item in items)
        {
            EndpointDescriptor endpoint = selector(item);
            if (string.IsNullOrWhiteSpace(endpoint.OperationId))
            {
                operations.Add(item);
                continue;
            }

            (string, string, string) key = (
                endpoint.Container ?? string.Empty,
                endpoint.OperationId,
                endpoint.Method.ToUpperInvariant());

            if (!grouped.TryGetValue(key, out List<T>? members))
            {
                members = [];
                grouped[key] = members;
            }
            members.Add(item);

            if (!seen.TryGetValue(key, out (int Operation, int Member) position))
            {
                seen[key] = (operations.Count, members.Count - 1);
                operations.Add(item);
                continue;
            }
            if (Shorter(endpoint.Route, selector(operations[position.Operation]).Route))
            {
                operations[position.Operation] = item;
                seen[key] = (position.Operation, members.Count - 1);
            }
        }

        if (onFolded is not null)
        {
            foreach (((string, string, string) key, List<T> members) in grouped)
            {
                if (members.Count < 2)
                {
                    continue;
                }
                int kept = seen[key].Member;
                onFolded(members[kept], [.. members.Where((_, index) => index != kept)]);
            }
        }
        return operations;
    }

    private static bool Shorter(string candidate, string current) =>
        candidate.Length != current.Length
            ? candidate.Length < current.Length
            : string.CompareOrdinal(candidate, current) < 0;

    private static string FromRoute(EndpointDescriptor endpoint)
    {
        List<string> parts = [endpoint.Method.ToLowerInvariant()];
        List<string> pathParameters = [];

        foreach (string segment in endpoint.Route.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (segment.StartsWith('{') && segment.EndsWith('}'))
            {
                pathParameters.Add("by_" + SnakeCase(PlaceholderName(segment[1..^1])));
            }
            else
            {
                parts.Add(SnakeCase(segment));
            }
        }

        parts.AddRange(pathParameters);
        return Collapse(string.Join('_', parts));
    }

    private static string PlaceholderName(string placeholder)
    {
        string name = placeholder.TrimStart('*');
        int constraint = name.IndexOfAny([':', '?', '=']);
        return constraint >= 0 ? name[..constraint] : name;
    }

    private static string SnakeCase(string value)
    {
        StringBuilder builder = new(value.Length + 8);
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (char.IsAsciiLetterUpper(character))
            {
                bool afterLowercase = index > 0 && char.IsAsciiLetterLower(value[index - 1]);
                bool acronymEnd = index > 0
                    && char.IsAsciiLetterUpper(value[index - 1])
                    && index + 1 < value.Length
                    && char.IsAsciiLetterLower(value[index + 1]);
                if (builder.Length > 0 && (afterLowercase || acronymEnd))
                {
                    builder.Append('_');
                }
                builder.Append(char.ToLowerInvariant(character));
            }
            else if (char.IsAsciiLetterLower(character) || char.IsAsciiDigit(character))
            {
                builder.Append(character);
            }
            else
            {
                builder.Append('_');
            }
        }
        return Collapse(builder.ToString());
    }

    private static string Collapse(string value)
    {
        StringBuilder builder = new(value.Length);
        foreach (char character in value)
        {
            if (character == '_' && (builder.Length == 0 || builder[^1] == '_'))
            {
                continue;
            }
            builder.Append(character);
        }
        while (builder.Length > 0 && builder[^1] == '_')
        {
            builder.Length -= 1;
        }
        return builder.ToString();
    }

    [GeneratedRegex("^[a-z][a-z0-9_]{0,255}$")]
    private static partial Regex ToolNamePattern();
}
