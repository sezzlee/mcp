# Sezzlee.AspNetCore.NewtonsoftJson

> Status: `0.2.2`, alpha. Versioned with `Sezzlee.AspNetCore`; use the same version of both.

For a backend that binds JSON with `AddNewtonsoftJson()`. `Sezzlee.AspNetCore` cannot read Newtonsoft's settings on its own, so it publishes CLR property names and accepts both the name and the number of every enum, and reports `naming_policy_unresolved` and `enum_format_unresolved`. This package reads the settings the backend binds with instead:

```csharp
builder.Services.AddControllers().AddNewtonsoftJson();
builder.Services.AddSezzlee(options => { /* ... */ });
builder.Services.AddSezzleeNewtonsoftJson();
```

- Property names come from `SerializerSettings.ContractResolver`, so a naming strategy and `[JsonProperty("...")]` both reach the published schema.
- Enum forms come from serializing each value with `SerializerSettings`: a `StringEnumConverter` in `Converters` or on the enum type publishes names, otherwise numbers.
- `JObject` is published as an object, `JArray` as an array and any other `JToken` as any JSON value.
- A `Schema.PropertyName`, `Schema.EnumShape` or `Schema.TypeSchema` set in `AddSezzlee` is kept;
  a `TypeSchema` that answers null for a token type falls through to the rule above.

A `[JsonConverter]` on a single property is not read.

It depends on `Microsoft.AspNetCore.Mvc.NewtonsoftJson` 8.0.0 or later on .NET 8 and 10.0.0 or later on .NET 10, so the patch the host already references is kept.
