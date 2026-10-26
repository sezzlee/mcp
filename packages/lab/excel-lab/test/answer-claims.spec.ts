import { describe, expect, it } from "vitest";
import { assertAdditionClaims } from "../src/agent/answer-claims.ts";

describe("final answer addition claims", () => {
  it.each([
    "Result **119** (99 + 20 + 99)",
    "Sonuç **219** (99 + 20 + 99) olacaktır.",
    "Expected 41.31 (23.6 + 17.7)",
  ])("rejects independently wrong arithmetic: %s", (answer) => {
    expect(() => assertAdditionClaims(answer)).toThrow(
      "incorrect addition claim",
    );
  });

  it.each([
    "Result 218 (99 + 20 + 99)",
    "Expected 41.3 (23.6 + 17.7)",
    "Sonuç 41,3 (23,6 + 17,7)",
    "Result 0.3 (0.1 + 0.2)",
    "E1 contains SUM(C2:C4), not calculated; open in Excel.",
  ])("accepts correct arithmetic or no arithmetic claim: %s", (answer) => {
    expect(() => assertAdditionClaims(answer)).not.toThrow();
  });
});
