using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.AspNetCore.NewtonsoftJson;

public static class SezzleeNewtonsoftJsonExtensions
{
    /// <summary>
    /// Reads property names and enum wire forms from the host's <see cref="MvcNewtonsoftJsonOptions"/>.
    /// A <c>Schema.PropertyName</c> or <c>Schema.EnumShape</c> the host sets itself is kept.
    /// </summary>
    public static IServiceCollection AddSezzleeNewtonsoftJson(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.TryAddEnumerable(
            ServiceDescriptor.Singleton<IPostConfigureOptions<SezzleeOptions>, NewtonsoftSchemaSetup>());
        return services;
    }
}

internal sealed class NewtonsoftSchemaSetup(IOptions<MvcNewtonsoftJsonOptions> mvc) : IPostConfigureOptions<SezzleeOptions>
{
    public void PostConfigure(string? name, SezzleeOptions options)
    {
        JsonSerializerSettings settings = mvc.Value.SerializerSettings;
        options.Schema.PropertyName ??= property => NewtonsoftWireFormat.PropertyName(property, settings);
        options.Schema.EnumShape ??= enumType => NewtonsoftWireFormat.Enum(enumType, settings);
        Func<Type, JsonObject?>? declared = options.Schema.TypeSchema;
        options.Schema.TypeSchema = type => declared?.Invoke(type) ?? NewtonsoftWireFormat.Token(type);
    }
}

internal static class NewtonsoftWireFormat
{
    public static string PropertyName(PropertyInfo property, JsonSerializerSettings settings)
    {
        IContractResolver resolver = settings.ContractResolver ?? new DefaultContractResolver();
        Type owner = property.ReflectedType ?? property.DeclaringType ?? typeof(object);
        return resolver.ResolveContract(owner) is JsonObjectContract contract
            && contract.Properties.FirstOrDefault(p => p.UnderlyingName == property.Name) is { PropertyName: { } name }
                ? name
                : property.Name;
    }

    /// <summary>The schema of a LINQ to JSON type, which binds whatever JSON of its kind arrives.</summary>
    public static JsonObject? Token(Type type)
    {
        if (typeof(JObject).IsAssignableFrom(type))
        {
            return new JsonObject { ["type"] = "object" };
        }
        if (typeof(JArray).IsAssignableFrom(type))
        {
            return new JsonObject { ["type"] = "array" };
        }
        return typeof(JToken).IsAssignableFrom(type) ? [] : null;
    }

    public static EnumFacts Enum(Type enumType, JsonSerializerSettings settings)
    {
        JsonSerializer serializer = JsonSerializer.Create(settings);
        List<string> names = [];
        List<int> numbers = [];
        bool strings = true;
        foreach (object value in System.Enum.GetValues(enumType))
        {
            int number = Convert.ToInt32(value, System.Globalization.CultureInfo.InvariantCulture);
            JToken token = JToken.FromObject(value, serializer);
            if (token.Type == JTokenType.String)
            {
                names.Add(token.Value<string>() ?? value.ToString() ?? string.Empty);
            }
            else
            {
                strings = false;
                names.Add(value.ToString() ?? string.Empty);
            }
            numbers.Add(token.Type == JTokenType.Integer ? token.Value<int>() : number);
        }
        return new EnumFacts
        {
            WireForm = strings ? EnumWireForm.String : EnumWireForm.Integer,
            Combinable = enumType.GetCustomAttribute<FlagsAttribute>() is not null,
            Names = names,
            Numbers = numbers,
        };
    }
}
