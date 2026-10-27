import { expect, it } from "vitest";
import { catalogCost } from "../src/lab/measure.ts";

it("counts UTF-8 bytes of descriptions, schemas and whole tool objects", () => {
  const spec = {
    type: "function" as const,
    function: {
      name: "t",
      description: "çğ",
      parameters: { type: "object" },
    },
  };
  const cost = catalogCost("one", [spec]);
  const whole =
    '{"type":"function","function":{"name":"t","description":"çğ","parameters":{"type":"object"}}}';
  expect(cost.tools).toEqual([
    {
      name: "t",
      descriptionBytes: 4,
      schemaBytes: 17,
      specBytes: whole.length + 2,
      estimatedTokens: Math.ceil((whole.length + 2) / 3),
    },
  ]);
  expect(cost.specBytes).toBe(whole.length + 4);
});
