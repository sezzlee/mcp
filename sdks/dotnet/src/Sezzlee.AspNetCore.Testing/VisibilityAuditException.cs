namespace Sezzlee.AspNetCore.Testing;

/// <summary>Thrown by <see cref="VisibilityAuditReport.EnsureConsistent"/>; carries the report it judged.</summary>
public sealed class VisibilityAuditException(string message, VisibilityAuditReport report) : Exception(message)
{
    public VisibilityAuditReport Report { get; } = report;
}
