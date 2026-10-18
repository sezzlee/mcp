const decimalDigit = /\p{Nd}/u;

/**
 * Maps Unicode decimal digits only; punctuation, controls and other numerals
 * remain unchanged for the caller's bounded grammar to accept or refuse.
 *
 * Guard: UAX #44 defines Nd as contiguous ascending ranges of 0 through 9.
 * Adjacent mathematical digit ranges repeat that order, hence the modulo.
 * No compatibility normalization may turn superscripts or fractions into
 * ordinary digits before the caller has decided the cell's type.
 */
export function asciiDecimalDigits(text: string): string {
  if (!/\P{ASCII}/u.test(text)) return text;
  return text.replace(/\p{Nd}/gu, (digit) => {
    if (digit >= "0" && digit <= "9") return digit;
    const point = digit.codePointAt(0);
    if (point === undefined) return digit;
    let start = point;
    while (start > 0 && decimalDigit.test(String.fromCodePoint(start - 1)))
      start -= 1;
    return String((point - start) % 10);
  });
}
