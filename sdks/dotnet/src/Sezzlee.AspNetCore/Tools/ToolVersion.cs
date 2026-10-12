using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Sezzlee.AspNetCore.Requests;
using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.AspNetCore.Tools;

/// <summary>
/// Derives the version an agent pins an <c>invoke_tool</c> call to: a digest of the tool's loaded
/// shape and its declared revision.
/// </summary>
/// <remarks>
/// Guard: the shape is projected with an <see cref="VisibilityDecision.Allow"/> decision, so
/// <c>authUncertain</c> never enters the digest. It describes one caller's decision, and hashing it
/// would hand two callers two versions of one tool. A tool without a revision digests the loaded
/// shape alone, so its version is the one an older replica derives for it.
/// </remarks>
internal static class ToolVersion
{
    public static string Of(Spec.ToolDefinition tool)
    {
        JsonObject subject = JsonSerializer.SerializeToNode(
            SezzleeMetaTools.DetailFor(tool, VisibilityDecision.Allow), SezzleeJson.Wire)!.AsObject();
        if (tool.Revision is not null)
        {
            subject["revision"] = JsonSerializer.SerializeToNode(tool.Revision, SezzleeJson.Wire);
        }
        JsonElement shape = JsonSerializer.SerializeToElement(subject, SezzleeJson.Wire);
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(CanonicalJson.Stringify(shape, sortMembers: true)));
        return Convert.ToHexString(digest, 0, 8).ToLowerInvariant();
    }
}
