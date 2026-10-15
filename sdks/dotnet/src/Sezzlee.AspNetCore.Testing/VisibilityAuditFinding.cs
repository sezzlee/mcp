namespace Sezzlee.AspNetCore.Testing;

/// <summary>One caller and tool pair that did not end consistent.</summary>
/// <param name="Caller">The <see cref="AuditCaller.Name"/>.</param>
/// <param name="Tool">The published tool name.</param>
/// <param name="Kind">What went wrong.</param>
/// <param name="Reason">Why the probe could not judge the pair; set only for <see cref="VisibilityAuditKind.NotComparable"/>.</param>
public sealed record VisibilityAuditFinding(string Caller, string Tool, VisibilityAuditKind Kind, string? Reason = null);
