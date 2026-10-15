using System.Diagnostics;
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
using Sezzlee.AspNetCore.Visibility;
using Sezzlee.AspNetCore.Visibility.Probe;

namespace Sezzlee.AspNetCore;

internal sealed class SezzleeCatalogProvider(
    IApiDescriptionGroupCollectionProvider apiDescriptions,
    IOptions<SezzleeOptions> options,
    IOptions<JsonOptions> jsonOptions,
    IOptions<MvcOptions> mvcOptions,
    ISezzleeCache cache,
    ILogger<SezzleeCatalogProvider> logger,
    ToolAccessResolver access,
    IServiceProvider services,
    IAuthorizationPolicyProvider? policyProvider = null,
    Files.ISezzleeFileResolver? fileResolver = null,
    IServiceScopeFactory? scopes = null) : ISezzleeCatalogChangeSource
{
    private const int UncoveredNamesListed = 20;

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
    private SourceLoads? _loads;

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

    private bool HasSources =>
        options.Value.Families.Sources.Count > 0 || options.Value.Selection.Provider is not null;

    /// <remarks>
    /// With a family or selection source registered, rows are loaded first and reloads run one at a
    /// time; a rebuild that would turn a valid catalog fatal is refused and the current catalog kept
    /// (tool-families.md §Membership), because data added under a name another tool already has would
    /// otherwise take every tool offline.
    /// </remarks>
    /// <exception cref="SezzleeCatalogException">The rebuild is refused.</exception>
    public async ValueTask ReloadAsync(CancellationToken cancellationToken = default)
    {
        if (!HasSources)
        {
            lock (_gate)
            {
                _snapshot = Build(_loads);
                Interlocked.Increment(ref _generation);
            }
            await CommitAsync(cancellationToken);
            return;
        }

        await _reloads.WaitAsync(cancellationToken);
        try
        {
            SourceLoads loads = await LoadAndReportAsync(CatalogSources.All, cancellationToken);
            Rebuild(loads, "reload");
            await CommitAsync(cancellationToken);
        }
        finally
        {
            _reloads.Release();
        }
    }

    /// <summary>
    /// Loads the given sources for the first time. A catalog built earlier carries
    /// <c>family_not_loaded</c> or <c>selection_not_loaded</c> and is rebuilt here, which signals the
    /// change token.
    /// </summary>
    /// <exception cref="SezzleeCatalogException">
    /// A source failed and its <see cref="SourceLoadOptions.OnFailure"/> is <see cref="FamilyLoadFailure.Fatal"/>.
    /// </exception>
    internal async Task LoadSourcesAsync(CatalogSources sources, CancellationToken cancellationToken)
    {
        sources &= RegisteredSources();
        if (sources == CatalogSources.None)
        {
            return;
        }
        await _reloads.WaitAsync(cancellationToken);
        try
        {
            SourceLoads loads = await LoadAndReportAsync(sources, cancellationToken);
            ThrowIfFatal(sources, loads);
            bool built;
            lock (_gate)
            {
                _loads = loads;
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
                logger.LogInformation(
                    "sezzlee catalog rebuilt with {Sources}: {Tools} tools",
                    sources, Current.Result.Entries.Count);
            }
        }
        finally
        {
            _reloads.Release();
        }
    }

    /// <summary>
    /// Loads the given sources again and rebuilds the catalog only when one's rows changed, so an
    /// unchanged refresh signals no change to connected clients.
    /// </summary>
    /// <exception cref="SezzleeCatalogException">The rebuild is refused; the current catalog is kept.</exception>
    internal async Task RefreshSourcesAsync(CatalogSources sources, CancellationToken cancellationToken)
    {
        sources &= RegisteredSources();
        if (sources == CatalogSources.None)
        {
            return;
        }
        await _reloads.WaitAsync(cancellationToken);
        try
        {
            SourceLoads? previous = _loads;
            SourceLoads loads = await LoadAndReportAsync(sources, cancellationToken);
            if (previous is not null && !RowsChanged(sources, previous, loads))
            {
                _loads = loads;
                return;
            }
            Rebuild(loads, "refresh");
            await CommitAsync(cancellationToken);
            logger.LogInformation(
                "sezzlee catalog rebuilt after a refresh of {Sources}: {Tools} tools",
                sources, Current.Result.Entries.Count);
        }
        finally
        {
            _reloads.Release();
        }
    }

    private CatalogSources RegisteredSources() =>
        (options.Value.Families.Sources.Count > 0 ? CatalogSources.Families : CatalogSources.None)
        | (options.Value.Selection.Provider is not null ? CatalogSources.Selection : CatalogSources.None);

    private void Rebuild(SourceLoads loads, string verb)
    {
        lock (_gate)
        {
            Snapshot candidate = Build(loads);
            if (candidate.Fatal.Count > 0 && Current.Fatal.Count == 0)
            {
                throw new SezzleeCatalogException(
                    candidate.Fatal[0].Code,
                    $"sezzlee catalog {verb} refused; the current catalog is kept: "
                    + string.Join(" | ", candidate.Fatal.Select(d => d.Message)));
            }
            _loads = loads;
            _snapshot = candidate;
            Interlocked.Increment(ref _generation);
        }
    }

    private void ThrowIfFatal(CatalogSources sources, SourceLoads loads)
    {
        ToolFamilyOptions families = options.Value.Families;
        if (sources.HasFlag(CatalogSources.Families)
            && families.OnFailure == FamilyLoadFailure.Fatal
            && loads.Families.FirstOrDefault(l => l.Value is FamilyLoad.Failed) is { Value: FamilyLoad.Failed failed } entry)
        {
            throw new SezzleeCatalogException(
                DiagnosticCodes.FamilySourceFailed,
                $"sezzlee family source '{entry.Key}' failed and Families.OnFailure is Fatal: {failed.Error.Message}");
        }
        if (sources.HasFlag(CatalogSources.Selection)
            && options.Value.Selection.Source.OnFailure == FamilyLoadFailure.Fatal
            && loads.Selection is SelectionLoad.Failed selectionFailed)
        {
            throw new SezzleeCatalogException(
                DiagnosticCodes.SelectionSourceFailed,
                $"sezzlee selection source failed and Selection.Source.OnFailure is Fatal: {selectionFailed.Error.Message}");
        }
    }

    private async Task<SourceLoads> LoadAndReportAsync(CatalogSources sources, CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        SourceLoads previous = _loads ?? SourceLoads.None;
        Task<IReadOnlyDictionary<string, FamilyLoad>> families = sources.HasFlag(CatalogSources.Families)
            ? FamilyReader.LoadAsync(options.Value.Families, scopes, previous.Families, cancellationToken)
            : Task.FromResult(previous.Families);
        Task<SelectionLoad?> selection = sources.HasFlag(CatalogSources.Selection)
            ? SelectionReader.LoadAsync(options.Value.Selection, scopes, previous.Selection, cancellationToken)
            : Task.FromResult(previous.Selection);
        SourceLoads loaded = new(await families, await selection);
        TimeSpan elapsed = Stopwatch.GetElapsedTime(started);
        if (sources.HasFlag(CatalogSources.Families))
        {
            foreach ((string source, FamilyLoad load) in loaded.Families)
            {
                Report($"family source '{source}'", "member", load, members => members.Count, elapsed, "the operations it feeds are dropped");
            }
        }
        if (sources.HasFlag(CatalogSources.Selection) && loaded.Selection is { } selectionLoad)
        {
            Report("selection source", "row", selectionLoad, rows => rows.Count, elapsed, "endpoints without an attribute marker stay unexposed");
        }
        return previous.With(sources, loaded);
    }

    private void Report<T>(
        string subject, string unit, SourceLoad<T> load, Func<T, int> count, TimeSpan elapsed, string consequence)
        where T : class
    {
        switch (load)
        {
            case SourceLoad<T>.Loaded loaded:
                logger.LogInformation(
                    "sezzlee {Subject} returned {Count} {Unit}(s) in {Elapsed} ms",
                    subject, count(loaded.Value), unit, (long)elapsed.TotalMilliseconds);
                break;
            case SourceLoad<T>.Stale stale:
                logger.LogWarning(
                    stale.Error,
                    "sezzlee {Subject} failed; the {Count} {Unit}(s) it last returned stay published: {Reason}",
                    subject, count(stale.Value), unit, stale.Error.Message);
                break;
            case SourceLoad<T>.Failed failed:
                logger.LogError(
                    failed.Error,
                    "sezzlee {Subject} failed and has never returned {Unit}s; {Consequence}: {Reason}",
                    subject, unit, consequence, failed.Error.Message);
                break;
        }
    }

    private static bool RowsChanged(CatalogSources sources, SourceLoads previous, SourceLoads current) =>
        (sources.HasFlag(CatalogSources.Families) && MembersChanged(previous.Families, current.Families))
        || (sources.HasFlag(CatalogSources.Selection) && SelectionReader.Changed(previous.Selection, current.Selection));

    private static bool MembersChanged(
        IReadOnlyDictionary<string, FamilyLoad> previous, IReadOnlyDictionary<string, FamilyLoad> current) =>
        current.Any(entry =>
        {
            IReadOnlyList<McpFamilyMember>? before = previous.GetValueOrDefault(entry.Key)?.Published;
            IReadOnlyList<McpFamilyMember>? after = entry.Value.Published;
            return before is null || after is null
                ? before != after
                : !before.SequenceEqual(after);
        });

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
            if (IsPendingBackgroundLoad(diagnostic.Code))
            {
                logger.LogInformation("sezzlee {Code}: {Message}", diagnostic.Code, diagnostic.Message);
                continue;
            }
            switch (SeverityOf(diagnostic.Code))
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

    private bool IsPendingBackgroundLoad(string code) => code switch
    {
        DiagnosticCodes.FamilyNotLoaded => options.Value.Families.LoadMode == FamilyLoadMode.Background,
        DiagnosticCodes.SelectionNotLoaded => options.Value.Selection.Source.LoadMode == FamilyLoadMode.Background,
        _ => false,
    };

    private Snapshot Current
    {
        get
        {
            lock (_gate)
            {
                return _snapshot ??= Build(_loads);
            }
        }
    }

    private Snapshot Build(SourceLoads? loads)
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
            familyLoads: loads?.Families,
            catalogRevision: options.Value.Revision,
            containerRevision: options.Value.ContainerRevision,
            endpointDescription: options.Value.Description,
            endpointTags: options.Value.EndpointTags,
            endpointSearchTerms: options.Value.EndpointSearchTerms,
            selectionSource: options.Value.Selection.Provider is null ? null : SelectionReader.StateOf(loads?.Selection));
        if (schemaNotes.Count > 0)
        {
            result = result with { Diagnostics = [.. schemaNotes, .. result.Diagnostics] };
        }
        if (ReportUncovered(result) is { } uncovered)
        {
            result = result with { Diagnostics = [.. result.Diagnostics, uncovered] };
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
            .Where(d => SeverityOf(d.Code) >= options.Value.Diagnostics.FailOn)
            .ToArray();
        HashSet<string> policyNames = result.Entries
            .SelectMany(e => e.Descriptor.Auth.Policies)
            .ToHashSet(StringComparer.Ordinal);

        return new Snapshot(result, byName, index, Ranking.CatalogOf(documents), fatal, policyNames);
    }

    /// <remarks>
    /// Guard: <see cref="UncoveredVisibility.Fatal"/> raises only this code, so the diagnostics options a
    /// host already tunes by code keep their say for every other one.
    /// </remarks>
    private CatalogSeverity SeverityOf(string code) =>
        code == DiagnosticCodes.VisibilityUncovered && options.Value.Visibility.OnUncovered == UncoveredVisibility.Fatal
            ? CatalogSeverity.Fatal
            : options.Value.Diagnostics.SeverityOf(code);

    /// <summary>
    /// Names the tools no tier can decide before a call: the authorizer does not cover them, their
    /// declarative facts are imperative or undeclared, and the probe cannot reach them. Runs only for a
    /// host that registered an authorizer or asked for <see cref="UncoveredVisibility.Fatal"/>; any other
    /// host never opted in to deciding visibility per tool, so reporting would only add noise.
    /// </summary>
    private CatalogDiagnostic? ReportUncovered(CatalogBuildResult result)
    {
        VisibilityOptions visibility = options.Value.Visibility;
        if (!access.HasAuthorizer && visibility.OnUncovered != UncoveredVisibility.Fatal)
        {
            return null;
        }
        IProbeEvaluator? probe = visibility.Tier == VisibilityTier.Probe
            ? services.GetService<IProbeEvaluator>()
            : null;
        string[] uncovered = access.WithCoverage(covers => result.Entries
            .Where(entry => !covers(entry.Info)
                && (entry.Descriptor.Auth.Imperative || entry.Descriptor.Auth.Anonymous == Anonymity.Unknown)
                && probe?.CanProbe(entry) != true)
            .Select(entry => entry.Tool.Name)
            .ToArray());
        if (uncovered.Length == 0)
        {
            return null;
        }
        logger.LogDebug("sezzlee visibility_uncovered tools: {Tools}", string.Join(", ", uncovered));
        string listed = string.Join(", ", uncovered.Take(UncoveredNamesListed));
        string more = uncovered.Length > UncoveredNamesListed ? $", and {uncovered.Length - UncoveredNamesListed} more" : string.Empty;
        return new CatalogDiagnostic(
            DiagnosticCodes.VisibilityUncovered,
            $"{uncovered.Length} tool(s) have no visibility decision before a call: the authorizer does not cover them, "
            + $"their declared authorization is imperative or absent, and no probe reaches them ({listed}{more}).");
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
                "Newtonsoft.Json input formatter detected; body property names use CLR names. Add Sezzlee.AspNetCore.NewtonsoftJson and call services.AddSezzleeNewtonsoftJson(), or set options.Schema.PropertyName to mirror your ContractResolver."));
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
                "Newtonsoft.Json input formatter detected; enum wire format cannot be read, so enums accept both the name and the number. Add Sezzlee.AspNetCore.NewtonsoftJson and call services.AddSezzleeNewtonsoftJson(), or set options.Schema.EnumShape to pin one form."));
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
