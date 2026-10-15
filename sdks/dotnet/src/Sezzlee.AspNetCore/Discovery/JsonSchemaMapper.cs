using System.Reflection;
using System.Text.Json.Nodes;

namespace Sezzlee.AspNetCore.Discovery;

internal static class JsonSchemaMapper
{
    public static JsonObject Map(Type type, Func<PropertyInfo, string>? propertyName = null) =>
        Map(type, new SchemaMapperOptions
        {
            PropertyName = propertyName ?? (property => property.Name),
        });

    public static JsonObject Map(Type type, SchemaMapperOptions options) =>
        new SchemaWriter(options.Writer()).Write(TypeShapeBinder.Bind(type, options.Binder()));

    public static JsonObject Map(
        IReadOnlyList<ParameterInfo> parameters,
        SchemaMapperOptions options,
        IReadOnlyDictionary<string, string>? descriptions = null) =>
        new SchemaWriter(options.Writer()).Write(TypeShapeBinder.Bind(parameters, options.Binder(), descriptions));
}
