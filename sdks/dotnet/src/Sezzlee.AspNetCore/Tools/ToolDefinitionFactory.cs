using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Naming;
using Sezzlee.AspNetCore.Requests;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore.Tools;

internal static partial class ToolDefinitionFactory
{
    /// <param name="refDescription">Non-null means a file resolver is bound: file arguments offer <c>ref</c>, described by this text.</param>
    public static ToolDefinition Create(
        EndpointDescriptor endpoint, string? name = null, ToolVariant? variant = null,
        CurationRelief? relief = null, string? refDescription = null)
    {
        ArgumentNullException.ThrowIfNull(endpoint);

        string? declared = variant?.Description ?? endpoint.Description;
        return new ToolDefinition
        {
            Name = name ?? variant?.Name ?? ToolNameFactory.Create(endpoint),
            Description = string.IsNullOrWhiteSpace(declared)
                ? $"{endpoint.Method} {endpoint.Route}"
                : declared,
            InputSchema = BuildInputSchema(endpoint, variant, relief, refDescription),
            OutputSchema = BuildOutputSchema(endpoint),
            Deprecated = endpoint.Deprecated == true ? true : null,
            Annotations = Annotate(endpoint, variant),
            Auth = endpoint.Auth,
            Revision = endpoint.Revision,
        };
    }

    private static string MediaTypeDefault(string? declared) =>
        declared is not null && !declared.Contains('*') && declared != "application/octet-stream"
            ? $"Defaults to {declared}."
            : "Defaults to text/plain; charset=utf-8 for text and application/octet-stream otherwise.";

    /// <summary>The argument an agent sends for one file part.</summary>
    /// <remarks>
    /// The byte limit is deliberately absent, so the definition does not change with the host's
    /// budget; the refusal names it instead. The twin is <c>fileArgumentSchema</c> in
    /// packages/http/core/src/file-argument.ts, and every description is compared verbatim by the
    /// metadata-extraction corpus.
    /// </remarks>
    private static JsonObject FileArgumentSchema(JsonObject fileSchema, string wireName, string? refDescription)
    {
        JsonObject properties = new()
        {
            ["text"] = new JsonObject { ["type"] = "string", ["description"] = "The file's content as text, sent as is." },
            ["base64"] = new JsonObject
            {
                ["type"] = "string",
                ["contentEncoding"] = "base64",
                ["description"] = "The file's bytes as standard base64 with padding and no line breaks.",
            },
        };
        if (refDescription is not null)
        {
            properties["ref"] = new JsonObject { ["type"] = "string", ["description"] = refDescription };
        }
        properties["name"] = new JsonObject
        {
            ["type"] = "string",
            ["description"] = $"The filename the backend receives. Defaults to '{wireName}'.",
        };
        properties["mediaType"] = new JsonObject
        {
            ["type"] = "string",
            ["description"] = $"The file's media type. {MediaTypeDefault(fileSchema["contentMediaType"]?.GetValue<string>())}",
        };
        JsonArray oneOf =
        [
            new JsonObject { ["required"] = new JsonArray("text") },
            new JsonObject { ["required"] = new JsonArray("base64") },
        ];
        if (refDescription is not null)
        {
            oneOf.Add(new JsonObject { ["required"] = new JsonArray("ref") });
        }
        JsonObject argument = new() { ["type"] = "object" };
        if (fileSchema["description"] is JsonNode description)
        {
            argument["description"] = description.DeepClone();
        }
        argument["properties"] = properties;
        argument["additionalProperties"] = false;
        argument["oneOf"] = oneOf;
        return argument;
    }

    /// <summary>Replaces a file property's schema with the file argument, leaving every other schema alone.</summary>
    private static JsonNode? PublishFileSchema(JsonNode? schema, string wireName, string? refDescription)
    {
        if (EndpointCatalog.IsFileSchema(schema))
        {
            return FileArgumentSchema((JsonObject)schema!, wireName, refDescription);
        }
        if (EndpointCatalog.IsFileArraySchema(schema))
        {
            JsonObject array = (JsonObject)schema!.DeepClone();
            array["items"] = FileArgumentSchema((JsonObject)schema!["items"]!, wireName, refDescription);
            return array;
        }
        return schema;
    }

    /// <summary>Produces the published argument schema, with curation applied.</summary>
    /// <remarks>
    /// Two rules are easy to get backwards. A curation description overrides even one the schema
    /// carries: the parameter description is a fallback for a missing one, whereas a curation
    /// description is the host's own statement of what the agent should read. And the
    /// wire-to-agent mapping runs before the requiredness guard: a renamed required field is keyed
    /// by its agent name, so a guard on the wire name would find nothing and silently make the
    /// field optional.
    /// </remarks>
    private static JsonObject BuildInputSchema(
        EndpointDescriptor endpoint, ToolVariant? variant, CurationRelief? relief, string? refDescription)
    {
        bool multipart = endpoint.RequestBody?.ContentType == MediaTypes.Multipart;
        bool binary = endpoint.RequestBody?.ContentType is { } bodyContentType && MediaTypes.IsBinary(bodyContentType);
        JsonNode? FileAware(string wireName, JsonNode? schema) =>
            multipart ? PublishFileSchema(schema, wireName, refDescription) : schema;
        JsonObject properties = [];
        JsonArray required = [];
        HashSet<string> claimed = new(StringComparer.Ordinal);

        void Require(string name)
        {
            if (claimed.Add(name))
            {
                required.Add(name);
            }
        }

        IReadOnlyList<Parameter> parameters = endpoint.Parameters ?? [];
        string[] parameterNames = [.. parameters.Select(parameter => parameter.Name)];
        string? root = endpoint.RequestBody is null
            ? null
            : RequestBodyShape.BodyRootOf(endpoint.RequestBody, parameterNames);
        JsonObject? flattened = endpoint.RequestBody is not null && root is null
            ? endpoint.RequestBody.Schema["properties"] as JsonObject
            : null;
        string[] bodyFieldNames = [.. (flattened ?? []).Select(entry => entry.Key)];
        string[] requiredBodyFields = endpoint.RequestBody is not null && root is null
            ? [.. (endpoint.RequestBody.Schema["required"] as JsonArray ?? [])
                .Select(node => node?.GetValue<string>())
                .OfType<string>()]
            : [];

        ResolvedCuration curation = ResolvedCuration.Resolve(
            endpoint,
            variant,
            CurationShape.Of(
                parameterNames,
                parameters.Where(parameter => parameter.Required).Select(parameter => parameter.Name),
                bodyFieldNames,
                requiredBodyFields,
                root,
                endpoint.RequestBody?.Required != false),
            relief);

        string? Publish(string wireName, JsonNode? schema)
        {
            ResolvedArgument? resolved = curation.Of(wireName);
            if (resolved?.Fill is not null)
            {
                return null;
            }
            string key = resolved?.Argument ?? wireName;
            if (resolved?.Description is { } description && schema is JsonObject owner)
            {
                owner["description"] = description;
            }
            properties[key] = schema;
            return key;
        }

        foreach (Parameter parameter in parameters)
        {
            if (Publish(parameter.Name, Describe(parameter.Schema, parameter.Description)) is { } key
                && parameter.Required)
            {
                Require(key);
            }
        }

        JsonNode additionalProperties = false;
        JsonObject? seed = null;
        if (endpoint.RequestBody is not null && root is { } bodyRoot)
        {
            if (properties.ContainsKey(bodyRoot))
            {
                throw new SezzleeTemplateException(
                    SezzleeTemplateException.ArgumentCollision,
                    $"Body root argument '{bodyRoot}' collides with a parameter name on {endpoint.Method} {endpoint.Route}; rename the parameter.");
            }
            JsonNode rootSchema = endpoint.RequestBody.Schema.DeepClone();
            if (multipart && rootSchema["properties"] is JsonObject rootProperties)
            {
                foreach (string field in rootProperties.Select(entry => entry.Key).ToArray())
                {
                    rootProperties[field] = PublishFileSchema(rootProperties[field]?.DeepClone(), field, refDescription);
                }
            }
            else if (binary)
            {
                rootSchema = PublishFileSchema(rootSchema, bodyRoot, refDescription)!;
            }
            if (Publish(bodyRoot, rootSchema) is { } key
                && endpoint.RequestBody.Required != false)
            {
                Require(key);
            }
        }
        else if (endpoint.RequestBody is not null)
        {
            JsonObject body = endpoint.RequestBody.Schema;
            additionalProperties = RequestBodyShape.AdditionalPropertiesOf(body);
            seed = body["$defs"] as JsonObject;

            foreach ((string name, JsonNode? schema) in flattened ?? [])
            {
                Publish(name, FileAware(name, schema?.DeepClone()));
            }
            foreach (string entry in requiredBodyFields)
            {
                ResolvedArgument? resolved = curation.Of(entry);
                if (resolved?.Fill is not null)
                {
                    continue;
                }
                string key = resolved?.Argument ?? entry;
                if (properties.ContainsKey(key))
                {
                    Require(key);
                }
            }
        }

        JsonObject result = new()
        {
            ["type"] = "object",
            ["properties"] = properties,
            ["required"] = required,
            ["additionalProperties"] = additionalProperties,
        };
        if (LiftDefs(properties, seed, endpoint) is { } defs)
        {
            result["$defs"] = defs;
        }
        return result;
    }

    private const string ResultRootProperty = "result";

    private static readonly string[] PreferredStatuses = ["200", "201", "202", "204"];

    [GeneratedRegex(@"^2[0-9]{2}$")]
    private static partial Regex ExactSuccessStatus();

    private static JsonObject? PrimaryResponseOf(IReadOnlyDictionary<string, ResponseBody> responses)
    {
        string[] successes = [.. responses.Keys.Where(status => ExactSuccessStatus().IsMatch(status))];
        string? chosen = Array.Find(PreferredStatuses, successes.Contains)
            ?? successes.OrderBy(int.Parse).FirstOrDefault()
            ?? (responses.ContainsKey("2XX") ? "2XX" : null);
        return chosen is null ? null : responses[chosen].Schema;
    }

    private static bool IsObjectRoot(JsonObject schema) => schema["type"] switch
    {
        JsonValue value when value.TryGetValue(out string? name) => name == "object",
        JsonArray members =>
            members.Select(member => member?.GetValue<string>())
                .Where(member => member != "null")
                .SequenceEqual(["object"]),
        _ => false,
    };

    /// <summary>
    /// Produces the schema of what the tool returns, or <c>null</c> when the endpoint declares no
    /// success body.
    /// </summary>
    /// <remarks>
    /// A non-object root is wrapped under <c>result</c> because MCP requires <c>outputSchema</c> to
    /// be an object. The wrapped schema's <c>$defs</c> MUST move to the wrapper root: a
    /// <c>#/$defs/...</c> inside it resolves against the document root, so a bag left under
    /// <c>properties.result</c> leaves every reference aimed at nothing. A root declaring <c>$id</c>
    /// is its own schema resource and rebases its own references, so <c>LiftDefs</c> leaves it alone
    /// — the same rule that keeps such a root out of body flattening.
    /// <para>
    /// <c>additionalProperties</c> is never written here. On <c>InputSchema</c> it binds what the
    /// caller may send; a response is the backend's own shape and the agent is not the party
    /// constrained by it.
    /// </para>
    /// </remarks>
    private static JsonObject? BuildOutputSchema(EndpointDescriptor endpoint)
    {
        if (endpoint.Responses is not { } responses)
        {
            return null;
        }
        if (PrimaryResponseOf(responses) is not { } primary)
        {
            return null;
        }
        if (IsObjectRoot(primary))
        {
            return (JsonObject)primary.DeepClone();
        }

        JsonObject properties = new() { [ResultRootProperty] = primary.DeepClone() };
        JsonObject wrapped = new()
        {
            ["type"] = "object",
            ["properties"] = properties,
            ["required"] = new JsonArray(ResultRootProperty),
        };
        if (LiftDefs(properties, null, endpoint) is { } defs)
        {
            wrapped["$defs"] = defs;
        }
        return wrapped;
    }

    /// <summary>Merges every <c>$defs</c> bag reachable from the tool's own root into one.</summary>
    /// <remarks>
    /// A property declaring <c>$id</c> is skipped: it is its own schema resource, so a
    /// <c>#/$defs/...</c> inside it resolves against that <c>$id</c> and not against the tool
    /// document. Hoisting its bag to the tool root would leave those references aimed at nothing —
    /// the very defect hoisting exists to prevent.
    /// </remarks>
    /// <param name="seed">
    /// The flattened body's own root bag. A flattened body contributes its properties to
    /// <paramref name="properties"/> but its root — and so its bag — is never emitted, so without
    /// this the <c>$ref</c>s lifted out of it would point at nothing. Its entries are cloned and the
    /// bag itself is never detached: the descriptor is shared across the catalog snapshot, and
    /// stripping <c>$defs</c> from it would break every tool built after the first. A root declaring
    /// <c>$id</c> never reaches here, because it takes the root argument instead of flattening.
    /// </param>
    /// <exception cref="SezzleeTemplateException">
    /// <c>schema_def_conflict</c> when one key carries two different schemas.
    /// </exception>
    private static JsonObject? LiftDefs(
        JsonObject properties, JsonObject? seed, EndpointDescriptor endpoint)
    {
        SortedDictionary<string, JsonNode> merged = new(StringComparer.Ordinal);
        void Take(string name, JsonNode body)
        {
            if (merged.TryGetValue(name, out JsonNode? existing))
            {
                if (!JsonNode.DeepEquals(existing, body))
                {
                    throw new SezzleeTemplateException(
                        DiagnosticCodes.SchemaDefConflict,
                        $"Two schemas on {endpoint.Method} {endpoint.Route} define '{name}' differently; the tool cannot be built.");
                }
                return;
            }
            merged[name] = body.DeepClone();
        }

        foreach ((string name, JsonNode? body) in seed ?? [])
        {
            if (body is not null)
            {
                Take(name, body);
            }
        }
        foreach ((string _, JsonNode? node) in properties)
        {
            if (node is not JsonObject owner || owner["$defs"] is not JsonObject own)
            {
                continue;
            }
            if (owner["$id"] is not null)
            {
                continue;
            }
            owner.Remove("$defs");
            foreach ((string name, JsonNode? body) in own)
            {
                if (body is not null)
                {
                    Take(name, body);
                }
            }
        }
        if (merged.Count == 0)
        {
            return null;
        }
        JsonObject bag = [];
        foreach ((string name, JsonNode body) in merged)
        {
            bag[name] = body;
        }
        return bag;
    }

    private static JsonNode Describe(JsonObject schema, string? description)
    {
        JsonObject clone = (JsonObject)schema.DeepClone();
        if (!string.IsNullOrWhiteSpace(description) && clone["description"] is null)
        {
            clone["description"] = description;
        }
        return clone;
    }

    /// <summary>The method's implied hints, overlaid per key by the operation's, then the variant's.</summary>
    private static ToolAnnotations Annotate(EndpointDescriptor endpoint, ToolVariant? variant)
    {
        ToolAnnotations implied = Implied(endpoint.Method);
        ToolAnnotations? declared = endpoint.Annotations;
        ToolAnnotations? own = variant?.Annotations;
        return new ToolAnnotations
        {
            ReadOnlyHint = own?.ReadOnlyHint ?? declared?.ReadOnlyHint ?? implied.ReadOnlyHint,
            DestructiveHint = own?.DestructiveHint ?? declared?.DestructiveHint ?? implied.DestructiveHint,
            IdempotentHint = own?.IdempotentHint ?? declared?.IdempotentHint ?? implied.IdempotentHint,
        };
    }

    private static ToolAnnotations Implied(string method) => method.ToUpperInvariant() switch
    {
        "GET" or "HEAD" or "OPTIONS" or "QUERY" => new ToolAnnotations { ReadOnlyHint = true, IdempotentHint = true },
        "POST" => new ToolAnnotations { DestructiveHint = false },
        "PUT" => new ToolAnnotations { DestructiveHint = true, IdempotentHint = true },
        "PATCH" => new ToolAnnotations { DestructiveHint = true },
        "DELETE" => new ToolAnnotations { DestructiveHint = true, IdempotentHint = true },
        _ => new ToolAnnotations(),
    };
}
