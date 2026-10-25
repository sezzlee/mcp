import { readFileSync } from "node:fs";
import { format } from "prettier";
import { it } from "vitest";

it("prints the canonical provider fixture format", async () => {
  const file = new URL("./provider-result-invariants.spec.ts", import.meta.url);
  const source = readFileSync(file, "utf8");
  console.log(await format(source, { parser: "typescript" }));
});
