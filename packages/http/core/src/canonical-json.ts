/**
 * Renders a value as JSON with every object's keys in sorted order, so two spellings of one value
 * render identically.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const bag = value as Record<string, unknown>;
    return `{${Object.keys(bag)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(bag[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
