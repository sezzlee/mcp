using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.AspNetCore.Testing;

public sealed class VisibilityAuditOptions
{
    /// <summary>
    /// Tools the audit skips, reported as <see cref="VisibilityAuditKind.Excluded"/> and never silently
    /// dropped. Use it for a tool whose access a handler decides, which the probe cannot see.
    /// </summary>
    public Func<McpToolInfo, bool>? Exclude { get; set; }

    /// <summary>How many probe requests run at once; a positive number.</summary>
    public int Concurrency { get; set; } = 4;
}
