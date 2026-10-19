import { describe, expect, it } from "vitest";
import { DateFormat, DateLocale, readDateText } from "../src/grid/date-text.js";
import { asciiDecimalDigits } from "../src/grid/locale-text.js";
import { NumberLocale, readNumberText } from "../src/grid/number-text.js";

function numbers(locale: string, numberingSystem?: string): NumberLocale {
  const compiled = NumberLocale.compile(locale, numberingSystem);
  if (compiled.kind === "invalid") throw new Error(compiled.reason);
  return compiled.locale;
}

function dates(locale?: string): DateLocale {
  const compiled = DateLocale.compile(locale);
  if (compiled.kind === "invalid") throw new Error(compiled.reason);
  return compiled.locale;
}

function format(pattern: string, locale?: string): DateFormat {
  const compiled = DateFormat.compile(pattern, locale);
  if (compiled.kind === "invalid") throw new Error(compiled.reason);
  return compiled.format;
}

describe("explicit locale numeric grammar", () => {
  it.each([
    ["en-US", "latn", "1,234.50", 1234.5],
    ["de-DE", "latn", "1.234,50", 1234.5],
    ["fr-FR", "latn", "1\u202f234,50", 1234.5],
    ["de-CH", "latn", "1’234.50", 1234.5],
    ["hi-IN", "latn", "12,34,567.75", 1234567.75],
    ["hi-IN", "deva", "१२,३४,५६७.७५", 1234567.75],
    ["bn-BD", "beng", "১২,৩৪,৫৬৭.৭৫", 1234567.75],
    ["ar-EG", "arab", "١٬٢٣٤٫٥٠", 1234.5],
    ["fa-IR", "arabext", "\u200e−۱٬۲۳۴٫۵۰", -1234.5],
    ["th-TH", "thai", "๑,๒๓๔.๕๐", 1234.5],
    ["my-MM", "mymr", "၁,၂၃၄.၅၀", 1234.5],
    ["ja-JP", "fullwide", "１,２３４.５０", 1234.5],
    ["zh-CN", "hanidec", "一,二三四.五〇", 1234.5],
  ])("reads %s/%s %s", (locale, system, text, expected) => {
    expect(numbers(locale, system).read(text)).toEqual({
      kind: "number",
      value: expected,
      unit: { kind: "plain" },
    });
  });

  it("requires Indian primary and secondary grouping widths", () => {
    const reader = numbers("hi-IN");
    for (const text of [
      "1,234,567.75",
      "123,45,678.75",
      "1,,23,456.75",
      "12,34,567.7,5",
    ])
      expect(reader.read(text), text).toEqual({ kind: "text" });
  });

  it("keeps non-Latin identifier spelling protected unless explicitly overridden", () => {
    const reader = numbers("ar-EG", "arab");
    expect(reader.read("٠٠١٢٣")).toEqual({ kind: "identifier" });
    expect(reader.read("١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦")).toEqual({ kind: "identifier" });
    expect(reader.read("٠٠١٢٣", "read")).toEqual({
      kind: "number",
      value: 123,
      unit: { kind: "plain" },
    });
    expect(reader.read("١٢٣٤٥٦٧٨٩٠١٢٣٤٥")).toMatchObject({
      kind: "number",
      value: 123456789012345,
    });
  });

  it("reads ratios and globally named currencies without assigning an ambiguous symbol a country", () => {
    expect(numbers("ar-EG").read("٥٠٪\u061c")).toEqual({
      kind: "number",
      value: 0.5,
      unit: { kind: "percent" },
    });
    expect(numbers("fa-IR").read("۱۲٫۵؉")).toEqual({
      kind: "number",
      value: 0.0125,
      unit: { kind: "permille" },
    });
    expect(numbers("en-CA").read("CAD 1,234.50")).toEqual({
      kind: "number",
      value: 1234.5,
      unit: { kind: "currency", code: "CAD" },
    });
    expect(numbers("es-MX").read("MXN 1,234.50")).toMatchObject({
      kind: "number",
      value: 1234.5,
      unit: { code: "MXN" },
    });
    expect(numbers("ja-JP").read("¥1,234")).toMatchObject({
      kind: "number",
      value: 1234,
      unit: { code: "¥" },
    });
    expect(numbers("ko-KR").read("₩1,234")).toMatchObject({
      kind: "number",
      value: 1234,
      unit: { code: "₩" },
    });
    expect(
      readNumberText("25‰", { decimal: ".", group: "none" }),
    ).toMatchObject({
      kind: "number",
      value: 0.025,
      unit: { kind: "permille" },
    });
  });

  it.each(["", "zz-ZZ", "not_a_locale"])(
    "does not fall back from unsupported locale %s",
    (locale) => {
      expect(NumberLocale.compile(locale).kind).toBe("invalid");
    },
  );

  it("rejects unsupported and conflicting numbering systems", () => {
    expect(NumberLocale.compile("en-US", "roman").kind).toBe("invalid");
    expect(NumberLocale.compile("en-US-u-nu-arab", "latn").kind).toBe(
      "invalid",
    );
    expect(numbers("en-US-u-nu-arab").read("١٢٫٥")).toMatchObject({
      kind: "number",
      value: 12.5,
    });
  });

  it("refuses unknown units, control characters, compatibility numerals and overlong input", () => {
    const reader = numbers("en-US");
    for (const text of [
      "ZZZ123",
      "123QQQ",
      "Ⅻ",
      "²³",
      "½",
      "1\u200d2",
      "1\u00002",
      "\ufeff123",
      "12".repeat(16384),
    ])
      expect(reader.read(text), text.slice(0, 32)).toEqual({ kind: "text" });
    expect(() => numbers("ar-EG").read("١e٣٠٩")).toThrow("finite number range");
  });
});

it("keeps Myanmar month marks distinct when a short January alias folds to June", () => {
  const reader = dates("my-MM");
  expect(reader.read("13 ဇွန် 2026")).toEqual({
    kind: "date",
    iso: "2026-06-13",
  });
  expect(reader.read("13 ဇန် 2026")).toEqual({
    kind: "date",
    iso: "2026-01-13",
  });
  expect(reader.read("13 ဇန 2026")).toEqual({ kind: "text" });
  expect(format("d MMMM yyyy", "my-MM").read("13 ဇွန် 2026")).toEqual({
    kind: "date",
    iso: "2026-06-13",
  });
});

describe("explicit Gregorian month vocabularies", () => {
  it.each([
    ["fr-FR", "13 février 2026", "2026-02-13"],
    ["fr-FR", "13 FE\u0301VRIER 2026", "2026-02-13"],
    ["de-DE", "13 März 2026", "2026-03-13"],
    ["es-ES", "13 febrero 2026", "2026-02-13"],
    ["pt-BR", "13 fevereiro 2026", "2026-02-13"],
    ["ru-RU", "13 марта 2026", "2026-03-13"],
    ["ru-RU", "13 март 2026", "2026-03-13"],
    ["pl-PL", "13 marca 2026", "2026-03-13"],
    ["pl-PL", "13 marzec 2026", "2026-03-13"],
    ["ar-EG", "١٣ فبراير ٢٠٢٦", "2026-02-13"],
    ["tr-TR", "13 Şubat 2026", "2026-02-13"],
    ["th-TH", "13 กุมภาพันธ์ 2026", "2026-02-13"],
  ])(
    "reads %s %s with both explicit and unambiguous readings",
    (locale, text, iso) => {
      expect(format("d MMMM yyyy", locale).read(text)).toEqual({
        kind: "date",
        iso,
      });
      expect(dates(locale).read(text)).toEqual({ kind: "date", iso });
    },
  );

  it("supports closed East Asian date separators and localized decimal digits", () => {
    expect(format("yyyy年M月d日", "ja-JP").read("2026年2月13日")).toEqual({
      kind: "date",
      iso: "2026-02-13",
    });
    expect(
      format("yyyy年MM月dd日", "zh-CN").read("２０２６年０２月１３日"),
    ).toEqual({ kind: "date", iso: "2026-02-13" });
    expect(
      format("yyyy-MM-dd a h:mm", "ja-JP").read("2026-02-13 午後 1:30"),
    ).toEqual({ kind: "date", iso: "2026-02-13T13:30:00.000" });
  });

  it("leaves ambiguous slash and dash dates undecided and reads dotted dates day first", () => {
    const reader = dates();
    expect(reader.read("01.02.2026")).toEqual({
      kind: "date",
      iso: "2026-02-01",
    });
    expect(dates("tr-TR").read("01.02.2026")).toEqual({
      kind: "date",
      iso: "2026-02-01",
    });
    for (const separator of [".", "/", "-"]) {
      const text = `01${separator}02${separator}2026`;
      if (separator !== ".")
        expect(reader.read(text)).toEqual({ kind: "text" });
      expect(reader.read(text, "dmy")).toEqual({
        kind: "date",
        iso: "2026-02-01",
      });
      expect(reader.read(text, "mdy")).toEqual({
        kind: "date",
        iso: "2026-01-02",
      });
    }
    expect(reader.read("13.02.2026")).toEqual({
      kind: "date",
      iso: "2026-02-13",
    });
    expect(reader.read("02/02/2026")).toEqual({
      kind: "date",
      iso: "2026-02-02",
    });
    expect(reader.read("13 Şubat 2026")).toEqual({
      kind: "date",
      iso: "2026-02-13",
    });
    expect(readDateText("01.02.2026", "mdy")).toEqual({
      kind: "date",
      iso: "2026-02-01",
    });
  });

  it("never falls back to another calendar or unsupported locale", () => {
    for (const locale of [
      "zz-ZZ",
      "not_a_locale",
      "th-TH-u-ca-buddhist",
      "ar-SA-u-ca-islamic",
      "en-US-u-nu-roman",
    ])
      expect(DateLocale.compile(locale).kind, locale).toBe("invalid");
    expect(format("d MMMM yyyy", "ar-SA").read("13 فبراير 2026")).toEqual({
      kind: "date",
      iso: "2026-02-13",
    });
    expect(DateFormat.compile("d MMMM yyyy", "zz-ZZ").kind).toBe("invalid");
  });

  it("handles date direction marks only at token boundaries and refuses impossible civil dates", () => {
    const reader = dates("ar-EG");
    expect(reader.read("١٣\u200f/٠٢\u200f/٢٠٢٦")).toEqual({
      kind: "date",
      iso: "2026-02-13",
    });
    for (const text of [
      "١\u200f٣/٠٢/٢٠٢٦",
      "2026-02-29",
      "2026-02-13T24:00:00Z",
      "2026-02-13T12:30:00+00:60",
      "2".repeat(32767),
    ])
      expect(reader.read(text), text.slice(0, 48)).toEqual({ kind: "text" });
    expect(DateFormat.compile(" ".repeat(32767)).kind).toBe("invalid");
  });
});

it("normalizes decimal digits without changing compatibility numerals or raw punctuation", () => {
  expect(asciiDecimalDigits("٠١۲۳४५৬৭๘๙ ０１２ 𝟠𝟡:３０")).toBe(
    "0123456789 012 89:30",
  );
  expect(asciiDecimalDigits("Ⅻ ² ½ 一二三 1\u200d2")).toBe(
    "Ⅻ ² ½ 一二三 1\u200d2",
  );
});

it("round trips seeded exact quarter-unit quantities through independent Intl formatters", () => {
  const seed = Number(process.env["SEZZLEE_TYPED_FUZZ_SEED"] ?? 0x6b8b4567);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff)
    throw new Error(
      "SEZZLEE_TYPED_FUZZ_SEED must be an unsigned 32-bit integer.",
    );
  let state = seed;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const locales = [
    ["en-US", "latn"],
    ["de-DE", "latn"],
    ["fr-FR", "latn"],
    ["de-CH", "latn"],
    ["hi-IN", "deva"],
    ["bn-BD", "beng"],
    ["ar-EG", "arab"],
    ["fa-IR", "arabext"],
    ["th-TH", "thai"],
    ["my-MM", "mymr"],
    ["ja-JP", "fullwide"],
    ["zh-CN", "hanidec"],
  ] as const;
  for (const [locale, numberingSystem] of locales) {
    const reader = numbers(locale, numberingSystem);
    const formatter = new Intl.NumberFormat(locale, {
      numberingSystem,
      useGrouping: true,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const digits = new Intl.NumberFormat(locale, {
      numberingSystem,
      useGrouping: false,
    });
    for (let sample = 0; sample < 250; sample += 1) {
      const expected = ((next() % 400000001) - 200000000) / 4;
      const text = formatter.format(expected);
      expect(reader.read(text), `${seed}:${locale}:${sample}:${text}`).toEqual({
        kind: "number",
        value: expected,
        unit: { kind: "plain" },
      });
      const grouped = formatter.format(1_000_000 + sample / 4);
      const malformedGroup = grouped.replace(
        reader.group,
        reader.group.repeat(2),
      );
      expect(
        reader.read(malformedGroup),
        `${seed}:${locale}:${sample}:group`,
      ).toEqual({ kind: "text" });
      expect(
        reader.read(`${text}\u200d`),
        `${seed}:${locale}:${sample}:control`,
      ).toEqual({ kind: "text" });
      const identifier = `${digits.format(0)}${digits.format(sample + 1)}`;
      expect(
        reader.read(identifier),
        `${seed}:${locale}:${sample}:identifier`,
      ).toEqual({ kind: "identifier" });
      expect(
        reader.read(identifier, "read"),
        `${seed}:${locale}:${sample}:explicit`,
      ).toEqual({
        kind: "number",
        value: sample + 1,
        unit: { kind: "plain" },
      });
    }
  }
});
