using System.ComponentModel;
using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.ApiExplorer;
using Microsoft.AspNetCore.Mvc.Authorization;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Sezzlee.AspNetCore.Naming;
using Sezzlee.AspNetCore.Requests;
using Sezzlee.AspNetCore.Search;
using Sezzlee.AspNetCore.Spec;
using Sezzlee.AspNetCore.Tools;

namespace Sezzlee.AspNetCore.Discovery;

internal sealed record CatalogDiagnostic(string Code, string Message);

public sealed record CatalogEntry
{
    public required ToolDefinition Tool { get; init; }
    public required EndpointDescriptor Descriptor { get; init; }
    public Endpoint? Endpoint { get; init; }
    public RequestTemplate? Template { get; init; }
    public IReadOnlyList<string>? AlternateRoutes { get; init; }
}

internal sealed record CatalogBuildResult
{
    public required IReadOnlyList<CatalogEntry> Entries { get; init; }
    public required IReadOnlyList<CatalogDiagnostic> Diagnostics { get; init; }
    public required int Discovered { get; init; }
    public required int Selected { get; init; }
    public int Dropped { get; init; }

    /// <summary>
    /// Every discovered operation keyed by <c>METHOD /route</c>: the descriptor it was published
    /// from, or <c>null</c> when it was not selected, was dropped, or folded into another route.
    /// </summary>
    /// <remarks>
    /// An operation is recorded before any skip, the reserved MCP route included: a skipped
    /// operation is still in the backend's OpenAPI document, and without a decision it would carry
    /// no x-sezzlee marker, so a gateway including by default would publish it.
    /// </remarks>
    public IReadOnlyDictionary<string, EndpointDescriptor?> Operations { get; init; } =
        new Dictionary<string, EndpointDescriptor?>();

    public int? CatalogRevision { get; init; }

    public IReadOnlyDictionary<string, string> ToolNames { get; init; } =
        new Dictionary<string, string>();
}

internal static partial class EndpointCatalog
{
    public static CatalogBuildResult Build(
        IApiDescriptionGroupCollectionProvider apiDescriptions,
        EndpointDataSource? endpoints,
        SelectionDefault selectionDefault,
        bool useOperationIds = true,
        string? reservedRoutePrefix = null,
        SchemaMapperOptions? schema = null,
        bool hasFallbackPolicy = false,
        PrefixMode prefixMode = PrefixMode.Always,
        Func<string, string?>? containerPrefix = null,
        Func<string, IReadOnlyList<string>?>? containerTags = null,
        Func<string, CatalogSeverity>? severityOf = null,
        ArgumentCurationOptions? curation = null,
        IReadOnlyList<SelectionRule>? selectionRules = null,
        bool groupQueryObjects = false,
        string? refDescription = null,
        ToolFamilyOptions? families = null,
        IReadOnlyDictionary<string, FamilyLoad>? familyLoads = null,
        Func<string, IReadOnlyList<string>?>? containerSearchTerms = null,
        int? catalogRevision = null,
        Func<string, int?>? containerRevision = null)
    {
        ArgumentNullException.ThrowIfNull(apiDescriptions);
        severityOf ??= DiagnosticCodes.SeverityOf;
        int dropped = 0;

        Dictionary<ActionDescriptor, Endpoint> routed = new();
        foreach (Endpoint endpoint in endpoints?.Endpoints ?? [])
        {
            if (endpoint.Metadata.GetMetadata<ActionDescriptor>() is { } action)
            {
                routed[action] = endpoint;
            }
        }

        List<CatalogDiagnostic> diagnostics = [];
        int? catalog = DeclaredRevision(
            "The catalog", "catalog", diagnostics, (catalogRevision, "options.Revision"));
        List<(Endpoint? Endpoint, EndpointDescriptor Descriptor)> candidates = [];
        Dictionary<string, EndpointDescriptor?> declared = new(StringComparer.Ordinal);
        int discovered = 0;
        int selected = 0;

        foreach (ApiDescriptionGroup group in apiDescriptions.ApiDescriptionGroups.Items)
        {
            foreach (ApiDescription api in group.Items)
            {
                discovered += 1;
                string route = NormalizeRoute(api.RelativePath);
                string target = $"{api.HttpMethod} {route}";
                if (!string.IsNullOrEmpty(api.HttpMethod))
                {
                    declared[target] = null;
                }
                if (reservedRoutePrefix is not null
                    && route.StartsWith(reservedRoutePrefix, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                ActionDescriptor action = api.ActionDescriptor;
                routed.TryGetValue(action, out Endpoint? endpoint);
                IReadOnlyList<object> metadata = endpoint is not null
                    ? [.. endpoint.Metadata]
                    : [.. action.EndpointMetadata ?? []];

                bool include;
                try
                {
                    include = SelectionResolver.IsSelected(
                        selectionDefault, ContainerMarker(action), OperationMarker(action, metadata), target,
                        SelectionResolver.ResolveRules(
                            selectionRules, route, api.HttpMethod ?? string.Empty, target));
                }
                catch (SezzleeCatalogException ex)
                {
                    diagnostics.Add(new CatalogDiagnostic(ex.Code, ex.Message));
                    continue;
                }
                if (!include)
                {
                    continue;
                }
                selected += 1;

                if (string.IsNullOrEmpty(api.HttpMethod))
                {
                    diagnostics.Add(new CatalogDiagnostic(
                        DiagnosticCodes.MissingHttpMethod, $"{route} has no HTTP method constraint."));
                    dropped += 1;
                    continue;
                }

                EndpointDescriptor? descriptor = Describe(
                    api, route, action, metadata, useOperationIds, schema, hasFallbackPolicy,
                    containerPrefix, containerTags, containerSearchTerms, diagnostics,
                    curation ?? new ArgumentCurationOptions(), groupQueryObjects);
                if (descriptor is null)
                {
                    dropped += 1;
                    continue;
                }
                descriptor = descriptor with
                {
                    Annotations = OverridesFor(action, metadata),
                    Revision = RevisionFor(action, metadata, api, catalog, containerRevision, diagnostics),
                };
                if (FamilyOf(action, metadata) is { } declaration)
                {
                    FamilyResolution resolution = FamilyReader.Resolve(
                        declaration, target, descriptor.Variants, families ?? new ToolFamilyOptions(), familyLoads);
                    if (resolution is FamilyResolution.Refused refused)
                    {
                        diagnostics.Add(refused.Diagnostic);
                        dropped += 1;
                        continue;
                    }
                    FamilyResolution.Members members = (FamilyResolution.Members)resolution;
                    diagnostics.AddRange(members.Diagnostics);
                    List<ToolVariant> variants = [.. descriptor.Variants ?? [], .. members.Variants];
                    descriptor = descriptor with
                    {
                        Family = members.Family,
                        Variants = variants.Count == 0 ? null : variants,
                    };
                }
                candidates.Add((endpoint, descriptor));
                declared[target] = descriptor;
            }
        }

        List<CatalogEntry> entries = [];
        Dictionary<string, EndpointDescriptor> claimed = new(StringComparer.Ordinal);
        Dictionary<string, string> toolNames = new(StringComparer.Ordinal);

        Dictionary<string, IReadOnlyList<string>> alternates = new(StringComparer.Ordinal);
        List<(Endpoint? Endpoint, EndpointDescriptor Descriptor)> operations =
            [.. ToolNameFactory.Deduplicate(candidates, c => c.Descriptor, (kept, folded) =>
            {
                string[] routes = [.. folded.Select(f => f.Descriptor.Route)];
                alternates[FoldKey(kept.Descriptor)] = routes;
                foreach ((_, EndpointDescriptor alternate) in folded)
                {
                    declared[$"{alternate.Method} {alternate.Route}"] = null;
                }
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.RouteFolded,
                    $"{kept.Descriptor.Method} {kept.Descriptor.Route} is also mounted at {string.Join(", ", routes)}; "
                    + $"one tool is produced and {kept.Descriptor.Route} is the route it invokes."));
            })];
        Dictionary<string, int> bodyGroups = new(StringComparer.Ordinal);
        if (prefixMode == PrefixMode.OnCollision)
        {
            foreach ((_, EndpointDescriptor descriptor) in operations)
            {
                if (descriptor.ToolName is not null)
                {
                    continue;
                }
                string body = ToolNameFactory.CreateBody(descriptor);
                bodyGroups[body] = bodyGroups.TryGetValue(body, out int count) ? count + 1 : 1;
            }
        }

        foreach ((Endpoint? endpoint, EndpointDescriptor operation) in operations)
        {
            IReadOnlyList<ToolProduction> productions;
            try
            {
                productions = ToolNameFactory.ProductionsOf(operation);
            }
            catch (SezzleeTemplateException ex)
            {
                diagnostics.Add(new CatalogDiagnostic(ex.Code, ex.Message));
                dropped += 1;
                continue;
            }

            foreach (ToolProduction production in productions)
            {
                EndpointDescriptor descriptor = production.Endpoint;
                ToolVariant? variant = production.Variant;
                string name;
                try
                {
                    name = variant is null
                        ? ToolNameFactory.Create(operation, prefixMode)
                        : ToolNameFactory.VariantName(variant, operation);
                    if (prefixMode == PrefixMode.OnCollision
                        && variant is null
                        && descriptor.ToolName is null
                        && bodyGroups.TryGetValue(name, out int clashes)
                        && clashes > 1)
                    {
                        string prefixed = ToolNameFactory.ApplyPrefix(name, ToolNameFactory.DerivePrefix(descriptor));
                        if (!string.Equals(prefixed, name, StringComparison.Ordinal))
                        {
                            diagnostics.Add(new CatalogDiagnostic(
                                ToolNameFactory.NameDisambiguated,
                                $"Tool name '{name}' collided; {descriptor.Method} {descriptor.Route} is exposed as '{prefixed}'."));
                            name = prefixed;
                        }
                    }
                }
                catch (SezzleeCatalogException ex)
                {
                    diagnostics.Add(new CatalogDiagnostic(ex.Code, ex.Message));
                    continue;
                }
                if (claimed.TryGetValue(name, out EndpointDescriptor? owner))
                {
                    diagnostics.Add(new CatalogDiagnostic(
                        SezzleeCatalogException.NameCollision,
                        $"Tool name '{name}' is produced by both {owner.Method} {owner.Route} and {descriptor.Method} {descriptor.Route}."));
                    continue;
                }
                claimed[name] = descriptor;

                if (name.Length > ToolNameFactory.LongNameThreshold)
                {
                    diagnostics.Add(new CatalogDiagnostic(
                        "long_tool_name",
                        $"Tool name '{name}' is {name.Length} characters; long names cost agent context and weaken search."));
                }

                CurationRelief? relief = ReliefFor(
                    descriptor, alternates.GetValueOrDefault(FoldKey(descriptor)), diagnostics);
                (RequestTemplate? template, string? failure) = BuildTemplate(
                    descriptor, diagnostics, variant, relief, refDescription);
                if (failure is not null && severityOf(failure) >= CatalogSeverity.EndpointDropped)
                {
                    dropped += 1;
                    continue;
                }

                ToolDefinition tool;
                try
                {
                    tool = ToolDefinitionFactory.Create(descriptor, name, variant, relief, refDescription);
                }
                catch (SezzleeTemplateException ex)
                {
                    diagnostics.Add(new CatalogDiagnostic(ex.Code, ex.Message));
                    dropped += 1;
                    continue;
                }
                if (template is not null)
                {
                    ReportCurationLeaks(
                        tool,
                        template,
                        ResolvedCuration.CuratedDescriptions(descriptor, variant),
                        diagnostics);
                    if (template.BodyAllowsAdditionalProperties && template.BodyFills.Count > 0)
                    {
                        diagnostics.Add(new CatalogDiagnostic(
                            DiagnosticCodes.CuratedOpenBody,
                            $"Tool '{name}' hides an argument on a body that accepts additional properties; "
                            + "the schema cannot express the exclusion, so only the composer enforces it."));
                    }
                }

                if (variant is null)
                {
                    toolNames[$"{operation.Method} {operation.Route}"] = name;
                }
                entries.Add(new CatalogEntry
                {
                    Tool = tool,
                    Descriptor = descriptor,
                    Endpoint = endpoint,
                    Template = template,
                    AlternateRoutes = alternates.GetValueOrDefault(FoldKey(descriptor)),
                });
            }
        }

        ReportIndistinguishableVariants(entries, diagnostics);

        return new CatalogBuildResult
        {
            Entries = entries,
            Diagnostics = diagnostics,
            Discovered = discovered,
            Selected = selected,
            Dropped = dropped,
            Operations = declared,
            CatalogRevision = catalog,
            ToolNames = toolNames,
        };
    }

    /// <summary>
    /// The schema options a response body is written with.
    /// </summary>
    /// <remarks>
    /// <c>DropReadOnlyProperties</c> is a policy for what the caller may <em>send</em>, so it is
    /// forced off here regardless of the host's setting: a get-only member is a response field
    /// precisely because it is read-only, and dropping it hides the field from the agent. The
    /// two option instances share one <c>Report</c> target, so a DTO bound as both request and
    /// response body would report every shape diagnostic twice; <paramref name="reportedBefore"/>
    /// bounds the scan to this endpoint's own diagnostics so the second pass stays silent without
    /// suppressing an identical message from another endpoint.
    /// </remarks>
    private static SchemaMapperOptions ResponseSchemaOf(
        SchemaMapperOptions request,
        List<CatalogDiagnostic> diagnostics,
        int reportedBefore) => request with
        {
            DropReadOnlyProperties = false,
            Report = diagnostic =>
            {
                for (int i = reportedBefore; i < diagnostics.Count; i += 1)
                {
                    if (diagnostics[i] == diagnostic)
                    {
                        return;
                    }
                }
                diagnostics.Add(diagnostic);
            },
        };

    private static EndpointDescriptor? Describe(
        ApiDescription api,
        string route,
        ActionDescriptor action,
        IReadOnlyList<object> metadata,
        bool useOperationIds,
        SchemaMapperOptions? mapper,
        bool hasFallbackPolicy,
        Func<string, string?>? containerPrefix,
        Func<string, IReadOnlyList<string>?>? containerTags,
        Func<string, IReadOnlyList<string>?>? containerSearchTerms,
        List<CatalogDiagnostic> diagnostics,
        ArgumentCurationOptions curation,
        bool groupQueryObjects)
    {
        List<Parameter> parameters = [];
        RequestBody? body = null;
        List<ApiParameterDescription> formLeaves = [];
        int reportedBefore = diagnostics.Count;
        SchemaMapperOptions schema = (mapper ?? new SchemaMapperOptions
        {
            PropertyName = property => property.Name,
        }) with
        {
            Report = diagnostics.Add,
        };
        SchemaMapperOptions responseSchema = ResponseSchemaOf(schema, diagnostics, reportedBefore);

        QueryObjectGrouper.Plan grouped = groupQueryObjects
            ? QueryObjectGrouper.Build(
                api, schema, diagnostics, $"{api.HttpMethod} {route}")
            : QueryObjectGrouper.Empty;
        IReadOnlySet<ApiParameterDescription> omitted = QueryObjectGrouper.Unexpressible(
            api, schema, grouped.Consumed, diagnostics, $"{api.HttpMethod} {route}");

        foreach (ApiParameterDescription parameter in api.ParameterDescriptions)
        {
            if (grouped.Consumed.Contains(parameter) || omitted.Contains(parameter))
            {
                continue;
            }
            string? location = Locate(parameter.Source);
            if (location is null)
            {
                if (parameter.Source == BindingSource.Body)
                {
                    if (body is not null)
                    {
                        diagnostics.Add(new CatalogDiagnostic(
                            DiagnosticCodes.MultipleBodyBindings,
                            $"{api.HttpMethod} {route} declares more than one request body; endpoint skipped."));
                        return null;
                    }
                    body = new RequestBody
                    {
                        Schema = JsonSchemaMapper.Map(BodyTypeOf(parameter), schema),
                        Required = parameter.IsRequired,
                        Description = ParameterDescription(parameter),
                    };
                }
                else if (parameter.Source == BindingSource.Form
                    || parameter.Source == BindingSource.FormFile)
                {
                    formLeaves.Add(parameter);
                }
                continue;
            }
            parameters.Add(new Parameter
            {
                Name = parameter.Name,
                In = location,
                Required = parameter.IsRequired,
                Schema = JsonSchemaMapper.Map(parameter.Type ?? typeof(string), schema),
                Description = ParameterDescription(parameter),
            });
        }
        parameters.AddRange(grouped.Groups);

        string where = $"{api.HttpMethod} {route}";
        if (formLeaves.Count > 0)
        {
            if (body is not null)
            {
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.MultipleBodyBindings,
                    $"{where} binds both a request body and form fields; endpoint skipped."));
                return null;
            }
            body = BodyEncoding.FormBodyOf(api, metadata, formLeaves, schema, where, diagnostics);
            if (body is null)
            {
                return null;
            }
        }
        else if (body is not null)
        {
            bool isString = RequestBodyShape.TypeOf(body.Schema["type"]) == "string";
            if (!BodyEncoding.TryChooseJson(api, metadata, isString, where, diagnostics, out string? contentType))
            {
                return null;
            }
            if (contentType is not null)
            {
                body = body with { ContentType = contentType };
            }
        }

        if (body is not null
            && RequestBodyShape.BodyRootReasonOf(body, parameters.Select(parameter => parameter.Name)) is { } reason)
        {
            string rootArgument = RequestBodyShape.BodyRootArgument;
            string key = RequestBodyShape.UnflattenableRootKey(body.Schema) ?? "no flattenable member";
            diagnostics.Add(reason switch
            {
                "optional" => new CatalogDiagnostic(
                    DiagnosticCodes.OptionalBodyArgument,
                    $"{api.HttpMethod} {route} binds an optional request body; it is exposed as a single optional '{rootArgument}' argument, so omitting it sends no body at all."),
                "unflattenable_root" => new CatalogDiagnostic(
                    DiagnosticCodes.UnflattenableBodyRoot,
                    $"{api.HttpMethod} {route} binds a request body whose root carries '{key}', which flattening would discard; it is exposed as a single '{rootArgument}' argument that keeps the body schema whole."),
                "collision" => new CatalogDiagnostic(
                    DiagnosticCodes.BodyFieldCollision,
                    $"{api.HttpMethod} {route} binds a request body whose field '{RequestBodyShape.CollidingBodyField(body.Schema, parameters.Select(parameter => parameter.Name))}' collides with a parameter of the same name; it is exposed as a single '{rootArgument}' argument so neither slot is guessed."),
                _ => new CatalogDiagnostic(
                    DiagnosticCodes.SyntheticBodyArgument,
                    $"{api.HttpMethod} {route} binds a request body that is not a JSON object; it is exposed as a single '{rootArgument}' argument whose value becomes the whole body."),
            });
        }

        Dictionary<string, ResponseBody> responses = new(StringComparer.Ordinal);
        foreach (ApiResponseType response in api.SupportedResponseTypes)
        {
            string status = response.StatusCode.ToString();
            if (status.Length != 3 || responses.ContainsKey(status))
            {
                continue;
            }
            bool hasSchema = response.Type is not null && response.Type != typeof(void);
            responses[status] = new ResponseBody
            {
                Schema = hasSchema ? JsonSchemaMapper.Map(response.Type!, responseSchema) : null,
            };
        }

        return new EndpointDescriptor
        {
            OperationId = useOperationIds ? OperationId(action, metadata) : null,
            Container = action is ControllerActionDescriptor declaring
                ? declaring.ControllerTypeInfo.FullName
                : null,
            ToolName = SelectionAttribute(action, metadata, operationOnly: true)?.Name,
            ContainerPrefix = PrefixFor(action, metadata, containerPrefix),
            Method = api.HttpMethod!.ToUpperInvariant(),
            Route = route,
            Description = SelectionAttribute(action, metadata, operationOnly: true)?.Description
                ?? DescriptionOf(metadata),
            Arguments = CurationReader.Read(
                action, metadata, null, curation,
                api.HttpMethod!.ToUpperInvariant(), route),
            Variants = CurationReader.Variants(
                action, metadata, curation,
                api.HttpMethod!.ToUpperInvariant(), route),
            Parameters = parameters.Count == 0 ? null : parameters,
            RequestBody = body,
            Responses = responses.Count == 0 ? null : responses,
            Auth = ReadAuth(metadata, hasFallbackPolicy),
            Tags = TagsFor(action, metadata, api, containerTags, diagnostics),
            SearchTerms = SearchTermsFor(action, metadata, api, containerSearchTerms, diagnostics),
        };
    }

    private static Auth ReadAuth(IReadOnlyList<object> metadata, bool hasFallbackPolicy)
    {
        bool allowAnonymous = false;
        bool hasAuthorizeData = false;
        bool imperative = false;
        List<string> policies = [];

        foreach (object item in metadata)
        {
            switch (item)
            {
                case IAllowAnonymous:
                    allowAnonymous = true;
                    break;
                case IAuthorizeData authorize:
                    hasAuthorizeData = true;
                    if (!string.IsNullOrWhiteSpace(authorize.Policy))
                    {
                        AddPolicy(policies, authorize.Policy);
                    }
                    if (!string.IsNullOrWhiteSpace(authorize.Roles))
                    {
                        string roles = string.Join(',', authorize.Roles
                            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
                        AddPolicy(policies, "roles:" + roles);
                    }
                    break;
                case AuthorizeFilter or AllowAnonymousFilter:
                    break;
                case IAuthorizationFilter or IAsyncAuthorizationFilter:
                    imperative = true;
                    break;
            }
        }

        Anonymity anonymous = allowAnonymous
            ? Anonymity.Yes
            : hasAuthorizeData || hasFallbackPolicy
                ? Anonymity.No
                : Anonymity.Unknown;
        return new Auth
        {
            Anonymous = anonymous,
            Policies = anonymous == Anonymity.Yes ? [] : policies,
            Imperative = imperative,
        };
    }

    private static void AddPolicy(List<string> policies, string name)
    {
        if (!policies.Contains(name, StringComparer.Ordinal))
        {
            policies.Add(name);
        }
    }

    private static string? DescriptionOf(IReadOnlyList<object> metadata)
    {
        string? description = null;
        foreach (object item in metadata)
        {
            if (item is IEndpointDescriptionMetadata { Description: { Length: > 0 } declared })
            {
                description = declared;
            }
            else if (item is DescriptionAttribute { Description: { Length: > 0 } attributed })
            {
                description = attributed;
            }
        }
        return description;
    }

    /// <remarks>
    /// Guard: <c>AddNewtonsoftJson</c> registers an ApiExplorer provider that rewrites a JsonPatch
    /// body's type to <c>Operation[]</c>, a class with no <c>op</c> enum and an object-typed
    /// <c>value</c>. The action's own parameter type is what binds (JsonPatchHostTests.JH1).
    /// </remarks>
    private static Type BodyTypeOf(ApiParameterDescription parameter) =>
        parameter.ParameterDescriptor?.ParameterType is { } declared && JsonPatchSchema.IsDocument(declared)
            ? declared
            : parameter.Type ?? typeof(object);

    internal static string? ParameterDescription(ApiParameterDescription parameter) =>
        parameter.ParameterDescriptor is ControllerParameterDescriptor { ParameterInfo: { } info }
            ? info.GetCustomAttribute<DescriptionAttribute>()?.Description
            : null;

    private static string? OperationId(ActionDescriptor action, IReadOnlyList<object> metadata)
    {
        foreach (object item in metadata)
        {
            if (item is IEndpointNameMetadata { EndpointName: { Length: > 0 } name })
            {
                return name;
            }
        }
        if (!string.IsNullOrWhiteSpace(action.AttributeRouteInfo?.Name))
        {
            return action.AttributeRouteInfo.Name;
        }
        return action is ControllerActionDescriptor controller ? controller.ActionName : null;
    }

    private static McpToolAttribute? SelectionAttribute(
        ActionDescriptor action, IReadOnlyList<object> metadata, bool operationOnly)
    {
        if (action is ControllerActionDescriptor controller)
        {
            McpToolAttribute? operation = controller.MethodInfo
                .GetCustomAttribute<McpToolAttribute>(inherit: true);
            if (operation is not null || operationOnly)
            {
                return operation;
            }
            return controller.ControllerTypeInfo.GetCustomAttribute<McpToolAttribute>(inherit: true);
        }
        return metadata.OfType<McpToolAttribute>().LastOrDefault();
    }

    private static string OwnerOf(ActionDescriptor action, ApiDescription api) =>
        action is ControllerActionDescriptor named
            ? $"{named.ControllerName}.{named.ActionName}"
            : api.RelativePath ?? string.Empty;

    private static IReadOnlyList<string>? TagsFor(
        ActionDescriptor action,
        IReadOnlyList<object> metadata,
        ApiDescription api,
        Func<string, IReadOnlyList<string>?>? containerTags,
        List<CatalogDiagnostic> diagnostics)
    {
        string owner = OwnerOf(action, api);
        if (Declared(action, metadata, attribute => attribute.Tags) is { } declared)
        {
            return CleanVocabulary(declared, owner, diagnostics, TagRules);
        }
        if (Central(action, containerTags) is { } central)
        {
            return CleanVocabulary(central, owner, diagnostics, TagRules);
        }
        return action is ControllerActionDescriptor controller
            ? [controller.ControllerName]
            : api.GroupName is null ? null : [api.GroupName];
    }

    private static IReadOnlyList<string>? SearchTermsFor(
        ActionDescriptor action,
        IReadOnlyList<object> metadata,
        ApiDescription api,
        Func<string, IReadOnlyList<string>?>? containerSearchTerms,
        List<CatalogDiagnostic> diagnostics)
    {
        IReadOnlyList<string>? declared = Declared(action, metadata, attribute => attribute.SearchTerms)
            ?? Central(action, containerSearchTerms);
        if (declared is null)
        {
            return null;
        }
        IReadOnlyList<string> kept = CleanVocabulary(declared, OwnerOf(action, api), diagnostics, SearchTermRules);
        return kept.Count == 0 ? null : kept;
    }

    private static IReadOnlyList<string>? Central(
        ActionDescriptor action, Func<string, IReadOnlyList<string>?>? rule) =>
        rule is not null && action is ControllerActionDescriptor typed
            ? rule(typed.ControllerTypeInfo.FullName ?? typed.ControllerName)
            : null;

    private static IReadOnlyList<string>? Declared(
        ActionDescriptor action, IReadOnlyList<object> metadata, Func<McpToolAttribute, string[]?> read)
    {
        if (action is not ControllerActionDescriptor controller)
        {
            return metadata.OfType<McpToolAttribute>().LastOrDefault() is { } marker ? read(marker) : null;
        }
        // Guard: read both levels rather than reusing SelectionAttribute, which returns the method
        // attribute alone whenever one exists. A bare [McpTool] on a method would otherwise erase
        // the container's declaration, which the NestJS key-by-key merge keeps.
        McpToolAttribute? method = controller.MethodInfo.GetCustomAttribute<McpToolAttribute>(inherit: true);
        McpToolAttribute? container = controller.ControllerTypeInfo.GetCustomAttribute<McpToolAttribute>(inherit: true);
        return (method is null ? null : read(method)) ?? (container is null ? null : read(container));
    }

    private sealed record VocabularyRules(string EmptyCode, string EmptyReason, string DuplicateCode, string Noun);

    private static readonly VocabularyRules TagRules = new(
        DiagnosticCodes.EmptyTag, "no caller can ask for it", DiagnosticCodes.DuplicateTag, "tag");

    private static readonly VocabularyRules SearchTermRules = new(
        DiagnosticCodes.EmptySearchTerm, "it contributes no search text", DiagnosticCodes.DuplicateSearchTerm, "search term");

    // Guard: two entries that fold alike are two index contributions, which doubles that term's
    // search weight for what looks like a spelling choice, and one that folds to nothing can never
    // be matched. The host's own spelling of the first is kept.
    private static IReadOnlyList<string> CleanVocabulary(
        IReadOnlyList<string> declared, string owner, List<CatalogDiagnostic> diagnostics, VocabularyRules rules)
    {
        Dictionary<string, string> kept = new(StringComparer.Ordinal);
        List<string> order = [];
        foreach (string entry in declared)
        {
            string folded = ToolIndex.FoldToken(entry);
            if (folded.Length == 0)
            {
                diagnostics.Add(new CatalogDiagnostic(
                    rules.EmptyCode,
                    $"{owner} declares a {rules.Noun} that is empty once folded; {rules.EmptyReason}, so it was dropped."));
                continue;
            }
            if (kept.TryGetValue(folded, out string? first))
            {
                diagnostics.Add(new CatalogDiagnostic(
                    rules.DuplicateCode,
                    $"{owner} declares '{entry}' and '{first}', which fold to the same {rules.Noun}; the later one was dropped because two equal {rules.Noun}s double that term's search weight."));
                continue;
            }
            kept[folded] = entry;
            order.Add(entry);
        }
        return order;
    }

    // Guard: the levels are read apart and never replace one another. Each enters the tool version
    // on its own, so raising a controller's revision still reaches an action that declares its own.
    private static Revision? RevisionFor(
        ActionDescriptor action,
        IReadOnlyList<object> metadata,
        ApiDescription api,
        int? catalog,
        Func<string, int?>? containerRevision,
        List<CatalogDiagnostic> diagnostics)
    {
        string owner = OwnerOf(action, api);
        int? container = null;
        int? operation;
        if (action is ControllerActionDescriptor controller)
        {
            string name = controller.ControllerTypeInfo.FullName ?? controller.ControllerName;
            container = DeclaredRevision(
                owner, "container", diagnostics,
                (AttributeRevision(controller.ControllerTypeInfo.GetCustomAttribute<McpToolAttribute>(inherit: true)),
                    $"[McpTool(Revision)] on {name}"),
                (containerRevision?.Invoke(name), "options.ContainerRevision"));
            operation = DeclaredRevision(
                owner, "operation", diagnostics,
                (AttributeRevision(controller.MethodInfo.GetCustomAttribute<McpToolAttribute>(inherit: true)),
                    $"[McpTool(Revision)] on {owner}"));
        }
        else
        {
            operation = DeclaredRevision(
                owner, "operation", diagnostics,
                (AttributeRevision(metadata.OfType<McpToolAttribute>().LastOrDefault(marker => marker.Revision != 0)),
                    $"[McpTool(Revision)] on {owner}"));
        }
        return catalog is null && container is null && operation is null
            ? null
            : new Revision { Catalog = catalog, Container = container, Operation = operation };
    }

    private static int? AttributeRevision(McpToolAttribute? marker) =>
        marker is null || marker.Revision == 0 ? null : marker.Revision;

    // Guard: within one level the first declaration wins, and a later one is reported rather than
    // dropped in silence: raising it would change nothing, which is the failure a revision exists to prevent.
    private static int? DeclaredRevision(
        string owner, string level, List<CatalogDiagnostic> diagnostics, params (int? Value, string By)[] declarations)
    {
        (int Value, string By)? kept = null;
        foreach ((int? value, string by) in declarations)
        {
            if (value is not { } declared)
            {
                continue;
            }
            if (declared < 1)
            {
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.InvalidRevision,
                    $"{owner}: {by} declares the {level} revision {declared}; a revision is a whole number from 1, so it was ignored."));
                continue;
            }
            if (kept is { } first)
            {
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.RevisionOverridden,
                    $"{owner}: {first.By} sets the {level} revision to {first.Value}, so {by} ({declared}) has no effect; raising it will not change the tool version."));
                continue;
            }
            kept = (declared, by);
        }
        return kept?.Value;
    }

    private static string? PrefixFor(
        ActionDescriptor action, IReadOnlyList<object> metadata, Func<string, string?>? containerPrefix)
    {
        if (SelectionAttribute(action, metadata, operationOnly: false)?.Prefix is { } declared)
        {
            return declared;
        }
        if (containerPrefix is null || action is not ControllerActionDescriptor controller)
        {
            return null;
        }
        return containerPrefix(controller.ControllerTypeInfo.FullName ?? controller.ControllerName);
    }

    private static ToolAnnotations? OverridesFor(ActionDescriptor action, IReadOnlyList<object> metadata)
    {
        if (action is ControllerActionDescriptor controller)
        {
            ToolAnnotations? operation = controller.MethodInfo
                .GetCustomAttribute<McpToolAttribute>(inherit: true)?.Overrides;
            ToolAnnotations? container = controller.ControllerTypeInfo
                .GetCustomAttribute<McpToolAttribute>(inherit: true)?.Overrides;
            return Merge(container, operation);
        }
        return metadata.OfType<McpToolAttribute>().LastOrDefault()?.Overrides;
    }

    private static ToolAnnotations? Merge(ToolAnnotations? general, ToolAnnotations? specific)
    {
        if (general is null || specific is null)
        {
            return specific ?? general;
        }
        return new ToolAnnotations
        {
            ReadOnlyHint = specific.ReadOnlyHint ?? general.ReadOnlyHint,
            DestructiveHint = specific.DestructiveHint ?? general.DestructiveHint,
            IdempotentHint = specific.IdempotentHint ?? general.IdempotentHint,
        };
    }

    private static McpToolFamilyAttribute? FamilyOf(ActionDescriptor action, IReadOnlyList<object> metadata) =>
        action is ControllerActionDescriptor controller
            ? controller.MethodInfo.GetCustomAttribute<McpToolFamilyAttribute>(inherit: true)
            : metadata.OfType<McpToolFamilyAttribute>().LastOrDefault();

    private static SelectionMarker? ContainerMarker(ActionDescriptor action) =>
        action is ControllerActionDescriptor controller
            ? MarkerOf(controller.ControllerTypeInfo.GetCustomAttributes(inherit: true))
            : null;

    private static SelectionMarker? OperationMarker(
        ActionDescriptor action, IReadOnlyList<object> metadata) =>
        action is ControllerActionDescriptor controller
            ? MarkerOf(controller.MethodInfo.GetCustomAttributes(inherit: true))
            : MarkerOf(metadata);

    private static SelectionMarker? MarkerOf(IEnumerable<object> candidates)
    {
        bool include = false;
        bool exclude = false;
        foreach (object candidate in candidates)
        {
            if (candidate is IMcpSelectionMetadata marker)
            {
                if (marker.Include)
                {
                    include = true;
                }
                else
                {
                    exclude = true;
                }
            }
        }
        return SelectionResolver.Combine(include, exclude);
    }

    /// <summary>Spares a declaration that only a folded-away route could satisfy.</summary>
    /// <remarks>
    /// Only path parameters can differ between an operation's routes, so the folded routes'
    /// placeholders are the whole vocabulary this has to consider. The same relief is handed to
    /// both consumers, so a name reaches the reporter twice; the set keeps one warning per name.
    /// </remarks>
    private static CurationRelief? ReliefFor(
        EndpointDescriptor descriptor,
        IReadOnlyList<string>? foldedRoutes,
        List<CatalogDiagnostic> diagnostics)
    {
        if (foldedRoutes is null || foldedRoutes.Count == 0)
        {
            return null;
        }
        HashSet<string> foldedNames = new(
            foldedRoutes.SelectMany(route => RoutePlaceholder().Matches(route)
                .Select(match => match.Groups[1].Value)),
            StringComparer.Ordinal);
        foldedNames.ExceptWith(RoutePlaceholder().Matches(descriptor.Route)
            .Select(match => match.Groups[1].Value));
        if (foldedNames.Count == 0)
        {
            return null;
        }

        HashSet<string> reported = new(StringComparer.Ordinal);
        return new CurationRelief(foldedNames, name =>
        {
            if (!reported.Add(name))
            {
                return;
            }
            diagnostics.Add(new CatalogDiagnostic(
                DiagnosticCodes.CurationUnusedOnKeptRoute,
                $"Curation names '{name}', which exists only on a route folded away from "
                + $"{descriptor.Method} {descriptor.Route}; the declaration has no effect on the "
                + "route that is invoked."));
        });
    }

    /// <summary>
    /// Warns when a tool's name or description still names an argument the agent cannot reach.
    /// </summary>
    /// <remarks>
    /// The name is checked as well as the description: a generated name carries
    /// <c>by_&lt;path parameter&gt;</c>, so hiding a path parameter leaves the wire name in the name
    /// itself. The match is heuristic, which is why both codes stay warnings.
    ///
    /// Two codes, because the two haystacks deserve separate severities: the tool's own name and
    /// description, and the descriptions the host wrote in its curation declarations. Descriptions
    /// inherited from the backend's types are deliberately not searched — the host did not write
    /// them while curating, and a generic wire name such as <c>type</c> collides with ordinary
    /// schema prose often enough to drown the signal.
    /// </remarks>
    private static void ReportCurationLeaks(
        ToolDefinition tool, RequestTemplate template, IReadOnlyList<string> descriptions,
        List<CatalogDiagnostic> diagnostics)
    {
        List<string> curated = [
            .. template.Parameters
                .Where(parameter => parameter.Fill is not null || parameter.Argument is not null)
                .Select(parameter => parameter.Name),
            .. template.BodyAliases.Values,
            .. template.BodyFills.Keys,
        ];
        if (curated.Count == 0)
        {
            return;
        }

        IReadOnlyList<string> haystack = ToolIndex.Tokenize($"{tool.Name} {tool.Description}");
        List<IReadOnlyList<string>> curatedProse =
            [.. descriptions.Select(ToolIndex.Tokenize)];
        foreach (string wireName in curated)
        {
            IReadOnlyList<string> needle = ToolIndex.Tokenize(wireName);
            if (needle.Count == 0)
            {
                continue;
            }
            if (ContainsSequence(haystack, needle))
            {
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.CurationLeaksName,
                    $"Tool '{tool.Name}' still names the curated argument '{wireName}' in its name or "
                    + "description; the agent cannot act on it."));
            }
            if (curatedProse.Any(prose => ContainsSequence(prose, needle)))
            {
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.CurationLeaksNameInArgument,
                    $"Tool '{tool.Name}' still names the curated argument '{wireName}' in a curated "
                    + "argument description; the agent can search for it but cannot act on it."));
            }
        }
    }

    private static bool ContainsSequence(IReadOnlyList<string> haystack, IReadOnlyList<string> needle)
    {
        for (int start = 0; start + needle.Count <= haystack.Count; start++)
        {
            bool matched = true;
            for (int offset = 0; offset < needle.Count; offset++)
            {
                if (!string.Equals(haystack[start + offset], needle[offset], StringComparison.Ordinal))
                {
                    matched = false;
                    break;
                }
            }
            if (matched)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>Warns when two variants of one operation are the same tool twice.</summary>
    /// <remarks>
    /// Equal schemas and equal descriptions mean two cards competing for the same terms on the same
    /// route, which is the search pollution route folding already exists to prevent.
    /// </remarks>
    private static void ReportIndistinguishableVariants(
        IReadOnlyList<CatalogEntry> entries, List<CatalogDiagnostic> diagnostics)
    {
        Dictionary<string, string> seen = new(StringComparer.Ordinal);
        foreach (CatalogEntry entry in entries)
        {
            string key = string.Join(
                '\u0000',
                FoldKey(entry.Descriptor),
                entry.Tool.Description,
                entry.Tool.InputSchema.ToJsonString());
            if (seen.TryGetValue(key, out string? owner))
            {
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.VariantIndistinguishable,
                    $"Tools '{owner}' and '{entry.Tool.Name}' expose the same schema and the same "
                    + "description; make their first clauses differ or the search card cannot tell them apart."));
                continue;
            }
            seen[key] = entry.Tool.Name;
        }
    }

    private static string FoldKey(EndpointDescriptor descriptor) =>
        string.Join('\u0000', descriptor.Container, descriptor.OperationId, descriptor.Method.ToUpperInvariant());

    /// <remarks>
    /// Guard: the nesting rejection has to live here rather than in
    /// <c>RequestTemplate.Create</c>, because <see cref="Kind"/> collapses an unknown member type
    /// to <c>String</c> and the binding type then carries no trace of the object it came from.
    /// The twin is <c>objectBindingFor</c> in packages/core/src/tool.ts.
    /// </remarks>
    private static IReadOnlyList<ObjectMember> MembersOf(Parameter parameter)
    {
        if (parameter.Schema["properties"] is not JsonObject properties)
        {
            throw new SezzleeTemplateException(
                SezzleeTemplateException.UnsupportedObjectStyle,
                $"Parameter '{parameter.Name}' declares deepObject but carries no object schema.");
        }
        List<ObjectMember> members = [];
        foreach ((string name, JsonNode? node) in properties)
        {
            string? memberType = RequestBodyShape.TypeOf(node?["type"]);
            bool array = memberType == "array";
            string? memberScalar = array
                ? RequestBodyShape.TypeOf(node?["items"]?["type"])
                : memberType;
            if (memberScalar is null or "object" or "array"
                || node?["$ref"] is not null
                || node?["$defs"] is not null)
            {
                throw new SezzleeTemplateException(
                    SezzleeTemplateException.UnsupportedObjectNesting,
                    $"Member '{parameter.Name}.{name}' is not a query scalar or an array of them; flatten it out of the object.");
            }
            members.Add(new ObjectMember(name, Kind(memberScalar), array));
        }
        return members;
    }

    /// <summary>Builds the binding of a content-serialized parameter.</summary>
    /// <remarks>
    /// A urlencoded querystring freezes its members from the schema, as an object query parameter
    /// does, so the agent's own key order cannot change the composed string. The twin is
    /// <c>contentBindingFor</c> in packages/http/core/src/tool.ts.
    /// </remarks>
    private static ParameterBinding ContentBindingFor(Parameter parameter, ResolvedArgument? resolved)
    {
        if (parameter.Style is not null || parameter.Explode is not null)
        {
            throw new SezzleeTemplateException(
                SezzleeTemplateException.UnsupportedParameterContent,
                $"Parameter '{parameter.Name}' is serialized as {parameter.ContentType} and cannot also declare a style.");
        }
        string mediaType = parameter.ContentType!;
        List<ObjectMember>? members = null;
        if (mediaType == MediaTypes.UrlEncoded && parameter.Schema["properties"] is JsonObject properties)
        {
            members = [];
            foreach ((string name, JsonNode? node) in properties)
            {
                string? memberType = RequestBodyShape.TypeOf(node?["type"]);
                bool isArray = memberType == "array";
                string? scalar = isArray ? RequestBodyShape.TypeOf(node?["items"]?["type"]) : memberType;
                if (scalar is null || !FormScalars.Contains(scalar))
                {
                    throw new SezzleeTemplateException(
                        SezzleeTemplateException.UnsupportedObjectNesting,
                        $"Member '{parameter.Name}.{name}' is not a query scalar or an array of them.");
                }
                members.Add(new ObjectMember(name, Kind(scalar), isArray));
            }
        }
        return new ParameterBinding(
            parameter.Name,
            Enum.Parse<ParameterLocation>(parameter.In, ignoreCase: true),
            ParameterKind.String,
            Argument: resolved?.Argument,
            Fill: resolved?.Fill,
            Members: members,
            ContentType: mediaType);
    }

    internal static string? Locate(BindingSource? source)
    {
        if (source == BindingSource.Path)
        {
            return "path";
        }
        if (source == BindingSource.Query || source == BindingSource.ModelBinding)
        {
            return "query";
        }
        if (source == BindingSource.Header)
        {
            return "header";
        }
        return null;
    }

    // Guard: empty and whitespace-only segments are dropped so that a trailing slash or a doubled
    // separator cannot reach the route. The TS SDK's normalizeRoute folds them the same way, and a
    // host's selection rule is matched against this string in both SDKs.
    internal static string NormalizeRoute(string? relativePath)
    {
        string route = "/" + string.Join("/", (relativePath ?? string.Empty)
            .Split('/')
            .Select(segment => segment.Trim())
            .Where(segment => segment.Length > 0));
        return RoutePlaceholder().Replace(route, m => "{" + m.Groups[1].Value.TrimStart('*') + "}");
    }

    internal static (RequestTemplate? Template, string? FailureCode) BuildTemplate(
        EndpointDescriptor descriptor, List<CatalogDiagnostic> diagnostics,
        ToolVariant? variant = null, CurationRelief? relief = null, string? refDescription = null)
    {
        try
        {
            string[] parameterNames = [.. (descriptor.Parameters ?? []).Select(p => p.Name)];
            string? bodyRoot = descriptor.RequestBody is null
                ? null
                : RequestBodyShape.BodyRootOf(descriptor.RequestBody, parameterNames);
            JsonObject? flattened = descriptor.RequestBody is not null && bodyRoot is null
                ? descriptor.RequestBody.Schema["properties"] as JsonObject
                : null;
            string[] bodyFieldNames = [.. (flattened ?? []).Select(entry => entry.Key)];
            string[] requiredBodyFields = descriptor.RequestBody is not null && bodyRoot is null
                ? [.. (descriptor.RequestBody.Schema["required"] as JsonArray ?? [])
                    .Select(node => node?.GetValue<string>()).OfType<string>()]
                : [];
            ResolvedCuration curation = ResolvedCuration.Resolve(
                descriptor,
                variant,
                CurationShape.Of(
                    parameterNames,
                    (descriptor.Parameters ?? []).Where(p => p.Required).Select(p => p.Name),
                    bodyFieldNames,
                    requiredBodyFields,
                    bodyRoot,
                    descriptor.RequestBody?.Required != false),
                relief);
            HashSet<string> requiredFills = new(StringComparer.Ordinal);

            List<ParameterBinding> bindings = [];
            foreach (Parameter parameter in descriptor.Parameters ?? [])
            {
                ResolvedArgument? resolved = curation.Of(parameter.Name);
                if (resolved?.Fill is not null && parameter.Required)
                {
                    requiredFills.Add(parameter.Name);
                }
                if (parameter.ContentType is not null)
                {
                    bindings.Add(ContentBindingFor(parameter, resolved));
                    continue;
                }
                string? type = RequestBodyShape.TypeOf(parameter.Schema["type"]);
                bool isArray = type == "array";
                string? scalar = isArray
                    ? RequestBodyShape.TypeOf(parameter.Schema["items"]?["type"])
                    : type;
                if (type == "object" || parameter.Style == "deepObject")
                {
                    bindings.Add(new ParameterBinding(
                        parameter.Name,
                        Enum.Parse<ParameterLocation>(parameter.In, ignoreCase: true),
                        ParameterKind.String,
                        Argument: resolved?.Argument,
                        Fill: resolved?.Fill,
                        Members: MembersOf(parameter),
                        Notation: RequestTemplate.ObjectNotationFor(
                            parameter.Style, parameter.Explode, parameter.ObjectNotation, parameter.Name)));
                    continue;
                }
                ParameterLocation location = Enum.Parse<ParameterLocation>(parameter.In, ignoreCase: true);
                ScalarSerialization serialization = RequestTemplate.SerializationFor(
                    location, parameter.Style, parameter.Explode, isArray, parameter.Name, parameter.AllowReserved);
                bindings.Add(new ParameterBinding(
                    parameter.Name,
                    location,
                    Kind(scalar),
                    isArray,
                    serialization.ArraySeparator,
                    resolved?.Argument,
                    resolved?.Fill,
                    PathStyle: serialization.PathStyle,
                    Explode: serialization.Explode,
                    RawCookie: serialization.RawCookie,
                    AllowReserved: serialization.AllowReserved));
            }

            List<string>? bodyProperties = null;
            bool allowsAdditional = false;
            Dictionary<string, string> bodyAliases = new(StringComparer.Ordinal);
            Dictionary<string, ArgumentFill> bodyFills = new(StringComparer.Ordinal);
            ArgumentFill? rootFill = null;
            if (descriptor.RequestBody is { Schema: { } bodySchema })
            {
                if (bodyRoot is null)
                {
                    if (flattened is not null)
                    {
                        bodyProperties = [.. bodyFieldNames];
                    }
                    allowsAdditional = RequestBodyShape.AllowsAdditional(bodySchema);
                    foreach (string field in bodyFieldNames)
                    {
                        ResolvedArgument? resolved = curation.Of(field);
                        if (resolved?.Argument is { } agentName)
                        {
                            bodyAliases[agentName] = field;
                        }
                        if (resolved?.Fill is { } fill)
                        {
                            bodyFills[field] = fill;
                            if (requiredBodyFields.Contains(field))
                            {
                                requiredFills.Add(field);
                            }
                        }
                    }
                }
                else
                {
                    ResolvedArgument? resolved = curation.Of(bodyRoot);
                    rootFill = resolved?.Fill;
                    if (rootFill is not null && descriptor.RequestBody.Required != false)
                    {
                        requiredFills.Add(bodyRoot);
                    }
                }
            }

            string? contentType = descriptor.RequestBody?.ContentType;
            FormBinding? form = null;
            if (contentType is not null && MediaTypes.IsForm(contentType) && descriptor.RequestBody is { } requestBody)
            {
                JsonObject? formProperties = bodyRoot is null
                    ? flattened
                    : RequestBodyShape.TypeOf(requestBody.Schema["type"]) == "object"
                        ? requestBody.Schema["properties"] as JsonObject
                        : null;
                form = FormBindingFor(requestBody, formProperties);
            }
            bool binaryBody = contentType is not null
                && MediaTypes.IsBinary(contentType)
                && IsFileSchema(descriptor.RequestBody?.Schema);

            return (RequestTemplate.Create(
                new HttpMethod(descriptor.Method), descriptor.Route, bindings, bodyProperties,
                allowsAdditional, bodyRoot, bodyAliases, bodyFills, rootFill, requiredFills,
                contentType, form, FileSourcesOf(refDescription), descriptor.Auth.Carriers, binaryBody), null);
        }
        catch (Exception ex) when (ex is SezzleeTemplateException or ArgumentException or FormatException)
        {
            string code = ex is SezzleeTemplateException template
                ? template.Code
                : DiagnosticCodes.TemplateRejected;
            diagnostics.Add(new CatalogDiagnostic(
                code, $"{descriptor.Method} {descriptor.Route}: {ex.Message}"));
            return (null, code);
        }
    }

    private static ParameterKind Kind(string? type) => type switch
    {
        "integer" => ParameterKind.Integer,
        "number" => ParameterKind.Number,
        "boolean" => ParameterKind.Boolean,
        _ => ParameterKind.String,
    };

    [GeneratedRegex(@"\{([^}:?=]+)[^}]*\}")]
    private static partial Regex RoutePlaceholder();
}
