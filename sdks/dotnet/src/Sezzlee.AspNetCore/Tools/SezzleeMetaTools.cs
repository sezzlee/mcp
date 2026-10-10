using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using Sezzlee.AspNetCore.Caching;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Errors;
using Sezzlee.AspNetCore.Requests;
using Sezzlee.AspNetCore.Search;
using Sezzlee.AspNetCore.Spec;
using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.AspNetCore.Tools;

[McpServerToolType]
internal sealed class SezzleeMetaTools(
    SezzleeCatalogProvider catalog,
    SezzleeDispatcher dispatcher,
    IInvokeResultMapper mapper,
    CallerVisibilityProvider visibility,
    ICallerScopeResolver scopeResolver,
    IOptions<SezzleeOptions> options,
    IHttpContextAccessor httpContextAccessor,
    ILogger<SezzleeMetaTools> logger,
    IToolRanker? ranker = null)
{
    public const int DefaultLimit = 20;
    public const int MaxLimit = 50;
    public const int CardDescriptionBudget = 160;

    /// <summary>
    /// How many distinct tags the answer will list before offering none at all.
    /// </summary>
    /// <remarks>
    /// Guard: the vocabulary describes the catalog, not the query, so none of the narrowing
    /// arguments shrinks it and an over-budget answer would be unactionable. Truncating instead
    /// would be worse than omitting: an agent that does not see a tag concludes it does not exist.
    /// </remarks>
    public const int MaxTagVocabulary = 200;

    private sealed record DecisionContext(Func<CatalogEntry, VisibilityDecision> Decide, CallerScope Scope, HttpRequest? Outer);

    /// <remarks>
    /// Guard: <c>detail</c> is a string carrying <see cref="AllowedValuesAttribute"/> rather than a CLR
    /// enum. An enum parameter is deserialized during argument binding, so an unrecognised value would
    /// throw before this method runs and the answer would be neither the clamp
    /// <see href="../../../../packages/http/spec/search-semantics.md">search-semantics.md</see> requires nor an
    /// sezzlee envelope from <see cref="Respond"/>. The attribute only decorates the published schema, which
    /// is what keeps the clamp reachable in both SDKs. T16 pins the published shape.
    /// </remarks>
    [McpServerTool(Name = "search_tools", ReadOnly = true, Idempotent = true)]
    [Description("Find operations when you do not know their exact names. Keywords rank matches; an empty query lists everything by name. Keep queries short: a term matches operation text by prefix. Results are compact cards — name, short description and a parameter summary. Set detail=\"schema\" to get the full definition of every result in the same answer, which pays off only when you expect to invoke one of them immediately; pair it with a small limit because a schema page is much larger. When you already hold an exact operation name, call load_tool instead of searching for it.")]
    public async Task<CallToolResult> SearchTools(
        [Description("Keywords matched by prefix against operation names, descriptions, declared search terms, routes, argument names and tag text; keywords rank results, they do not filter them. Empty lists everything. To require a whole tag, use tags.")]
        string query = "",
        [Description("Maximum number of results, 1-50.")]
        int limit = DefaultLimit,
        [Description("Shape of each result: \"card\" for the compact card, \"schema\" for the full definition load_tool would return. Any other value is card. A schema page is much larger; pair it with a small limit.")]
        [AllowedValues("card", "schema")]
        string detail = "card",
        [Description("Tags every result must carry, matched against the whole tag and insensitive to case and accents. Empty applies no filter; the answer\u0027s tags field lists what is available.")]
        string[] tags = null!,
        CancellationToken cancellationToken = default)
    {
        bool wantsSchema = string.Equals(detail, "schema", StringComparison.Ordinal);
        catalog.EnsureValid();
        DecisionContext context = await DecideAsync(cancellationToken);
        int capped = Math.Clamp(limit, 1, MaxLimit);
        int everything = Math.Max(1, catalog.Result.Entries.Count);
        int probeBudget = options.Value.Visibility.Tier == VisibilityTier.Probe
            ? Math.Max(0, options.Value.Visibility.ProbeTopK)
            : 0;

        IReadOnlyList<CatalogEntry>? ordered = await RankedAsync(query, everything, tags, cancellationToken);
        if (ordered is null)
        {
            return Respond(SdkErrors.RefuseRankerUnavailable(), isError: true);
        }
        List<CatalogEntry> ranked = [.. ordered];
        Dictionary<string, VisibilityDecision> decisions = new(StringComparer.Ordinal);
        List<CatalogEntry> probeQueue = [];
        foreach (CatalogEntry entry in ranked)
        {
            VisibilityDecision decision = context.Decide(entry);
            decisions[entry.Tool.Name] = decision;
            if (decision == VisibilityDecision.Unknown && probeBudget > 0 && visibility.CanProbe(entry))
            {
                probeBudget -= 1;
                probeQueue.Add(entry);
            }
        }

        if (probeQueue.Count > 0)
        {
            int concurrency = Math.Max(1, options.Value.Visibility.ProbeConcurrency);
            using SemaphoreSlim gate = new(concurrency);
            VisibilityDecision[] probed = new VisibilityDecision[probeQueue.Count];
            await Task.WhenAll(probeQueue.Select(async (entry, index) =>
            {
                await gate.WaitAsync(cancellationToken);
                try
                {
                    probed[index] = await visibility.ProbeAsync(context.Scope, context.Outer, entry, cancellationToken);
                }
                finally
                {
                    gate.Release();
                }
            }));
            for (int index = 0; index < probeQueue.Count; index++)
            {
                decisions[probeQueue[index].Tool.Name] = probed[index];
            }
        }

        List<object> results = [];
        foreach (CatalogEntry entry in ranked)
        {
            VisibilityDecision decision = decisions[entry.Tool.Name];
            if (!IsVisible(decision))
            {
                continue;
            }
            results.Add(wantsSchema ? Loaded(entry, decision) : Card(entry, decision));
            if (results.Count == capped)
            {
                break;
            }
        }
        int total = 0;
        HashSet<string> vocabulary = new(StringComparer.Ordinal);
        foreach (CatalogEntry entry in catalog.Result.Entries)
        {
            if (!IsVisible(context.Decide(entry)))
            {
                continue;
            }
            total += 1;
            foreach (string tag in entry.Descriptor.Tags ?? [])
            {
                vocabulary.Add(ToolIndex.FoldToken(tag));
            }
        }
        string[]? known = vocabulary.Count is 0 or > MaxTagVocabulary
            ? null
            : [.. vocabulary.Order(StringComparer.Ordinal)];

        return Respond(
            new { total, results, tags = known },
            isError: false, summaryOf: results, narrowing: SearchNarrowing);
    }

    [McpServerTool(Name = "load_tool", ReadOnly = true, Idempotent = true)]
    [Description("Read the full definition of one operation: description, JSON input schema and behavior hints. Put the operation's exact name in the name argument. This is a direct lookup, not a search — it takes a name, never keywords. Use it after search_tools names an operation, or to re-read a schema whose name you already hold.")]
    public async Task<CallToolResult> LoadTool(
        [Description("Operation name exactly as returned by search_tools.")]
        string name,
        CancellationToken cancellationToken = default)
    {
        catalog.EnsureValid();
        CatalogEntry? entry = catalog.Find(name);
        if (entry is null)
        {
            return UnknownTool(name);
        }
        DecisionContext context = await DecideAsync(cancellationToken);
        VisibilityDecision decision = context.Decide(entry);
        if (decision == VisibilityDecision.Unknown
            && options.Value.Visibility.Tier == VisibilityTier.Probe
            && options.Value.Visibility.ProbeTopK > 0
            && visibility.CanProbe(entry))
        {
            decision = await visibility.ProbeAsync(context.Scope, context.Outer, entry, cancellationToken);
        }
        if (!IsVisible(decision))
        {
            return UnknownTool(name);
        }
        return Respond(Loaded(entry, decision), isError: false);
    }

    [McpServerTool(Name = "invoke_tool")]
    [Description("Invoke one operation with a JSON object of arguments that matches its input schema from load_tool. The call runs through the backend's own request pipeline with the caller's identity; the result carries the HTTP status and response body.")]
    public async Task<CallToolResult> InvokeTool(
        [Description("Operation name exactly as returned by search_tools.")]
        string name,
        [Description("Arguments as a JSON object whose keys are the input schema's properties. Send the object itself, not a string containing JSON.")]
        JsonElement arguments,
        CancellationToken cancellationToken,
        [Description("The version load_tool returned for this operation. When present, the call is refused with tool_changed if the operation changed after it was loaded; omit it to skip the check.")]
        string version = null!)
    {
        catalog.EnsureValid();
        CatalogEntry? entry = catalog.Find(name);
        if (entry is null)
        {
            return UnknownTool(name);
        }
        if (version is not null && !string.Equals(version, ToolVersion.Of(entry.Tool), StringComparison.Ordinal))
        {
            return Respond(SdkErrors.RefuseChangedTool(entry.Tool.Name), isError: true);
        }
        if (entry.Template is not { } template)
        {
            return ErrorResult(SdkErrorCode.NotInvocable, $"Operation '{name}' cannot be invoked through sezzlee; see the catalog diagnostics.");
        }

        NormalizedInvokeArguments normalized = InvokeArguments.Normalize(arguments);
        if (normalized.Unwrapped)
        {
            logger.LogWarning(
                "invoke_tool received the arguments for '{Tool}' as JSON text instead of a JSON object; the text was parsed. A client that double-encodes this argument is defective.",
                name);
        }

        try
        {
            IReadOnlyDictionary<string, JsonElement>? deferred = await CallerFactory.ResolveAsync(
                template,
                options.Value.Arguments,
                CallerFactory.From(httpContextAccessor.HttpContext),
                cancellationToken);
            InvokeTarget target = new(entry.Tool.Name, entry.Descriptor.Method, entry.Descriptor.Route);
            TimeSpan deadline = TimeoutFor(target);
            InvokeOptions invoke = options.Value.Invoke;
            DispatchFiles files = new(target, invoke.MaxInlineFileBytes, invoke.MaxFileBytes);
            DispatchResult result;
            try
            {
                result = await dispatcher.DispatchAsync(
                    template, normalized.Value, httpContextAccessor.HttpContext?.Request, cancellationToken,
                    deferred, deadline, files);
            }
            catch (SezzleeDispatchTimeout)
            {
                return Respond(
                    SdkErrors.RefuseTimedOut((int)deadline.TotalMilliseconds),
                    isError: true);
            }
            catch (SezzleeFileRefused refused)
            {
                return Respond(
                    SdkErrors.RefuseUnresolvedFile(refused.Field, refused.Reason, refused.Limit),
                    isError: true);
            }
            InvokeOutcome outcome = mapper.Map(result.ToBackendResponse(), VocabularyOf(entry, template));
            IReadOnlyList<FieldError> narrowing = SdkErrors.NarrowingArguments(entry.Tool.InputSchema);
            return outcome switch
            {
                InvokeSucceeded succeeded => Respond(
                    succeeded.Success, isError: false,
                    summaryOf: succeeded.Success.Body, narrowing: narrowing, target: target),
                InvokeFailed failed => Respond(
                    failed.Error, isError: true, narrowing: narrowing, target: target),
                _ => throw new InvalidOperationException($"Unhandled invoke outcome: {outcome.GetType()}"),
            };
        }
        catch (SezzleeArgumentException ex)
        {
            return Respond(
                SdkErrors.Create(JsonSerializer.Deserialize<SdkErrorCode>($"\"{ex.Code}\"", SezzleeJson.Wire), ex.Message),
                isError: true);
        }
    }

    /// <returns><see langword="null"/> when the ranker failed and the host chose to refuse.</returns>
    private async Task<IReadOnlyList<CatalogEntry>?> RankedAsync(
        string query, int everything, IReadOnlyList<string>? tags, CancellationToken cancellationToken)
    {
        if (ranker is null || ToolIndex.IsListQuery(query))
        {
            return catalog.Search(query, everything, tags);
        }
        (ToolIndex index, RankCatalog rankCatalog, IReadOnlyDictionary<string, CatalogEntry> byName) =
            catalog.SearchSurface;
        SearchOptions search = options.Value.Search;
        RankerFailureReason reason;
        Exception? error = null;
        using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (search.RankerTimeout > TimeSpan.Zero)
        {
            deadline.CancelAfter(search.RankerTimeout);
        }
        try
        {
            IReadOnlyList<string>? answer = await ranker
                .RankAsync(new ToolRankRequest(query, rankCatalog), deadline.Token)
                .AsTask()
                .WaitAsync(deadline.Token);
            if (Ranking.Normalize(index, answer, tags) is { } normalized)
            {
                if (normalized.Unknown.Count > 0 || normalized.Duplicate.Count > 0)
                {
                    logger.LogWarning(
                        "search_tools: the search ranker named tools that were dropped (unknown: {Unknown}, repeated: {Duplicate}).",
                        normalized.Unknown, normalized.Duplicate);
                }
                return normalized.Names.Select(name => byName[name]).ToArray();
            }
            reason = RankerFailureReason.InvalidAnswer;
        }
        // Guard: the caller's own cancellation is not a ranker failure and propagates. Falling back
        // would spend a BM25 pass on an answer nobody reads, and an Error host would publish a
        // retryable refusal for a call that is never retried.
        catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            reason = RankerFailureReason.Timeout;
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            reason = RankerFailureReason.Threw;
            error = exception;
        }
        logger.LogWarning(error, "{Message}", Ranking.FailureMessage(reason, search.OnRankerFailure));
        return search.OnRankerFailure == RankerFailureMode.Error
            ? null
            : index.Search(query, everything, tags).Select(name => byName[name]).ToArray();
    }

    private async Task<DecisionContext> DecideAsync(CancellationToken cancellationToken)
    {
        HttpRequest? outer = httpContextAccessor.HttpContext?.Request;
        CallerScope scope = scopeResolver.Resolve(outer);
        CallerFacts facts = await visibility.FactsAsync(scope, outer, catalog.PolicyNames, cancellationToken);
        return new DecisionContext(entry => VisibilityCombiner.Evaluate(entry.Descriptor.Auth, facts), scope, outer);
    }

    private bool IsVisible(VisibilityDecision decision) => decision switch
    {
        VisibilityDecision.Allow => true,
        VisibilityDecision.Unknown => options.Value.Visibility.OnUnknown == UnknownVisibility.Show,
        _ => false,
    };

    private static bool? Uncertain(VisibilityDecision decision) =>
        decision == VisibilityDecision.Unknown ? true : null;

    private static object Card(CatalogEntry entry, VisibilityDecision decision) =>
        CardFor(entry.Tool, decision);

    internal static object CardFor(Spec.ToolDefinition tool, VisibilityDecision decision) => new
    {
        tool.Name,
        Description = Truncate(tool.Description),
        Parameters = Summarize(tool.InputSchema),
        Deprecated = tool.Deprecated == true ? true : (bool?)null,
        AuthUncertain = Uncertain(decision),
    };

    private static object Loaded(CatalogEntry entry, VisibilityDecision decision) =>
        DetailFor(entry.Tool, decision, ToolVersion.Of(entry.Tool));

    /// <summary>
    /// Projects a tool into its loaded shape: name, untruncated description, input schema, output schema
    /// when the endpoint declares a success body, and annotations. <c>load_tool</c> and
    /// <c>search_tools</c> under <c>detail: "schema"</c> both answer with this.
    /// </summary>
    /// <remarks>
    /// Guard: the members are named one by one instead of serializing the definition, because a policy
    /// name MUST NOT reach the agent (visibility.md invariant 3). detail/auth-is-never-emitted.json fails
    /// on either SDK that emits <c>auth</c>.
    /// </remarks>
    internal static object DetailFor(Spec.ToolDefinition tool, VisibilityDecision decision, string? version = null) => new
    {
        tool.Name,
        tool.Description,
        tool.InputSchema,
        tool.OutputSchema,
        tool.Annotations,
        Deprecated = tool.Deprecated == true ? true : (bool?)null,
        AuthUncertain = Uncertain(decision),
        Version = version,
    };

    private static string Truncate(string text)
    {
        if (text.Length <= CardDescriptionBudget)
        {
            return text;
        }
        int cut = text.LastIndexOf(' ', CardDescriptionBudget);
        return text[..(cut > CardDescriptionBudget / 2 ? cut : CardDescriptionBudget)] + "…";
    }

    private static string Summarize(JsonObject inputSchema)
    {
        HashSet<string> required = new(StringComparer.Ordinal);
        if (inputSchema["required"] is JsonArray names)
        {
            foreach (JsonNode? node in names)
            {
                if (node is JsonValue value && value.TryGetValue(out string? requiredName))
                {
                    required.Add(requiredName);
                }
            }
        }

        StringBuilder summary = new();
        if (inputSchema["properties"] is JsonObject properties)
        {
            foreach ((string name, JsonNode? schema) in Ordered(properties))
            {
                if (summary.Length > 0)
                {
                    summary.Append(", ");
                }
                string type = schema is JsonObject member
                    ? RequestBodyShape.TypeOf(member["type"]) ?? "any"
                    : "any";
                summary.Append(name).Append(": ").Append(type);
                if (required.Contains(name))
                {
                    summary.Append(" (required)");
                }
            }
        }
        return summary.ToString();
    }

    private static IEnumerable<KeyValuePair<string, JsonNode?>> Ordered(JsonObject properties)
    {
        List<KeyValuePair<string, JsonNode?>> numeric = [];
        List<KeyValuePair<string, JsonNode?>> rest = [];
        foreach (KeyValuePair<string, JsonNode?> property in properties)
        {
            if (IntegerLike(property.Key))
            {
                numeric.Add(property);
            }
            else
            {
                rest.Add(property);
            }
        }
        if (numeric.Count == 0)
        {
            return rest;
        }
        return numeric
            .OrderBy(p => uint.Parse(p.Key, CultureInfo.InvariantCulture))
            .Concat(rest);
    }

    private static bool IntegerLike(string key) =>
        key.Length > 0
        && (key.Length == 1 || key[0] != '0')
        && key.All(char.IsAsciiDigit)
        && uint.TryParse(key, CultureInfo.InvariantCulture, out _);

    /// <summary>
    /// The wire names the backend reports, mapped back to the names the agent knows.
    /// </summary>
    /// <remarks>
    /// Without it a rename leaks the wire vocabulary into the reported field name and points the
    /// agent at an argument it does not have.
    /// </remarks>
    private static FieldVocabulary VocabularyOf(CatalogEntry entry, RequestTemplate template)
    {
        Dictionary<string, string> aliases = new(StringComparer.Ordinal);
        HashSet<string> hidden = new(StringComparer.Ordinal);
        foreach (ParameterBinding parameter in template.Parameters)
        {
            if (parameter.Fill is not null)
            {
                hidden.Add(parameter.Name);
            }
            else if (parameter.Argument is { } agentName)
            {
                aliases[parameter.Name] = agentName;
            }
        }
        foreach ((string agentKey, string wireField) in template.BodyAliases)
        {
            aliases[wireField] = agentKey;
        }
        hidden.UnionWith(template.BodyFills.Keys);
        return new FieldVocabulary(KnownFields(entry), aliases, hidden);
    }

    private static IReadOnlySet<string> KnownFields(CatalogEntry entry)
    {
        HashSet<string> fields = new(StringComparer.Ordinal);
        if (entry.Tool.InputSchema["properties"] is JsonObject properties)
        {
            foreach ((string propertyName, _) in properties)
            {
                fields.Add(propertyName);
            }
        }
        return fields;
    }

    private static readonly IReadOnlyList<FieldError> SearchNarrowing =
    [
        new FieldError { Name = "query", Message = "Keywords that select fewer operations." },
        new FieldError { Name = "limit", Message = "Maximum number of results, 1-50." },
        new FieldError { Name = "detail", Message = "Use \"card\" for the compact shape." },
        new FieldError { Name = "tags", Message = "Tags every result must carry." },
    ];

    private static CallToolResult Wire(string json, bool isError) => new()
    {
        IsError = isError,
        Content = [new TextContentBlock { Text = json }],
    };

    /// <summary>
    /// The single place a meta-tool answer becomes a wire result, so none of them can reach the
    /// agent without passing the payload budget. <see cref="SezzleeBudgetTool"/> backs it up for any
    /// tool added to this type later. Pinned by ResponseBudgetTests.
    /// </summary>
    /// <param name="payload">The value to emit.</param>
    /// <param name="isError">Whether the answer is an error.</param>
    /// <param name="summaryOf">The value a refusal summarises; <paramref name="payload"/> when null.</param>
    /// <param name="narrowing">The arguments a refusal names as narrowing this call.</param>
    /// <param name="target">The endpoint a per-endpoint budget override sees.</param>
    private CallToolResult Respond(
        object payload,
        bool isError,
        object? summaryOf = null,
        IReadOnlyList<FieldError>? narrowing = null,
        InvokeTarget? target = null)
    {
        string json = JsonSerializer.Serialize(payload, SezzleeJson.Wire);
        int bytes = Encoding.UTF8.GetByteCount(json);
        int limit = BudgetFor(target);
        if (bytes <= limit)
        {
            return Wire(json, isError);
        }
        SdkError refusal = SdkErrors.RefuseOversize(new OversizeResponse(
            bytes,
            limit,
            SdkErrors.Describe(JsonSerializer.SerializeToNode(summaryOf ?? payload, SezzleeJson.Wire)),
            narrowing));
        return Wire(JsonSerializer.Serialize(refusal, SezzleeJson.Wire), isError: true);
    }

    private int BudgetFor(InvokeTarget? target)
    {
        InvokeOptions invoke = options.Value.Invoke;
        int? over = target is { } value ? invoke.MaxResponseBytesFor?.Invoke(value) : null;
        return over ?? invoke.MaxResponseBytes;
    }

    private TimeSpan TimeoutFor(InvokeTarget target)
    {
        InvokeOptions invoke = options.Value.Invoke;
        return invoke.TimeoutFor?.Invoke(target) ?? invoke.Timeout;
    }

    private CallToolResult ErrorResult(SdkErrorCode code, string message) =>
        Respond(SdkErrors.Create(code, message), isError: true);

    private CallToolResult UnknownTool(string name) =>
        ErrorResult(SdkErrorCode.UnknownTool, $"No operation named '{name}'. Use search_tools to find the exact name.");
}
