using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Sezzlee.AspNetCore.Requests;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore.Naming;

/// <summary>The rules a family's lowered form must satisfy; the twin of <c>family.ts</c> in packages/http/core.</summary>
internal static partial class FamilyRules
{
    private static readonly HashSet<string> ScalarTypes =
        new(StringComparer.Ordinal) { "string", "integer", "number", "boolean" };

    private static readonly string[] SchemaMaps = ["properties", "patternProperties", "$defs"];

    private static readonly string[] SchemaValues =
        ["items", "additionalProperties", "propertyNames", "contains", "not", "if", "then", "else"];

    private static readonly string[] SchemaLists = ["anyOf", "oneOf", "allOf"];

    private static readonly string[] IdentityKeywords =
        ["$id", "$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"];

    /// <summary>Refuses a family whose lowered form could publish the dispatcher itself.</summary>
    /// <remarks>
    /// Every member must write its own distinct key into the dispatch parameter as a hidden
    /// constant: a member that leaves it visible, or fills it at invoke time, reaches every other
    /// member's capability through one name. A family with no member produces nothing rather than
    /// the uncurated dispatcher, for the same reason.
    /// </remarks>
    public static void Assert(EndpointDescriptor operation)
    {
        string where = $"{operation.Method} {operation.Route}";
        ToolFamily? family = operation.Family;
        if (family is null)
        {
            ToolVariant? bodied = operation.Variants?.FirstOrDefault(v => v.RequestBody is not null);
            if (bodied is not null)
            {
                throw new SezzleeTemplateException(
                    SezzleeTemplateException.VariantBodyWithoutFamily,
                    $"Variant '{bodied.Name}' of {where} declares its own request body; only a family member may replace the operation's body.");
            }
            return;
        }

        Parameter? parameter = operation.Parameters?.FirstOrDefault(p =>
            string.Equals(p.Name, family.Parameter, StringComparison.Ordinal));
        if (parameter is null || !Dispatchable(parameter))
        {
            throw new SezzleeTemplateException(
                SezzleeTemplateException.FamilyParameterUnresolved,
                $"{where} dispatches on '{family.Parameter}', which is not a declared scalar parameter outside the body.");
        }
        if (operation.Variants is null)
        {
            throw new SezzleeTemplateException(
                SezzleeTemplateException.FamilyWithoutMembers,
                $"{where} declares a family on '{family.Parameter}' with no member; no tool is produced for it.");
        }

        Dictionary<string, string> claimed = new(StringComparer.Ordinal);
        foreach (ToolVariant variant in operation.Variants)
        {
            ArgumentFill? fill = RecordFor(operation, variant, family.Parameter)?.Hidden;
            string? key = fill?.Kind == ArgumentFillKind.Constant ? KeyOf(fill.Value) : null;
            if (key is null)
            {
                throw new SezzleeTemplateException(
                    SezzleeTemplateException.FamilyKeyUnfilled,
                    $"Member '{variant.Name}' of {where} does not write a scalar constant into '{family.Parameter}'; a member must hide its own key.");
            }
            if (claimed.TryGetValue(key, out string? first))
            {
                throw new SezzleeTemplateException(
                    SezzleeTemplateException.FamilyKeyDuplicate,
                    $"Members '{first}' and '{variant.Name}' of {where} both dispatch with key {key}.");
            }
            claimed[key] = variant.Name;
            string? problem = variant.RequestBody is null ? null : DeclaredSchemaProblem(variant.RequestBody.Schema);
            if (problem is not null)
            {
                throw new SezzleeTemplateException(
                    SezzleeTemplateException.VariantBodyInvalid,
                    $"Member '{variant.Name}' of {where} declares a body schema that {problem}.");
            }
        }
    }

    /// <summary>
    /// The descriptor one production is built from: the operation, with a family member's body in
    /// place of the operation's. The media type and object notation stay the operation's.
    /// </summary>
    public static EndpointDescriptor ProductionDescriptor(EndpointDescriptor operation, ToolVariant? variant)
    {
        VariantRequestBody? body = variant?.RequestBody;
        if (body is null)
        {
            return operation;
        }
        return operation with
        {
            RequestBody = new RequestBody
            {
                Schema = body.Schema,
                Required = body.Required,
                Description = body.Description ?? operation.RequestBody?.Description,
                ContentType = operation.RequestBody?.ContentType,
                ObjectNotation = operation.RequestBody?.ObjectNotation,
            },
        };
    }

    /// <summary>Checks that a host-declared body schema is self-contained.</summary>
    /// <remarks>
    /// A member body arrives verbatim from host data, so nothing upstream resolved it. A
    /// <c>$ref</c> that leaves the schema's own <c>$defs</c> would be followed by whichever
    /// validator the agent's client runs, and an identity keyword re-bases every relative reference
    /// beneath it.
    /// </remarks>
    /// <returns>A clause describing the first problem, or <see langword="null"/>.</returns>
    public static string? DeclaredSchemaProblem(JsonObject schema)
    {
        List<JsonObject> nodes = [.. Walk(schema)];
        HashSet<string> definitions = new(StringComparer.Ordinal);
        foreach (JsonObject node in nodes)
        {
            if (node["$defs"] is JsonObject defs)
            {
                foreach ((string name, _) in defs)
                {
                    definitions.Add(name);
                }
            }
        }
        foreach (JsonObject node in nodes)
        {
            string? keyword = IdentityKeywords.FirstOrDefault(node.ContainsKey);
            if (keyword is not null)
            {
                return $"carries '{keyword}'";
            }
            if (node["$ref"] is not JsonValue reference || !reference.TryGetValue(out string? target))
            {
                continue;
            }
            Match local = LocalDefinition().Match(target);
            if (!local.Success || !definitions.Contains(Unescape(local.Groups[1].Value)))
            {
                return $"references '{target}', which is not one of its own definitions";
            }
        }
        return null;
    }

    private static bool Dispatchable(Parameter parameter) =>
        !string.Equals(parameter.In, "querystring", StringComparison.Ordinal)
        && parameter.Schema["type"] switch
        {
            JsonValue type => type.TryGetValue(out string? name) && ScalarTypes.Contains(name),
            JsonArray types => types.Count > 0 && types.All(type =>
                type is JsonValue value && value.TryGetValue(out string? name) && ScalarTypes.Contains(name)),
            _ => false,
        };

    private static ArgumentCuration? RecordFor(EndpointDescriptor operation, ToolVariant variant, string name) =>
        variant.Arguments?.FirstOrDefault(r => string.Equals(r.Name, name, StringComparison.Ordinal))
        ?? operation.Arguments?.FirstOrDefault(r => string.Equals(r.Name, name, StringComparison.Ordinal));

    private static string? KeyOf(JsonNode? value)
    {
        if (value is not JsonValue scalar)
        {
            return null;
        }
        JsonElement element = JsonSerializer.SerializeToElement(scalar);
        return element.ValueKind is JsonValueKind.String or JsonValueKind.Number
            or JsonValueKind.True or JsonValueKind.False
            ? CanonicalJson.Stringify(element)
            : null;
    }

    private static IEnumerable<JsonObject> Walk(JsonObject schema)
    {
        yield return schema;
        foreach (JsonObject child in Children(schema))
        {
            foreach (JsonObject descendant in Walk(child))
            {
                yield return descendant;
            }
        }
    }

    private static IEnumerable<JsonObject> Children(JsonObject schema)
    {
        foreach (string keyword in SchemaMaps)
        {
            if (schema[keyword] is JsonObject map)
            {
                foreach ((_, JsonNode? value) in map)
                {
                    if (value is JsonObject child)
                    {
                        yield return child;
                    }
                }
            }
        }
        foreach (string keyword in SchemaValues)
        {
            if (schema[keyword] is JsonObject child)
            {
                yield return child;
            }
        }
        foreach (string keyword in SchemaLists)
        {
            if (schema[keyword] is JsonArray list)
            {
                foreach (JsonNode? item in list)
                {
                    if (item is JsonObject child)
                    {
                        yield return child;
                    }
                }
            }
        }
    }

    private static string Unescape(string token) => token.Replace("~1", "/").Replace("~0", "~");

    [GeneratedRegex(@"^#/\$defs/([^/]+)$")]
    private static partial Regex LocalDefinition();
}
