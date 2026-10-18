# Global typed-text sources and scope

Research checked on 2026-10-18. These primary sources informed the parser and test design;
they are not a claim that the server implements every feature of each specification.
The fixture generator creates original data under this repository's MIT license. It does not
download or redistribute a third-party corpus or copy locale tables into the server.

## Source manifest

| Primary source                                                                                                                                                                                                                                                        | Decision supported                                                                                                         | Implementation and verification boundary                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Unicode LDML, Numbers](https://unicode.org/reports/tr35/tr35-numbers.html)                                                                                                                                                                                           | Decimal and grouping symbols, primary and secondary group widths, positional digit systems, percent and per-mille scaling. | Explicit locale compiles symbols and digit mappings through Intl once. Indian 3/2 grouping is checked. Percent becomes a fraction divided by 100; per-mille by 1000. Algorithmic systems and fractional grouping are not implemented.                    |
| [ECMA-402, Intl.NumberFormat formatToParts](https://tc39.es/ecma402/#sec-intl.numberformat.prototype.formattoparts)                                                                                                                                                   | Use the runtime's structured number parts and report the resolved locale and numbering system.                             | Unsupported locales and requested systems are refused. The server never substitutes the host's default locale. Locale data can change with ICU upgrades; generator and verification records both capture runtime versions.                               |
| [Unicode LDML, Dates](https://unicode.org/reports/tr35/tr35-dates.html)                                                                                                                                                                                               | Month names can differ between formatting and standalone contexts; narrow names can be ambiguous.                          | Explicit Gregorian month vocabularies include long and short names from both contexts. Narrow names are not used. Other calendars, eras, relative dates and natural-language date extraction are outside the grammar.                                    |
| [Unicode CLDR 48, Burmese date chart](https://www.unicode.org/cldr/charts/48/verify/dates/my.html)                                                                                                                                                                    | January abbreviation `ဇန်` and June `ဇွန်` are different month names.                                                      | A corpus-discovered regression showed accent folding removed essential marks and rejected the whole locale. Exact NFC aliases and Unicode case matches now precede unambiguous folded aliases; stripped ambiguous `ဇန` stays text.                       |
| [Unicode UAX #44, Unicode Character Database](https://www.unicode.org/reports/tr44/)                                                                                                                                                                                  | Decimal digits have Numeric_Type Decimal, with contiguous ascending values 0–9.                                            | A shared helper maps Unicode Nd digits without applying compatibility normalization. Superscripts, vulgar fractions and Roman numerals do not become ordinary digits. The locale number reader separately supports Intl's positional Han decimal digits. |
| [RFC 3339, section 5.6](https://www.rfc-editor.org/rfc/rfc3339.html#section-5.6)                                                                                                                                                                                      | Numeric offset components use hours 00–23 and minutes 00–59.                                                               | Impossible offsets such as `+24:00`, `+99:99` and `-00:60` are refused. The parser does not implement every RFC 3339 feature: leap seconds, named time zones and arbitrary historical calendar conversions are unsupported.                              |
| [Frictionless Table Schema](https://datapackage.org/standard/table-schema/)                                                                                                                                                                                           | Missing text tokens and explicit true/false token sets are part of a data interpretation contract.                         | Callers can replace token lists for any script. Matching is folded. A universal dictionary of translated boolean words is not inferred; overlapping configured sets are rejected. Raw CSV text is preserved.                                             |
| [WHATWG Encoding, TextDecoder](https://encoding.spec.whatwg.org/#interface-textdecoder)                                                                                                                                                                               | Explicit encoding labels and fatal decoding prevent silent replacement of malformed sequences.                             | CSV accepts a closed encoding list and never guesses a legacy encoding. UTF BOM contradictions are refused. Node/ICU supplies codecs; fixed vectors do not establish complete WHATWG index conformance.                                                  |
| [WHATWG windows-1251 index](https://encoding.spec.whatwg.org/index-windows-1251.txt), [windows-1256 index](https://encoding.spec.whatwg.org/index-windows-1256.txt) and [Python standard encodings](https://docs.python.org/3/library/codecs.html#standard-encodings) | Independent codec references for Cyrillic and Arabic single-byte text and CJK multibyte fixtures.                          | Six hard-coded byte vectors were exported once with Python's standard codecs and asserted against fixed Unicode strings. Production TextDecoder output never creates the expected strings. Python is not a runtime dependency.                           |
| [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180.html) and [W3C CSV on the Web](https://www.w3.org/TR/tabular-data-model/)                                                                                                                                           | Separate CSV syntax and tabular interpretation; preserve cell spelling.                                                    | Original generated fixtures quote every field and use CRLF. Existing CSV tokenizer tests cover syntax separately. The old `draft-shafranovich-rfc4180-bis` is an expired Internet-Draft, not a replacement RFC.                                          |

The latest published Unicode report and the installed Unicode database are separate facts.
The implementation evidence in this change used Node v24.19.0, ICU 78.3, CLDR 48.0 and
Unicode 17.0. Reading a newer living report does not upgrade the runtime's data.

## Independent known answers

`src/typed-corpus.ts` chooses exact quarter-unit amounts, fixed Gregorian civil dates,
booleans, identifier strings and duration seconds before formatting anything. Intl only
serializes those chosen values. Expected grouped sums, counts, month buckets and predicate
results come from the chosen values, not from the production parser or a previous MCP answer.

The generated set contains 19 locale/numbering-system configurations:

| Locales                                                              | Numbering systems                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| en-US, de-DE, fr-FR, de-CH, ru-RU, pl-PL, es-ES, pt-BR, tr-TR, ko-KR | latn                                                            |
| hi-IN                                                                | latn and deva                                                   |
| bn-BD, ar-EG, fa-IR, th-TH, my-MM, ja-JP, zh-CN                      | beng, arab, arabext, thai, mymr, fullwide, hanidec respectively |

Every configuration includes twelve month names, a small explicit custom boolean/missing
vocabulary, signed elapsed durations, leading-zero identifiers and a numeric-looking
identifier after the profiler's 32-row sample. Profile output is reused in an aggregate call
and must still refuse that late identifier. Custom words rotate among Spanish, Japanese,
Chinese, Arabic, Russian and Korean; they are explicit fixture vocabularies, not new defaults.

Input bytes and the independently generated expected-answer file each have a SHA-256 digest.
Saved runs can be replayed against a newer built server. The report records the generator's
data versions separately from the verifying runtime, plus the built implementation digest.
The generator is deterministic for a seed, row count and Intl data version. A version change
may change the serialized bytes; replaying saved bytes keeps that comparison controlled.

## Parser fuzz invariants

`global-parser.spec.ts` has a deterministic 32-bit seed, overridable with
`SEZZLEE_TYPED_FUZZ_SEED`. Each seed checks 12 locale/system configurations with 250 samples
per configuration:

- 3,000 independently formatted exact quantities must recover the chosen scalar.
- 3,000 doubled-group mutations and 3,000 inserted-control mutations must remain text.
- 3,000 leading-zero identifier spellings must be refused under the protective policy and
  read only under the explicit override, with the known integer unchanged.

The failure message contains seed, locale and sample index. Fixed regressions additionally
cover 15/16-digit boundaries, ambiguous dates, combining marks, invalid civil dates and
offsets, unsupported locales/calendars/numbering systems, currencies, percentages,
per-mille and 32,767-character inputs. These are bounded parser and integration checks,
not exhaustive Unicode or spreadsheet application conformance.

## Deliberate limits

Dates use the Gregorian calendar and an explicit closed pattern or conservative unambiguous
grammar. The old automatic dotted DMY reading remains compatible; an explicit date column
with no format/order does not guess an ambiguous dotted date. Localized day periods are
available in explicit patterns; automatic free-form localized time phrases are not parsed.
Date and time digit normalization covers Unicode Nd digits. Positional Han digit parsing is
provided by explicit number readings; Han day/year numerals are not a supported date grammar.

Number parsing does not perform exchange-rate conversion, infer the country behind ambiguous
currency symbols, accept arbitrary currency words, implement accounting-specific arbitrary
patterns, or promise exact arithmetic for decimal values that binary floating point cannot
represent. Identifier protection is a policy, not a guarantee that every business identifier
can be recognized from its spelling. Saved profile plans always select the protective policy.

CSV decoding adds windows-1251, windows-1256, Shift_JIS, GB18030, Big5 and EUC-KR to the prior
closed list. The negative vectors end with known multibyte lead bytes. In the measured ICU
decoder EUC-KR byte 0x81 is a C1 control, so it is not used as a truncated lead-byte oracle;
the Korean test uses 0xC7 from its valid fixture. No general character-set detection or new
CSV `sep=` directive behavior is claimed here.

No private external workbook corpus was available in this workspace. Historical corpus and
parity-fuzz measurements elsewhere in FINDINGS are retained as historical evidence and were
not rerun or counted as this change's coverage.
