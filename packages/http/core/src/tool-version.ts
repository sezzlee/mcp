import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { createDetail, type ToolDetail } from "./card.js";
import type { ToolDefinition } from "./generated/tool-definition.js";
import type { VisibilityDecision } from "./visibility.js";

export type ToolVersion = string & { readonly __brand: "ToolVersion" };

export type LoadedTool = ToolDetail & { readonly version: ToolVersion };

/**
 * Derives the version an agent pins a call to: a digest of the tool's loaded shape.
 *
 * Guard: the shape is projected with the default `allow` decision, so `authUncertain` never
 * enters the digest. It describes one caller's decision, and hashing it would hand two callers
 * two versions of one tool. Pinned by test/tool-version.spec.ts.
 */
export function toolVersion(tool: ToolDefinition): ToolVersion {
  return createHash("sha256")
    .update(canonicalJson(createDetail(tool)), "utf8")
    .digest("hex")
    .slice(0, 16) as ToolVersion;
}

export function createLoadedTool(
  tool: ToolDefinition,
  decision: VisibilityDecision = "allow",
): LoadedTool {
  return { ...createDetail(tool, decision), version: toolVersion(tool) };
}
