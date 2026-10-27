/** Checks explicit result (a + b) claims without executing model-authored text. */
export function assertAdditionClaims(answer: string): void {
  const plain = answer.replace(/[*`]/g, "");
  const claims = plain.matchAll(
    /([+-]?\d+(?:[.,]\d+)?)\s*\(\s*([+-]?\d+(?:[.,]\d+)?(?:\s*\+\s*[+-]?\d+(?:[.,]\d+)?)+)\s*\)/g,
  );
  for (const claim of claims) {
    const asserted = Number(claim[1]?.replace(",", "."));
    const terms = claim[2]
      ?.split(/\s*\+\s*/)
      .map((term) => Number(term.replace(",", ".")));
    if (!terms?.length || !Number.isFinite(asserted)) continue;
    const actual = terms.reduce((sum, term) => sum + term, 0);
    if (
      !Number.isFinite(actual) ||
      Math.abs(asserted - actual) >
        1e-12 * Math.max(1, Math.abs(asserted), Math.abs(actual))
    )
      throw new Error("Final answer contains an incorrect addition claim.");
  }
}
