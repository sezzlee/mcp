import { describe, expect, it } from "vitest";
import { parseCalculationAnswer } from "../src/calculation-answer.ts";

describe("calculation model answer evidence", () => {
  it("retains the model's numeric claim while explicitly recording known Qwen protocol trailers", () => {
    expect(
      parseCalculationAnswer(
        '{"filePath":"out/result.xlsx","total":40}\n</parameter>\n</function>\n</tool_call>',
      ),
    ).toEqual({
      answer: { filePath: "out/result.xlsx", total: 40 },
      protocolSuffixStripped: true,
    });
  });
  it.each([
    '{"filePath":"out/result.xlsx","total":40} Total is 50.',
    '{"filePath":"out/result.xlsx","total":40}{"total":50}',
    '{"filePath":"out/result.xlsx","total":"40"}',
    '{"filePath":"out/result.xlsx","total":40}</unknown>',
  ])(
    "rejects ambiguous or invalid claims rather than silently extracting favorable JSON: %s",
    (content) => {
      expect(() => parseCalculationAnswer(content)).toThrow();
    },
  );
});
