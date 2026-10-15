using Microsoft.Extensions.DependencyInjection;
using Sezzlee.AspNetCore.Naming;

namespace Sezzlee.AspNetCore.Discovery;

/// <summary>
/// One decision a host keeps in data: whether the endpoint at <paramref name="Method"/> and
/// <paramref name="Route"/> is exposed, and optionally how it is presented.
/// </summary>
/// <param name="Method">The HTTP method; compared case-insensitively.</param>
/// <param name="Route">The normalized route template, compared exactly; it is not a glob.</param>
/// <param name="Decision">Whether the endpoint is exposed.</param>
public sealed record McpSelectionEntry(string Method, string Route, SelectionDefault Decision)
{
    /// <summary>The tool name; sits below <c>[McpTool(Name)]</c> and above the derived name.</summary>
    public string? Name { get; init; }

    /// <summary>The description; sits below <c>[McpTool(Description)]</c> and above <see cref="SezzleeOptions.Description"/>.</summary>
    public string? Description { get; init; }

    /// <summary>Grouping labels; sit below <c>[McpTool(Tags)]</c> and above <see cref="SezzleeOptions.EndpointTags"/>.</summary>
    public IReadOnlyList<string>? Tags { get; init; }

    /// <summary>Search vocabulary; sits below <c>[McpTool(SearchTerms)]</c> and above <see cref="SezzleeOptions.EndpointSearchTerms"/>.</summary>
    public IReadOnlyList<string>? SearchTerms { get; init; }

    /// <remarks>
    /// Guard: written by hand because the synthesized comparison would compare <see cref="Tags"/> and
    /// <see cref="SearchTerms"/> by reference. A source that builds new lists on every load would then
    /// look changed on every refresh, rebuild the catalog and signal a tool-list change to every
    /// connected client each time.
    /// </remarks>
    public bool Equals(McpSelectionEntry? other) =>
        other is not null
        && string.Equals(Method, other.Method, StringComparison.Ordinal)
        && string.Equals(Route, other.Route, StringComparison.Ordinal)
        && Decision == other.Decision
        && string.Equals(Name, other.Name, StringComparison.Ordinal)
        && string.Equals(Description, other.Description, StringComparison.Ordinal)
        && SameList(Tags, other.Tags)
        && SameList(SearchTerms, other.SearchTerms);

    public override int GetHashCode() => HashCode.Combine(Method, Route, Decision);

    private static bool SameList(IReadOnlyList<string>? left, IReadOnlyList<string>? right) =>
        left is null || right is null
            ? left is null && right is null
            : left.SequenceEqual(right, StringComparer.Ordinal);
}

/// <summary>Returns the selection rows. It runs in its own service scope, outside any request.</summary>
public delegate ValueTask<IReadOnlyList<McpSelectionEntry>> McpSelectionSource(
    IServiceProvider services, CancellationToken cancellationToken);

/// <summary>How the selection source is loaded; the values and their validation are those of <see cref="ToolFamilyOptions"/>.</summary>
public sealed class SelectionSourceOptions : SourceLoadOptions;

internal abstract record SelectionSourceState
{
    internal sealed record Rows(IReadOnlyList<McpSelectionEntry> Entries) : SelectionSourceState;

    internal sealed record Withheld(string Reason) : SelectionSourceState;
}

internal static class SelectionReader
{
    public static async Task<SelectionLoad?> LoadAsync(
        SelectionOptions options,
        IServiceScopeFactory? scopes,
        SelectionLoad? previous,
        CancellationToken cancellationToken)
    {
        if (options.Provider is not { } source)
        {
            return null;
        }
        return await SourceReader.LoadAsync<IReadOnlyList<McpSelectionEntry>>(
            async (services, token) => await source(services, token) ?? [],
            scopes,
            options.Source.LoadTimeout,
            $"timeout: the selection source did not return within Selection.Source.LoadTimeout ({options.Source.LoadTimeout}); raise options.Selection.Source.LoadTimeout or set options.Selection.Source.LoadMode to Background",
            previous,
            cancellationToken);
    }

    public static SelectionSourceState StateOf(SelectionLoad? load) => load switch
    {
        SelectionLoad.Loaded loaded => new SelectionSourceState.Rows(loaded.Value),
        SelectionLoad.Stale stale => new SelectionSourceState.Rows(stale.Value),
        SelectionLoad.Failed failed => new SelectionSourceState.Withheld(
            $"the selection source failed and has never returned rows ({failed.Error.Message})"),
        null => new SelectionSourceState.Withheld("the selection source has not returned yet"),
        _ => throw new InvalidOperationException($"Unhandled selection load {load.GetType().Name}."),
    };

    public static bool Changed(SelectionLoad? before, SelectionLoad? after)
    {
        IReadOnlyList<McpSelectionEntry>? previous = before?.Published;
        IReadOnlyList<McpSelectionEntry>? current = after?.Published;
        if (previous is null || current is null)
        {
            return previous != current;
        }
        return previous.Count != current.Count || !new HashSet<McpSelectionEntry>(previous).SetEquals(current);
    }
}

/// <summary>The rows of a loaded source, checked and indexed by the endpoint each one names.</summary>
internal sealed class ProvidedSelection
{
    private readonly Dictionary<string, McpSelectionEntry> _byTarget;

    private ProvidedSelection(Dictionary<string, McpSelectionEntry> byTarget) => _byTarget = byTarget;

    public static string TargetOf(string method, string route) => $"{method.ToUpperInvariant()} {route}";

    /// <remarks>
    /// A defect in one row is that row's alone, reported and left out: the rows are host data, and one
    /// bad one should not take every other decision offline. A row without a usable target or decision
    /// is rejected whole; an invalid override loses only itself and the decision stays. Rows for one
    /// target that disagree exclude that endpoint, because the source cannot say which row is meant and
    /// the source may be the only thing excluding it.
    /// </remarks>
    public static ProvidedSelection Index(IReadOnlyList<McpSelectionEntry> entries, List<CatalogDiagnostic> diagnostics)
    {
        Dictionary<string, List<McpSelectionEntry>> groups = new(StringComparer.Ordinal);
        for (int position = 0; position < entries.Count; position += 1)
        {
            McpSelectionEntry? entry = entries[position];
            string? problem = entry is null
                ? "the row is null"
                : string.IsNullOrWhiteSpace(entry.Method)
                    ? "its method is blank"
                    : string.IsNullOrWhiteSpace(entry.Route)
                        ? "its route is blank"
                        : !Enum.IsDefined(entry.Decision)
                            ? "its decision is neither Include nor Exclude"
                            : null;
            if (problem is not null || entry is null)
            {
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.SelectionEntryRejected,
                    $"selection source row {position} is rejected: {problem}."));
                continue;
            }
            McpSelectionEntry normalized = entry with { Method = entry.Method.Trim().ToUpperInvariant() };
            string target = TargetOf(normalized.Method, normalized.Route);
            if (!groups.TryGetValue(target, out List<McpSelectionEntry>? group))
            {
                groups[target] = group = [];
            }
            group.Add(normalized);
        }

        Dictionary<string, McpSelectionEntry> byTarget = new(StringComparer.Ordinal);
        foreach ((string target, List<McpSelectionEntry> rows) in groups)
        {
            if (rows.Any(row => !row.Equals(rows[0])))
            {
                diagnostics.Add(new CatalogDiagnostic(
                    DiagnosticCodes.SelectionEntryConflict,
                    $"selection source has {rows.Count} rows for {target} that disagree; the endpoint is excluded."));
                byTarget[target] = new McpSelectionEntry(rows[0].Method, rows[0].Route, SelectionDefault.Exclude);
                continue;
            }
            byTarget[target] = WithValidOverrides(rows[0], target, diagnostics);
        }
        return new ProvidedSelection(byTarget);
    }

    private static McpSelectionEntry WithValidOverrides(
        McpSelectionEntry row, string target, List<CatalogDiagnostic> diagnostics)
    {
        McpSelectionEntry kept = row;
        if (row.Name is { } name && !ToolNameFactory.IsValidName(name))
        {
            kept = kept with { Name = null };
            Lost("its name '" + name + "' does not match the tool-name pattern", target, diagnostics);
        }
        if (row.Description is { } description && string.IsNullOrWhiteSpace(description))
        {
            kept = kept with { Description = null };
            Lost("its description is blank", target, diagnostics);
        }
        if (row.Tags is { } tags && tags.Any(tag => tag is null))
        {
            kept = kept with { Tags = null };
            Lost("its tags contain a null entry", target, diagnostics);
        }
        if (row.SearchTerms is { } terms && terms.Any(term => term is null))
        {
            kept = kept with { SearchTerms = null };
            Lost("its search terms contain a null entry", target, diagnostics);
        }
        return kept;
    }

    private static void Lost(string reason, string target, List<CatalogDiagnostic> diagnostics) =>
        diagnostics.Add(new CatalogDiagnostic(
            DiagnosticCodes.SelectionEntryRejected,
            $"selection source row {target} loses an override and keeps its decision: {reason}."));

    public McpSelectionEntry? Find(string method, string route) =>
        _byTarget.GetValueOrDefault(TargetOf(method, route));

    public IEnumerable<string> Unmatched(IReadOnlySet<string> discovered) =>
        _byTarget.Keys.Where(target => !discovered.Contains(target));
}
