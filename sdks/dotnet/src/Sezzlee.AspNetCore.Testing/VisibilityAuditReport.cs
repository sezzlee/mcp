using System.Collections.Frozen;

namespace Sezzlee.AspNetCore.Testing;

public sealed class VisibilityAuditReport
{
    private static readonly VisibilityAuditKind[] FailingKinds =
    [
        VisibilityAuditKind.ListedButDenied,
        VisibilityAuditKind.HiddenButAllowed,
        VisibilityAuditKind.NotComparable,
    ];

    private static string Meaning(VisibilityAuditKind kind) => kind switch
    {
        VisibilityAuditKind.ListedButDenied =>
            "listed by search_tools and load_tool, but the real pipeline answers 401 or 403",
        VisibilityAuditKind.HiddenButAllowed =>
            "hidden by search_tools and load_tool, but the real pipeline lets the caller through",
        VisibilityAuditKind.NotComparable =>
            "the probe could not judge the tool, so nothing was compared",
        _ => "skipped by the Exclude option",
    };

    internal VisibilityAuditReport(int callers, int tools, int consistent, IReadOnlyList<VisibilityAuditFinding> findings)
    {
        Callers = callers;
        Tools = tools;
        Consistent = consistent;
        Findings = findings;
        Counts = Enum.GetValues<VisibilityAuditKind>().ToFrozenDictionary(
            kind => kind, kind => findings.Count(finding => finding.Kind == kind));
    }

    /// <summary>How many callers were audited.</summary>
    public int Callers { get; }

    /// <summary>How many catalog tools each caller was audited against.</summary>
    public int Tools { get; }

    /// <summary>The caller and tool pairs whose listing and probe agreed.</summary>
    public int Consistent { get; }

    /// <summary>Every pair that did not end consistent, in caller then catalog order.</summary>
    public IReadOnlyList<VisibilityAuditFinding> Findings { get; }

    /// <summary>The number of findings of each kind; every kind is present.</summary>
    public IReadOnlyDictionary<VisibilityAuditKind, int> Counts { get; }

    /// <summary>Every caller and tool pair: <see cref="Compared"/> plus not comparable plus excluded.</summary>
    public int Total => Callers * Tools;

    /// <summary>The pairs where both sides gave an answer: the consistent ones and the two divergences.</summary>
    public int Compared =>
        Consistent + Counts[VisibilityAuditKind.ListedButDenied] + Counts[VisibilityAuditKind.HiddenButAllowed];

    /// <summary>
    /// Throws when any pair diverged or could not be compared. A pair the probe could not judge fails
    /// too, because a green audit that compared nothing would be false confidence; declare a value in
    /// <c>Visibility.ProbeValues</c> for a route the probe could not reach, or exclude the tool.
    /// </summary>
    /// <exception cref="VisibilityAuditException">At least one pair is not consistent.</exception>
    public void EnsureConsistent()
    {
        VisibilityAuditKind[] failing = [.. FailingKinds.Where(kind => Counts[kind] > 0)];
        if (failing.Length == 0)
        {
            return;
        }

        int excluded = Counts[VisibilityAuditKind.Excluded];
        List<string> lines =
        [
            $"Visibility audit: {Total - excluded - Consistent} of {Total} caller and tool pairs are not consistent ({Callers} callers, {Tools} tools, {excluded} excluded).",
        ];
        foreach (VisibilityAuditKind kind in failing)
        {
            lines.Add(string.Empty);
            lines.Add($"{kind} ({Counts[kind]}): {Meaning(kind)}");
            foreach (VisibilityAuditFinding finding in Findings.Where(finding => finding.Kind == kind))
            {
                lines.Add(finding.Reason is null
                    ? $"  {finding.Caller}: {finding.Tool}"
                    : $"  {finding.Caller}: {finding.Tool} - {finding.Reason}");
            }
        }
        throw new VisibilityAuditException(string.Join('\n', lines), this);
    }
}
