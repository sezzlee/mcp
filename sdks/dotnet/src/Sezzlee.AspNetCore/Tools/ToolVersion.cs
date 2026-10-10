using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Sezzlee.AspNetCore.Requests;
using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.AspNetCore.Tools;

/// <summary>
/// Derives the version an agent pins an <c>invoke_tool</c> call to: a digest of the tool's loaded shape.
/// </summary>
/// <remarks>
/// Guard: the shape is projected with an <see cref="VisibilityDecision.Allow"/> decision, so
/// <c>authUncertain</c> never enters the digest. It describes one caller's decision, and hashing it
/// would hand two callers two versions of one tool.
/// </remarks>
internal static class ToolVersion
{
    public static string Of(Spec.ToolDefinition tool)
    {
        JsonElement shape = JsonSerializer.SerializeToElement(
            SezzleeMetaTools.DetailFor(tool, VisibilityDecision.Allow), SezzleeJson.Wire);
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(CanonicalJson.Stringify(shape, sortMembers: true)));
        return Convert.ToHexString(digest, 0, 8).ToLowerInvariant();
    }
}
