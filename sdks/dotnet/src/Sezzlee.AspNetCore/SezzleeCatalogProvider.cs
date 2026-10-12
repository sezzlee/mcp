using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApiExplorer;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;
using Sezzlee.AspNetCore.Caching;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Search;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore;

internal sealed class SezzleeCatalogProvider(
    IApiDescriptionGroupCollectionProvider apiDescriptions,
    IOptions<SezzleeOptions> options,
    IOptions<JsonOptions> jsonOptions,
    IOptions<MvcOptions> mvcOptions,
    ISezzleeCache cache,
    ILogger<SezzleeCatalogProvider> logger,
    IAuthorizationPolicyProvider? policyProvider = null,
    Files.ISezzleeFileResolver? fileResolver = null,
    IServiceScopeFactory? scopes = null) : ISezzleeCatalogChangeSource
{
    private const string NewtonsoftInputFormatter =
        "Microsoft.AspNetCore.Mvc.Formatters.NewtonsoftJsonInputFormatter";

    private sealed record Snapshot(
        CatalogBuildResult Result,
        IReadOnlyDictionary<string, CatalogEntry> ByName,
        ToolIndex Index,
        RankCatalog RankCatalog,
        IReadOnlyList<CatalogDiagnostic> Fatal,
        IReadOnlySet<string> PolicyNames);

    private readonly object _gate = new();
    private ICollection<EndpointDataSource>? _dataSources;
    private string? _reservedPrefix;
    private Snapshot? _snapshot;
    private CancellationTokenSource _changeSource = new();
    private long _generation;
    private readonly SemaphoreSlim _reloads = new(1, 1);
    private IReadOnlyDictionary<string, FamilyLoad>? _familyLoads;

    public void Attach(ICollection<EndpointDataSource> dataSources, string reservedPrefix)
    {
        ArgumentNullException.ThrowIfNull(dataSources);
        lock (_gate)
        {
            _dataSources = dataSources;
            _reservedPrefix = reservedPrefix;
            _snapshot = null;
        }
    }

    public long Generation => Interlocked.Read(ref _generation);

    public IChangeToken GetChangeToken() => new CancellationChangeToken(Volatile.Read(ref _changeSource).Token);

    public IReadOnlySet<string> PolicyNames => Current.PolicyNames;

    /// <remarks>
    /// With a family source registered, members are loaded first and reloads run one at a time; a
    /// rebuild that would turn a valid catalog fatal is refused and the current catalog kept
    /// (tool-families.md §Membership), because member data added under a name another tool already
    /// has would otherwise take every tool offline.
    /// </remarks>
    /// <exception cref="SezzleeCatalogException">The rebuild is refused.</exception>
    public async ValueTask ReloadAsync(CancellationToken cancellationToken = default)
    {
        if (options.Value.Families.Sources.Count == 0)
        {
            lock (_gate)
            {
                _snapshot = Build(_familyLoads);
                Interlocked.Increment(ref _generation);
            }
            await CommitAsync(cancellationToken);
            return;
        }

        await _reloads.WaitAsync(cancellationToken);
        try
        {
            IReadOnlyDictionary<string, FamilyLoad> loads = await FamilyReader.LoadAsync(
                options.Value.Families, scopes, _familyLoads, cancellationToken);
            lock (_gate)
            {
                Snapshot candidate = Build(loads);
                if (candidate.Fatal.Count > 0 && Current.Fatal.Count == 0)
                {
                    throw new SezzleeCatalogException(
                        candidate.Fatal[0].Code,
                        "sezzlee catalog reload refused; the current catalog is kept: "
                        + string.Join(" | ", candidate.Fatal.Select(d => d.Message)));
                }
                _familyLoads = loads;
                _snapshot = candidate;
                Interlocked.Increment(ref _generation);
            }
            await CommitAsync(cancellationToken);
        }
        finally
        {
            _reloads.Release();
        }
    }

    /// <summary>
    /// Loads family members once, at startup. A catalog built earlier carries
    /// <c>family_not_loaded</c> and is rebuilt here, which signals the change token.
    /// </summary>
    internal async Task LoadFamiliesAsync(CancellationToken cancellationToken)
    {
        if (options.Value.Families.Sources.Count == 0)
        {
            return;
        }
        await _reloads.WaitAsync(cancellationToken);
        try
        {
            IReadOnlyDictionary<string, FamilyLoad> loads = await FamilyReader.LoadAsync(
                options.Value.Families, scopes, _familyLoads, cancellationToken);
            bool built;
            lock (_gate)
            {
                _familyLoads = loads;
                built = _snapshot is not null;
                if (built)
                {
                    _snapshot = Build(loads);
                    Interlocked.Increment(ref _generation);
                }
            }
            if (built)
            {
                await CommitAsync(cancellationToken);
            }
        }
        finally
        {
            _reloads.Release();
        }
    }

    private async ValueTask CommitAsync(CancellationToken cancellationToken)
    {
        CancellationTokenSource next = new();
        CancellationTokenSource previous = Interlocked.Exchange(ref _changeSource, next);
        previous.Cancel();
        previous.Dispose();

        await cache.ClearAsync(cancellationToken);
    }

    public CatalogBuildResult Result => Current.Result;

    public CatalogEntry? Find(string name) =>
        Current.ByName.TryGetValue(name, out CatalogEntry? entry) ? entry : null;

    public IReadOnlyList<CatalogEntry> Search(string? query, int limit, IReadOnlyList<string>? tags = null)
    {
        Snapshot snapshot = Current;
        return snapshot.Index.Search(query, limit, tags)
            .Select(name => snapshot.ByName[name])
            .ToArray();
    }

    /// <summary>The index and ranker catalog of one snapshot, read together so a reload cannot split them.</summary>
    internal (ToolIndex Index, RankCatalog Catalog, IReadOnlyDictionary<string, CatalogEntry> ByName) SearchSurface
    {
        get
        {
            Snapshot snapshot = Current;
            return (snapshot.Index, snapshot.RankCatalog, snapshot.ByName);
        }
    }

    public void EnsureValid()
    {
        Snapshot snapshot = Current;
        if (snapshot.Fatal.Count == 0)
        {
            return;
        }
        throw new SezzleeCatalogException(
            snapshot.Fatal[0].Code,
            $"sezzlee catalog has {snapshot.Fatal.Count} fatal diagnostic(s): "
            + string.Join(" | ", snapshot.Fatal.Select(d => d.Message)));
    }

    public void WarmUp()
    {
        Snapshot snapshot = Current;
        logger.LogInformation(
            "sezzlee catalog: {Discovered} discovered, {Selected} selected, {Tools} tools, {Diagnostics} diagnostic(s)",
            snapshot.Result.Discovered, snapshot.Result.Selected,
            snapshot.Result.Entries.Count, snapshot.Result.Diagnostics.Count);
        foreach (CatalogDiagnostic diagnostic in snapshot.Result.Diagnostics)
        {
            switch (options.Value.Diagnostics.SeverityOf(diagnostic.Code))
            {
                case CatalogSeverity.Fatal:
                    logger.LogCritical("sezzlee {Code}: {Message}", diagnostic.Code, diagnostic.Message);
                    break;
                case CatalogSeverity.EndpointDropped:
                    logger.LogError("sezzlee {Code}: {Message}", diagnostic.Code, diagnostic.Message);
                    break;
                default:
                    logger.LogWarning("sezzlee {Code}: {Message}", diagnostic.Code, diagnostic.Message);
                    break;
            }
        }
    }

    private Snapshot Current
    {
        get
        {
            lock (_gate)
            {
                return _snapshot ??= Build(_familyLoads);
            }
        }
    }

    private Snapshot Build(IReadOnlyDictionary<string, FamilyLoad>? familyLoads)
    {
        if (_dataSources is null)
        {
            throw new InvalidOperationException(
                "sezzlee catalog is not attached to routing. Call app.MapSezzlee(...) after routing is configured.");
        }

        (SchemaMapperOptions schema, IReadOnlyList<CatalogDiagnostic> schemaNotes) = ResolveSchemaBinding();

        EndpointDataSource endpoints = new CompositeEndpointDataSource(_dataSources);
        bool hasFallbackPolicy = policyProvider is not null
            && policyProvider.GetFallbackPolicyAsync().GetAwaiter().GetResult() is not null;
        CatalogBuildResult result = EndpointCatalog.Build(
            apiDescriptions, endpoints, options.Value.Selection.Default,
            reservedRoutePrefix: _reservedPrefix, schema: schema,
            hasFallbackPolicy: hasFallbackPolicy,
            prefixMode: options.Value.Naming.PrefixMode,
            containerPrefix: options.Value.Naming.Prefix,
            containerTags: options.Value.Tags,
            containerSearchTerms: options.Value.SearchTerms,
            severityOf: options.Value.Diagnostics.SeverityOf,
            curation: options.Value.Arguments,
            selectionRules: options.Value.Selection.Rules,
            groupQueryObjects: options.Value.Query.Grouping == QueryObjectGrouping.Group,
            refDescription: fileResolver?.RefDescription,
            families: options.Value.Families,
            familyLoads: familyLoads,
            catalogRevision: options.Value.Revision,
            containerRevision: options.Value.ContainerRevision);
        if (schemaNotes.Count > 0)
        {
            result = result with { Diagnostics = [.. schemaNotes, .. result.Diagnostics] };
        }

        Dictionary<string, CatalogEntry> byName = result.Entries
            .ToDictionary(e => e.Tool.Name, StringComparer.Ordinal);
        SearchDocument[] documents = result.Entries.Select(e => new SearchDocument(
            e.Tool.Name,
            e.Tool.Description,
            e.Descriptor.Tags ?? [],
            e.Descriptor.Route,
            e.AlternateRoutes,
            SearchParameters.From(
                e.Tool.InputSchema,
                new HashSet<string>(
                    (e.Descriptor.Parameters ?? [])
                        .Where(p => p.Style == "deepObject")
                        .Select(p => p.Name),
                    StringComparer.Ordinal)),
            e.Descriptor.SearchTerms)).ToArray();
        ToolIndex index = new(documents);
        CatalogDiagnostic[] fatal = result.Diagnostics
            .Where(d => options.Value.Diagnostics.SeverityOf(d.Code)
                >= options.Value.Diagnostics.FailOn)
            .ToArray();
        HashSet<string> policyNames = result.Entries
            .SelectMany(e => e.Descriptor.Auth.Policies)
            .ToHashSet(StringComparer.Ordinal);

        return new Snapshot(result, byName, index, Ranking.CatalogOf(documents), fatal, policyNames);
    }

    private (SchemaMapperOptions, IReadOnlyList<CatalogDiagnostic>) ResolveSchemaBinding()
    {
        List<CatalogDiagnostic> notes = [];
        bool newtonsoft = mvcOptions.Value.InputFormatters
            .Any(f => f.GetType().FullName == NewtonsoftInputFormatter);
        JsonSerializerOptions serializer = jsonOptions.Value.JsonSerializerOptions;

        Func<PropertyInfo, string> propertyName;
        if (options.Value.Schema.PropertyName is { } declaredName)
        {
            propertyName = declaredName;
        }
        else if (newtonsoft)
        {
            propertyName = property => property.Name;
            notes.Add(new CatalogDiagnostic(
                "naming_policy_unresolved",
                "Newtonsoft.Json input formatter detected; body property names use CLR names. Set options.Schema.PropertyName to mirror your ContractResolver if it renames properties."));
        }
        else
        {
            propertyName = property =>
                property.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name
                ?? serializer.PropertyNamingPolicy?.ConvertName(property.Name)
                ?? property.Name;
        }

        Func<Type, EnumFacts> enumShape;
        Func<PropertyInfo, JsonObject?>? propertySchema = null;
        if (options.Value.Schema.EnumShape is { } declaredEnum)
        {
            enumShape = declaredEnum;
        }
        else if (newtonsoft)
        {
            enumShape = EnumWireFormat.Unresolved;
            notes.Add(new CatalogDiagnostic(
                "enum_format_unresolved",
                "Newtonsoft.Json input formatter detected; enum wire format cannot be read, so enums accept both the name and the number. Set options.Schema.EnumShape to pin one form."));
        }
        else
        {
            enumShape = enumType => EnumWireFormat.Describe(enumType, serializer);
            propertySchema = property => PropertyEnumSchema(property, serializer);
        }

        SchemaMapperOptions mapper = new()
        {
            PropertyName = propertyName,
            TypeName = options.Value.Schema.TypeName,
            TypeSchema = options.Value.Schema.TypeSchema,
            EnumShape = EnumWireFormat.Cached(enumShape),
            PropertySchema = propertySchema,
            DropReadOnlyProperties = options.Value.Schema.DropReadOnlyProperties,
            MaxDepth = options.Value.Schema.MaxDepth,
        };
        return (mapper, notes);
    }

    private static JsonObject? PropertyEnumSchema(PropertyInfo property, JsonSerializerOptions serializer)
    {
        Type resolved = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
        if (!resolved.IsEnum
            || property.GetCustomAttribute<JsonConverterAttribute>() is not { } attribute)
        {
            return null;
        }

        JsonConverter? converter;
        try
        {
            converter = attribute.CreateConverter(resolved)
                ?? (attribute.ConverterType is { } type
                    ? Activator.CreateInstance(type) as JsonConverter
                    : null);
        }
        catch (Exception ex) when (ex is MissingMethodException or InvalidOperationException or NotSupportedException)
        {
            return null;
        }
        if (converter is null)
        {
            return null;
        }

        JsonSerializerOptions scoped = new(serializer);
        scoped.Converters.Insert(0, converter);
        return SchemaWriter.EnumSchemaFor(EnumWireFormat.Describe(resolved, scoped));
    }
}
