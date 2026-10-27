import type { ToolSpec } from "../agent/host.ts";
import { estimateTokens } from "../agent/ollama.ts";

export interface ToolCost {
  readonly name: string;
  readonly descriptionBytes: number;
  readonly schemaBytes: number;
  readonly specBytes: number;
  readonly estimatedTokens: number;
}

export interface CatalogCost {
  readonly condition: string;
  readonly tools: readonly ToolCost[];
  readonly specBytes: number;
  readonly estimatedTokens: number;
  readonly estimate: "ceil(utf8Bytes / 3); catalog total adds the preflight template reserve";
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Measures what a catalog costs a model: each tool's description, compact
 * input schema and whole host-side function object, and the catalog as the
 * runner sends it.
 * @param condition the catalog condition's name
 * @param specs the tools offered under that condition, as the host receives them
 */
export function catalogCost(
  condition: string,
  specs: readonly ToolSpec[],
): CatalogCost {
  return {
    condition,
    tools: specs.map((spec) => {
      const specBytes = bytes(JSON.stringify(spec));
      return {
        name: spec.function.name,
        descriptionBytes: bytes(spec.function.description),
        schemaBytes: bytes(JSON.stringify(spec.function.parameters)),
        specBytes,
        estimatedTokens: Math.ceil(specBytes / 3),
      };
    }),
    specBytes: bytes(JSON.stringify(specs)),
    estimatedTokens: estimateTokens(JSON.stringify(specs)),
    estimate:
      "ceil(utf8Bytes / 3); catalog total adds the preflight template reserve",
  };
}
