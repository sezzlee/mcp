namespace Sezzlee.AspNetCore.Testing;

public enum VisibilityAuditKind
{
    /// <summary>Listed by search_tools and load_tool, but the real pipeline answers 401 or 403.</summary>
    ListedButDenied,

    /// <summary>Hidden by search_tools and load_tool, but the real pipeline lets the caller through.</summary>
    HiddenButAllowed,

    /// <summary>The probe could not judge the tool, so nothing was compared.</summary>
    NotComparable,

    /// <summary>Skipped by <see cref="VisibilityAuditOptions.Exclude"/>.</summary>
    Excluded,
}
