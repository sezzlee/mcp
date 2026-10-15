namespace Sezzlee.AspNetCore.Discovery;

public enum SelectionDefault { Exclude, Include }

internal enum SelectionMarker { Include, Exclude, Both }

/// <summary>A config-level selection rule, for routes the host cannot or will not decorate.</summary>
/// <remarks>
/// <c>*</c> matches within one segment and <c>**</c> across them, so <c>**</c> is the catch-all.
/// Order carries no meaning; equally specific rules that disagree are a build error.
/// </remarks>
public sealed record SelectionRule(
    SelectionDefault Decision,
    string? Route = null,
    string? Method = null);

internal static class SelectionResolver
{
    public static bool IsSelected(
        SelectionDefault defaultDecision,
        SelectionMarker? container,
        SelectionMarker? operation,
        string? describedAs = null,
        SelectionMarker? rule = null,
        SelectionMarker? provided = null)
    {
        Reject(container, "container", describedAs);
        Reject(operation, "operation", describedAs);

        if (operation is not null)
        {
            return operation == SelectionMarker.Include;
        }
        if (container is not null)
        {
            return container == SelectionMarker.Include;
        }
        if (provided is not null)
        {
            return provided == SelectionMarker.Include;
        }
        if (rule is not null)
        {
            return rule == SelectionMarker.Include;
        }
        return defaultDecision == SelectionDefault.Include;
    }

    public static SelectionMarker? ResolveRules(
        IReadOnlyList<SelectionRule>? rules,
        string route,
        string method,
        string? describedAs = null)
    {
        List<SelectionRule> matching = [.. (rules ?? []).Where(r => Matches(r, route, method))];
        if (matching.Count == 0)
        {
            return null;
        }
        int sharpest = matching.Max(SpecificityOf);
        HashSet<SelectionDefault> decisions =
            [.. matching.Where(r => SpecificityOf(r) == sharpest).Select(r => r.Decision)];

        // Guard: repetition is not a conflict, contradiction is. Rules that decide the same way
        // may overlap freely, which is what lets independent rules cover one endpoint; only
        // disagreement at equal specificity would need a silent winner, so it fails instead.
        if (decisions.Count > 1)
        {
            string target = describedAs is null ? string.Empty : $" on {describedAs}";
            throw new SezzleeCatalogException(
                SezzleeCatalogException.AmbiguousSelection,
                $"Two selection rules of equal specificity disagree{target}; narrow one of their targets.");
        }
        return decisions.Single() == SelectionDefault.Include
            ? SelectionMarker.Include
            : SelectionMarker.Exclude;
    }

    private static int SpecificityOf(SelectionRule rule) =>
        (rule.Route is null ? 0 : 1) + (rule.Method is null ? 0 : 1);

    private static bool Matches(SelectionRule rule, string route, string method)
    {
        if (rule.Route is not null && !RouteGlob.Matches(rule.Route, route))
        {
            return false;
        }
        return rule.Method is null
            || string.Equals(rule.Method, method, StringComparison.OrdinalIgnoreCase);
    }

    public static SelectionMarker MarkerOf(SelectionDefault decision) =>
        decision == SelectionDefault.Include ? SelectionMarker.Include : SelectionMarker.Exclude;

    public static SelectionMarker? Combine(bool include, bool exclude) => (include, exclude) switch
    {
        (true, true) => SelectionMarker.Both,
        (true, false) => SelectionMarker.Include,
        (false, true) => SelectionMarker.Exclude,
        (false, false) => null,
    };

    private static void Reject(SelectionMarker? marker, string level, string? describedAs)
    {
        if (marker != SelectionMarker.Both)
        {
            return;
        }
        string target = describedAs is null ? string.Empty : $" on {describedAs}";
        throw new SezzleeCatalogException(
            SezzleeCatalogException.AmbiguousSelection,
            $"Both include and exclude markers are present at the {level} level{target}; remove one of them.");
    }
}
