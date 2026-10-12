using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore.Discovery;

public interface IMcpSelectionMetadata
{
    bool Include { get; }
}

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public sealed class McpToolAttribute : Attribute, IMcpSelectionMetadata
{
    private bool? _readOnly;
    private bool? _destructive;
    private bool? _idempotent;

    public bool Include => true;

    public string? Name { get; set; }

    public string? Prefix { get; set; }

    /// <summary>
    /// Overrides the description the endpoint's own metadata carries.
    /// </summary>
    /// <remarks>
    /// <c>[Description]</c> covers a single tool, but it may be written once per method, so a
    /// method that declares variants cannot use it to give each one its own sentence.
    /// </remarks>
    public string? Description { get; set; }

    /// <summary>
    /// Replaces the grouping labels derived from the container, rather than adding to them.
    /// </summary>
    /// <remarks>
    /// A host that groups four controllers under one tag would otherwise carry four container
    /// names it never chose into the vocabulary agents browse. The type is <c>string[]</c> because
    /// an attribute argument must be a constant or an array creation expression, which rules out
    /// <c>IReadOnlyList&lt;string&gt;</c>; a collection expression is not one either, so the value
    /// is written <c>Tags = new[] { "billing" }</c>.
    /// </remarks>
    public string[]? Tags { get; set; }

    /// <summary>
    /// Search vocabulary the operation's own text does not contain: indexed like the description,
    /// never a filter key and never shown to the agent.
    /// </summary>
    /// <remarks>Written <c>SearchTerms = new[] { "sipariş" }</c>, for the reason given on <see cref="Tags"/>.</remarks>
    public string[]? SearchTerms { get; set; }

    /// <summary>
    /// The behaviour revision at the level the attribute sits on: a method's covers that operation,
    /// a controller's every operation in it. Raised when behaviour changes behind an unchanged
    /// schema, it changes the tool version and nothing the agent reads. The two levels never
    /// replace one another.
    /// </summary>
    /// <remarks><c>0</c> declares nothing, because an attribute property cannot be nullable.</remarks>
    public int Revision { get; set; }

    /// <summary>The body's media type, replacing the one discovery chooses.</summary>
    /// <remarks>It must be one the endpoint accepts; a declaration the backend would answer with 415 drops the endpoint.</remarks>
    public string? Consumes { get; set; }

    public bool ReadOnly
    {
        get => _readOnly ?? false;
        set => _readOnly = value;
    }

    public bool Destructive
    {
        get => _destructive ?? false;
        set => _destructive = value;
    }

    public bool Idempotent
    {
        get => _idempotent ?? false;
        set => _idempotent = value;
    }

    public ToolAnnotations Overrides => new()
    {
        ReadOnlyHint = _readOnly,
        DestructiveHint = _destructive,
        IdempotentHint = _idempotent,
    };
}

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public sealed class McpIgnoreAttribute : Attribute, IMcpSelectionMetadata
{
    public bool Include => false;
}

/// <summary>Declares one of several tools produced from a single operation.</summary>
/// <remarks>
/// The name and description are constructor parameters because that is the only way to make an
/// attribute property mandatory, and they are mandatory because one description cannot honestly
/// describe two tools whose arguments are hidden differently. <see cref="McpToolAttribute"/> keeps
/// <c>AllowMultiple = false</c>: it is the selection marker, and multiplying it would reintroduce
/// the ambiguous-selection state the spec forbids.
/// </remarks>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = true, Inherited = true)]
public sealed class McpToolVariantAttribute(string name, string description) : Attribute
{
    public string Name { get; } = name;

    public string Description { get; } = description;
}

/// <summary>
/// Declares that the operation dispatches on one parameter: each of its variants is a member that
/// writes its own key there, and the operation itself is never published.
/// </summary>
/// <remarks>
/// With <see cref="Source"/> the members come from the source registered under that name with
/// <c>options.Families.Provide</c>; without it they are the action's
/// <see cref="McpToolVariantAttribute"/>s alone. Like a variant, it does not select the operation:
/// <see cref="McpToolAttribute"/> still does.
/// </remarks>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public sealed class McpToolFamilyAttribute(string parameter) : Attribute
{
    public string Parameter { get; } = parameter;

    public string? Source { get; set; }
}

/// <summary>Curates one argument: renames it, re-describes it, or hides it with a value.</summary>
/// <remarks>
/// Attribute arguments must be compile-time constants, so an object or array constant cannot be
/// one. <see cref="ValueJson"/> is the answer: a string is a constant, and it is parsed once at
/// catalog build. Setting any of the three value properties without <see cref="Hidden"/> is a
/// build error — a filled but visible argument is a default, which is a different feature.
/// </remarks>
[AttributeUsage(
    AttributeTargets.Method | AttributeTargets.Parameter | AttributeTargets.Property,
    AllowMultiple = true, Inherited = true)]
public sealed class McpArgumentAttribute : Attribute
{
    public McpArgumentAttribute(string argument)
    {
        Argument = argument;
    }

    public McpArgumentAttribute()
    {
    }

    /// <summary>The wire name. Null on a parameter or property, where the member names it.</summary>
    public string? Argument { get; }

    public string? Name { get; set; }

    public string? Description { get; set; }

    public bool Hidden { get; set; }

    /// <summary>A compile-time constant scalar.</summary>
    public object? Value { get; set; }

    /// <summary>A JSON object or array constant, as text.</summary>
    public string? ValueJson { get; set; }

    /// <summary>The name of a registered value provider.</summary>
    public string? ValueFrom { get; set; }

    /// <summary>Restricts this rule to one variant; null applies it to every variant.</summary>
    public string? Variant { get; set; }
}
