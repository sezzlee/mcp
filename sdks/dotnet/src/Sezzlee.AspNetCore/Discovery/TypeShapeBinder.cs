using System.Collections;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore.Discovery;

internal sealed class TypeShapeBinder
{
    private readonly record struct MapShape(Type Key, Type Value);

    private readonly TypeShapeBinderOptions options;
    private readonly Dictionary<string, ObjectType> types = new(StringComparer.Ordinal);
    private readonly Dictionary<Type, string> keys = [];
    private HashSet<Type> unfolding = [];

    private TypeShapeBinder(TypeShapeBinderOptions options) => this.options = options;

    public static TypeShape Bind(Type type, TypeShapeBinderOptions options)
    {
        TypeShapeBinder binder = new(options);
        TypeNode root = binder.Node(type, null);
        return new TypeShape { Root = root, Types = binder.types };
    }

    /// <summary>Binds a method's parameters as the members of one object, keyed by parameter name.</summary>
    public static TypeShape Bind(IReadOnlyList<ParameterInfo> parameters, TypeShapeBinderOptions options)
    {
        TypeShapeBinder binder = new(options);
        const string key = "(parameters)";
        binder.types[key] = new ObjectType { Name = "Parameters", Members = [] };
        List<Member> members = [];
        foreach (ParameterInfo parameter in parameters)
        {
            members.Add(new Member
            {
                Name = parameter.Name ?? $"arg{parameter.Position}",
                Type = binder.Node(parameter.ParameterType, null),
                Required = Annotation<RequiredAttribute>(null, parameter) is not null || IsRequired(parameter),
                ReadOnly = false,
                ConstructorBound = false,
                Description = DescriptionOf(null, parameter),
                Constraints = ConstraintsOf(null, parameter),
            });
        }
        binder.types[key] = new ObjectType { Name = "Parameters", Members = members };
        return new TypeShape { Root = new TypeNode { Kind = TypeKind.Ref, Ref = key }, Types = binder.types };
    }

    /// <remarks>
    /// A parameter is required unless its signature lets a caller leave it out: a default value,
    /// <see cref="Nullable{T}"/>, or a nullable annotation. Without annotations the signature says
    /// nothing, so the rule follows what callers of such code do (measured on a backend with 1436
    /// dynamic methods): an object or a collection is required, because 355 methods would otherwise
    /// publish their only DTO argument as optional and receive null; a string is optional, because
    /// 60 of the 67 unannotated strings were search filters the backend's own client sends as null.
    /// </remarks>
    private static bool IsRequired(ParameterInfo parameter)
    {
        if (parameter.HasDefaultValue || parameter.IsOptional)
        {
            return false;
        }
        if (parameter.ParameterType.IsValueType)
        {
            return Nullable.GetUnderlyingType(parameter.ParameterType) is null;
        }
        return new NullabilityInfoContext().Create(parameter).WriteState switch
        {
            NullabilityState.NotNull => true,
            NullabilityState.Nullable => false,
            _ => parameter.ParameterType != typeof(string),
        };
    }

    private TypeNode Node(Type type, PropertyInfo? owner)
    {
        Type resolved = Nullable.GetUnderlyingType(type) ?? type;

        if (owner is not null && options.PropertySchema?.Invoke(owner) is { } declared)
        {
            return new TypeNode { Kind = TypeKind.Verbatim, Schema = declared };
        }
        if (options.TypeSchema?.Invoke(resolved) is { } supplied)
        {
            return new TypeNode { Kind = TypeKind.Verbatim, Schema = supplied };
        }
        if (JsonPatchSchema.IsDocument(resolved))
        {
            return new TypeNode { Kind = TypeKind.Verbatim, Schema = JsonPatchSchema.Operations() };
        }
        if (Binary(resolved))
        {
            return new TypeNode { Kind = TypeKind.Binary };
        }
        if (Scalar(resolved) is { } scalar)
        {
            return scalar;
        }
        if (resolved.IsEnum)
        {
            return new TypeNode
            {
                Kind = TypeKind.Enum,
                EnumFacts = options.EnumShape is { } describe
                    ? describe(resolved)
                    : EnumWireFormat.Describe(resolved, JsonSerializerOptions.Default),
            };
        }
        if (MapDescriptor(resolved) is { } shape)
        {
            if (!unfolding.Add(resolved))
            {
                return SelfContaining(resolved);
            }
            try
            {
                return new TypeNode
                {
                    Kind = TypeKind.Map,
                    Keys = KeyOf(shape.Key),
                    Values = Node(shape.Value, null),
                };
            }
            finally
            {
                unfolding.Remove(resolved);
            }
        }
        if (ItemType(resolved) is { } item)
        {
            if ((item != typeof(object) && item.IsAssignableFrom(resolved)) || !unfolding.Add(resolved))
            {
                return SelfContaining(resolved);
            }
            try
            {
                return new TypeNode { Kind = TypeKind.Array, Items = Node(item, null) };
            }
            finally
            {
                unfolding.Remove(resolved);
            }
        }
        if (resolved == typeof(object))
        {
            return new TypeNode
            {
                Kind = TypeKind.Unknown,
                Reason = "'object' carries no readable shape; any JSON value is accepted.",
            };
        }
        return new TypeNode { Kind = TypeKind.Ref, Ref = Declare(resolved) };
    }

    /// <remarks>
    /// Guard: a collection or map whose items lead back to itself without passing through an
    /// object type (Newtonsoft's <c>JToken</c> enumerates <c>JToken</c>) has no finite shape, and
    /// unfolding it overflows the stack, which no catch can stop. An object type ends the chain
    /// because <see cref="Declare"/> registers its key before reading its members.
    /// </remarks>
    private static TypeNode SelfContaining(Type type) => new()
    {
        Kind = TypeKind.Unknown,
        Reason = $"'{type.Name}' contains its own kind, so its shape cannot be read; any JSON value is accepted. Set options.Schema.TypeSchema to publish one.",
    };

    private string Declare(Type type)
    {
        if (keys.TryGetValue(type, out string? existing))
        {
            return existing;
        }

        string key = type.FullName ?? type.Name;
        keys[type] = key;
        types[key] = new ObjectType { Name = SimpleName(type), Members = [] };

        HashSet<Type> outer = unfolding;
        unfolding = [];
        try
        {
            List<Member> members = [];
            ConstructorInfo? primary = PrimaryConstructor(type);
            foreach (PropertyInfo property in Declared(type))
            {
                ParameterInfo? parameter = Correlate(primary, property);
                members.Add(new Member
                {
                    Name = options.PropertyName(property),
                    Type = Node(property.PropertyType, property),
                    Required = IsRequired(property, parameter),
                    ReadOnly = !property.CanWrite,
                    ConstructorBound = parameter is not null,
                    Description = DescriptionOf(property, parameter),
                    Constraints = ConstraintsOf(property, parameter),
                });
            }
            types[key] = new ObjectType { Name = SimpleName(type), Members = members };
        }
        finally
        {
            unfolding = outer;
        }
        return key;
    }

    private string SimpleName(Type type)
    {
        if (options.TypeName?.Invoke(type) is { } declared && declared.Length > 0)
        {
            return declared;
        }
        string name = type.Name;
        int tick = name.IndexOf('`', StringComparison.Ordinal);
        return tick < 0 ? name : name[..tick];
    }

    private MapKey KeyOf(Type key)
    {
        Type resolved = Nullable.GetUnderlyingType(key) ?? key;

        if (resolved == typeof(string) || resolved == typeof(char) || resolved == typeof(object))
        {
            return new MapKey { Writable = true };
        }
        if (resolved.IsEnum)
        {
            return new MapKey { Writable = true, Scalar = ScalarKind.String };
        }
        if (Scalar(resolved) is not { } scalar)
        {
            options.Report?.Invoke(new CatalogDiagnostic(
                DiagnosticCodes.UnsupportedDictionaryKey,
                $"A map is keyed by '{resolved.Name}', which the serializer cannot write as a JSON property name; the value shape was dropped."));
            return new MapKey { Writable = false };
        }
        return new MapKey
        {
            Writable = true,
            Scalar = scalar.Scalar ?? ScalarKind.String,
            Format = scalar.Format,
        };
    }

    private static Constraints? ConstraintsOf(PropertyInfo? property, ParameterInfo? parameter)
    {
        int? minSize = null;
        int? maxSize = null;
        double? minimum = null;
        double? maximum = null;
        string? pattern = null;
        string? format = null;

        if (Annotation<StringLengthAttribute>(property, parameter) is { } bounded)
        {
            if (bounded.MinimumLength > 0)
            {
                minSize = bounded.MinimumLength;
            }
            maxSize = bounded.MaximumLength;
        }
        if (Annotation<MinLengthAttribute>(property, parameter) is { } shortest)
        {
            minSize = shortest.Length;
        }
        if (Annotation<MaxLengthAttribute>(property, parameter) is { } longest)
        {
            maxSize = longest.Length;
        }
        if (Annotation<RangeAttribute>(property, parameter) is { } range)
        {
            minimum = Numeric(range.Minimum);
            maximum = Numeric(range.Maximum);
        }
        if (Annotation<RegularExpressionAttribute>(property, parameter) is { } expression)
        {
            pattern = expression.Pattern;
        }
        if (Annotation<EmailAddressAttribute>(property, parameter) is not null)
        {
            format = "email";
        }
        else if (Annotation<UrlAttribute>(property, parameter) is not null)
        {
            format = "uri";
        }

        if (minSize is null && maxSize is null && minimum is null
            && maximum is null && pattern is null && format is null)
        {
            return null;
        }
        return new Constraints
        {
            MinSize = minSize,
            MaxSize = maxSize,
            Minimum = minimum,
            Maximum = maximum,
            Pattern = pattern,
            Format = format,
        };
    }

    private static string? DescriptionOf(PropertyInfo? property, ParameterInfo? parameter) =>
        Annotation<DescriptionAttribute>(property, parameter) is { } described
        && !string.IsNullOrWhiteSpace(described.Description)
            ? described.Description
            : null;

    private static ConstructorInfo? PrimaryConstructor(Type type)
    {
        ConstructorInfo[] constructors = type.GetConstructors(BindingFlags.Public | BindingFlags.Instance);
        if (constructors.Length == 1)
        {
            return constructors[0];
        }

        HashSet<string> names = new(
            type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Select(p => p.Name),
            StringComparer.OrdinalIgnoreCase);

        ConstructorInfo? best = null;
        int widest = 0;
        bool ambiguous = false;
        foreach (ConstructorInfo candidate in constructors)
        {
            ParameterInfo[] parameters = candidate.GetParameters();
            if (parameters.Length == 0
                || !parameters.All(p => p.Name is not null && names.Contains(p.Name)))
            {
                continue;
            }
            if (parameters.Length > widest)
            {
                best = candidate;
                widest = parameters.Length;
                ambiguous = false;
            }
            else if (parameters.Length == widest)
            {
                ambiguous = true;
            }
        }
        return ambiguous ? null : best;
    }

    private static ParameterInfo? Correlate(ConstructorInfo? primary, PropertyInfo property) =>
        primary?.GetParameters().FirstOrDefault(
            p => string.Equals(p.Name, property.Name, StringComparison.OrdinalIgnoreCase));

    private static T? Annotation<T>(PropertyInfo? property, ParameterInfo? parameter)
        where T : Attribute =>
        property?.GetCustomAttribute<T>() ?? parameter?.GetCustomAttribute<T>();

    private static bool IsRequired(PropertyInfo property, ParameterInfo? parameter) =>
        Annotation<RequiredAttribute>(property, parameter) is not null
        || property.GetCustomAttribute<RequiredMemberAttribute>() is not null;

    private static double? Numeric(object? bound)
    {
        try
        {
            return bound is null ? null : Convert.ToDouble(bound, CultureInfo.InvariantCulture);
        }
        catch (Exception ex) when (ex is FormatException or InvalidCastException or OverflowException)
        {
            return null;
        }
    }

    private static IEnumerable<PropertyInfo> Declared(Type type) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(property => property.GetIndexParameters().Length == 0 && property.CanRead)
            .OrderBy(InheritanceLevel)
            .ThenBy(property => property.MetadataToken);

    private static int InheritanceLevel(PropertyInfo property)
    {
        int level = 0;
        for (Type? declaring = property.DeclaringType?.BaseType;
            declaring is not null;
            declaring = declaring.BaseType)
        {
            level++;
        }
        return level;
    }

    private static bool Binary(Type type) =>
        type == typeof(byte[])
        || type == typeof(Memory<byte>)
        || type == typeof(ReadOnlyMemory<byte>);

    private static TypeNode? Scalar(Type type)
    {
        if (type == typeof(string) || type == typeof(char))
        {
            return Value(ScalarKind.String);
        }
        if (type == typeof(bool))
        {
            return Value(ScalarKind.Boolean);
        }
        if (type == typeof(byte) || type == typeof(sbyte) || type == typeof(short)
            || type == typeof(ushort) || type == typeof(int) || type == typeof(uint)
            || type == typeof(long) || type == typeof(ulong))
        {
            return Value(ScalarKind.Integer);
        }
        if (type == typeof(float) || type == typeof(double) || type == typeof(decimal))
        {
            return Value(ScalarKind.Number);
        }
        if (type == typeof(Guid))
        {
            return Value(ScalarKind.String, "uuid");
        }
        if (type == typeof(DateTime) || type == typeof(DateTimeOffset))
        {
            return Value(ScalarKind.String, "date-time");
        }
        if (type == typeof(DateOnly))
        {
            return Value(ScalarKind.String, "date");
        }
        if (type == typeof(TimeOnly) || type == typeof(TimeSpan) || type == typeof(Uri))
        {
            return Value(ScalarKind.String);
        }
        return null;
    }

    private static TypeNode Value(ScalarKind kind, string? format = null) =>
        new() { Kind = TypeKind.Scalar, Scalar = kind, Format = format };

    private static MapShape? MapDescriptor(Type type)
    {
        if (ClosedInterface(type, typeof(IDictionary<,>)) is { } writable)
        {
            Type[] arguments = writable.GetGenericArguments();
            return new MapShape(arguments[0], arguments[1]);
        }
        if (ClosedInterface(type, typeof(IReadOnlyDictionary<,>)) is { } readable)
        {
            Type[] arguments = readable.GetGenericArguments();
            return new MapShape(arguments[0], arguments[1]);
        }
        if (typeof(IDictionary).IsAssignableFrom(type))
        {
            return new MapShape(typeof(string), typeof(object));
        }
        return null;
    }

    private static Type? ClosedInterface(Type type, Type definition)
    {
        if (type.IsGenericType && type.GetGenericTypeDefinition() == definition)
        {
            return type;
        }
        foreach (Type contract in type.GetInterfaces())
        {
            if (contract.IsGenericType && contract.GetGenericTypeDefinition() == definition)
            {
                return contract;
            }
        }
        return null;
    }

    private static Type? ItemType(Type type)
    {
        if (type == typeof(string) || !typeof(IEnumerable).IsAssignableFrom(type))
        {
            return null;
        }
        if (type.IsArray)
        {
            return type.GetElementType();
        }
        foreach (Type contract in type.GetInterfaces().Append(type))
        {
            if (contract.IsGenericType && contract.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            {
                return contract.GetGenericArguments()[0];
            }
        }
        return typeof(object);
    }
}
