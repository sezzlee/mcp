using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Sezzlee.AspNetCore.Requests;

/// <summary>
/// Serializes a <see cref="JsonElement"/> exactly as JavaScript's <c>JSON.stringify</c> does: no
/// whitespace, object members in source order, only <c>"</c>, <c>\</c> and control characters
/// escaped, non-ASCII written raw, and numbers in the SDK's canonical shortest form. A
/// content-serialized parameter's bytes are percent-encoded afterward, so every byte written here
/// must match the peer SDK's.
/// </summary>
internal static class CanonicalJson
{
    /// <param name="sortMembers">Writes every object's members in ordinal order instead of source
    /// order, so two spellings of one value render identically.</param>
    public static string Stringify(JsonElement value, bool sortMembers = false)
    {
        StringBuilder builder = new();
        Write(builder, value, sortMembers);
        return builder.ToString();
    }

    private static void Write(StringBuilder builder, JsonElement value, bool sortMembers)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                builder.Append('{');
                bool firstMember = true;
                IEnumerable<JsonProperty> members = sortMembers
                    ? value.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal)
                    : value.EnumerateObject();
                foreach (JsonProperty property in members)
                {
                    if (!firstMember)
                    {
                        builder.Append(',');
                    }
                    firstMember = false;
                    WriteString(builder, property.Name);
                    builder.Append(':');
                    Write(builder, property.Value, sortMembers);
                }
                builder.Append('}');
                break;
            case JsonValueKind.Array:
                builder.Append('[');
                bool firstItem = true;
                foreach (JsonElement item in value.EnumerateArray())
                {
                    if (!firstItem)
                    {
                        builder.Append(',');
                    }
                    firstItem = false;
                    Write(builder, item, sortMembers);
                }
                builder.Append(']');
                break;
            case JsonValueKind.String:
                WriteString(builder, value.GetString()!);
                break;
            case JsonValueKind.Number:
                builder.Append(value.GetDouble().ToString(CultureInfo.InvariantCulture));
                break;
            case JsonValueKind.True:
                builder.Append("true");
                break;
            case JsonValueKind.False:
                builder.Append("false");
                break;
            default:
                builder.Append("null");
                break;
        }
    }

    private static void WriteString(StringBuilder builder, string value)
    {
        builder.Append('"');
        foreach (char c in value)
        {
            switch (c)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                default:
                    if (c < ' ')
                    {
                        builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(c);
                    }
                    break;
            }
        }
        builder.Append('"');
    }
}
