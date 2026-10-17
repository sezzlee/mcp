import { describe, expect, it } from "vitest";
import { countEvents, oracle, ours } from "./fixtures/xml-events.js";

const ns = "http://example.test/ns";
const other = "http://example.test/other";

const read = (xml: string) => {
  const outcome = ours(xml);
  if (outcome.kind === "refused") throw new Error(outcome.reason);
  return outcome.events;
};

const refusal = (xml: string): string => {
  const outcome = ours(xml);
  if (outcome.kind === "read")
    throw new Error("expected a refusal, the part was read");
  return outcome.reason;
};

/**
 * Expected values follow XML 1.0 (Fifth Edition) and Namespaces in XML 1.0,
 * not another parser: section 2.11 line ends, 3.3.3 attribute whitespace, 4.6
 * the predefined entities, 4.1 character references, 2.7 CDATA.
 */
describe("what the visitor sees", () => {
  it.each([
    [
      "a prefixed element names the same element as an unprefixed one",
      `<x:root xmlns:x="${ns}"><x:c r="A1"/></x:root>`,
      [
        `open {${ns}}root`,
        `open {${ns}}c {}r="A1"`,
        `close {${ns}}c`,
        `close {${ns}}root`,
      ],
    ],
    [
      "references are decoded in text and attributes",
      `<root v="a&amp;b&#65;&#x42;">1 &lt; 2 &gt; &quot;&apos;</root>`,
      [`open {}root {}v="a&bAB"`, `text "1 < 2 > \\"'"`, "close {}root"],
    ],
    [
      "line ends become LF in text and spaces in attributes; a reference keeps CR",
      `<root v="a\r\nb\tc&#13;">x\r\ny\rz</root>`,
      [`open {}root {}v="a b c\\r"`, `text "x\\ny\\nz"`, "close {}root"],
    ],
    [
      "CDATA is character data",
      `<root><![CDATA[<not a tag> & ]]></root>`,
      ["open {}root", `text "<not a tag> & "`, "close {}root"],
    ],
    [
      "a declaration, a comment and a processing instruction carry no events",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!-- c --><root><?pi x?></root>`,
      ["open {}root", "close {}root"],
    ],
    [
      "a declaration closes with its element, so a sibling sees the outer binding",
      `<root xmlns="${ns}"><a xmlns="${other}"/><b/></root>`,
      [
        `open {${ns}}root`,
        `open {${other}}a`,
        `close {${other}}a`,
        `open {${ns}}b`,
        `close {${ns}}b`,
        `close {${ns}}root`,
      ],
    ],
    [
      "an empty default declaration takes the element out of every namespace",
      `<root xmlns="${ns}"><a xmlns=""/></root>`,
      [`open {${ns}}root`, "open {}a", "close {}a", `close {${ns}}root`],
    ],
    [
      "an unprefixed attribute is in no namespace even under a default one",
      `<root xmlns="${ns}" xmlns:o="${other}" id="1" o:id="2"/>`,
      [`open {${ns}}root {${other}}id="2" {}id="1"`, `close {${ns}}root`],
    ],
  ])("%s", (_, xml, expected) => {
    expect(read(xml)).toStrictEqual(expected);
  });
});

describe("what the tokenizer refuses", () => {
  it.each([
    [
      "a DOCTYPE, which OPC forbids",
      `<!DOCTYPE root [<!ENTITY x "y">]><root>&x;</root>`,
      /DOCTYPE/,
    ],
    ["mismatched tags", "<root><a></b></root>", /end tag/],
    ["an unbound prefix", "<x:root/>", /not declared/],
    [
      "an entity outside the five predefined ones",
      "<root>&nbsp;</root>",
      /predefined/,
    ],
    [
      "a name every object inherits, used as an entity",
      "<root>&constructor;</root>",
      /predefined/,
    ],
    [
      "a reference to a character XML excludes",
      "<root>&#0;</root>",
      /character reference/,
    ],
    ["an unterminated reference", "<root>&amp</root>", /reference/],
    ["a repeated attribute", '<root a="1" a="2"/>', /repeated/],
    [
      "two prefixes that resolve one attribute twice",
      `<root xmlns:a="${ns}" xmlns:b="${ns}" a:x="1" b:x="2"/>`,
      /two attributes/,
    ],
    ["a second root", "<root/><root/>", /second root/],
    ["text outside the root", "<root/>x", /outside the root/],
    ["an unterminated element", "<root>", /ends inside/],
    ["no root at all", "<!-- only a comment -->", /no root/],
    ["'<' in an attribute value", '<root a="<"/>', /attribute value/],
    ["an unquoted attribute", "<root a=1/>", /not quoted/],
    [
      "attributes not separated by space",
      '<root a="1"b="2"/>',
      /not separated/,
    ],
    ["a name that starts with a digit", "<1root/>", /valid name/],
    ["a control character in text", "<root>\u0001</root>", /not allowed/],
    ["']]>' in text", "<root>]]></root>", /]]>/],
    ["'--' inside a comment", "<root><!-- a -- b --></root>", /comment/],
    [
      "an XML declaration that is not at the start",
      ' <?xml version="1.0"?><root/>',
      /not at the start/,
    ],
    [
      "a malformed XML declaration",
      '<?xml version="2.0"?><root/>',
      /XML declaration/,
    ],
    ["binding the xmlns prefix", `<root xmlns:xmlns="${ns}"/>`, /xmlns/],
    [
      "binding the xml prefix elsewhere",
      `<root xmlns:xml="${ns}"/>`,
      /XML namespace/,
    ],
    ["undeclaring a prefix", `<root xmlns:a=""/>`, /undeclares/],
    [
      "a colon in a processing instruction target",
      "<root><?a:b x?></root>",
      /colon/,
    ],
  ])("refuses %s", (_, xml, reason) => {
    expect(refusal(xml)).toMatch(reason);
  });
});

/**
 * Each input is shaped so a scan that is not linear in the part takes minutes:
 * nesting, a declaration on every level, attributes on one element, and a
 * construct cut into many small chunks. The default test timeout is the
 * assertion.
 */
describe("bounded work", () => {
  it("reads 200,000 levels of nesting", () => {
    const depth = 200_000;
    const xml = "<a>".repeat(depth) + "</a>".repeat(depth);
    expect(countEvents(xml)).toStrictEqual({ kind: "read", events: depth * 2 });
  });

  it("resolves names under a namespace declared on each of 50,000 levels", () => {
    const depth = 50_000;
    let xml = "";
    for (let level = 0; level < depth; level += 1)
      xml += `<p${String(level)}:a xmlns:p${String(level)}="${ns}">`;
    for (let level = depth - 1; level >= 0; level -= 1)
      xml += `</p${String(level)}:a>`;
    expect(countEvents(xml).kind).toBe("read");
  });

  it("checks 100,000 attributes on one element for repeats", () => {
    const attributes = Array.from(
      { length: 100_000 },
      (_, index) => `a${String(index)}="1"`,
    ).join(" ");
    expect(countEvents(`<root ${attributes}/>`).kind).toBe("read");
    expect(countEvents(`<root ${attributes} a7="2"/>`)).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/repeated/),
    });
  });

  it("reads a 4 MB attribute value arriving 64 characters at a time", () => {
    const value = "x".repeat(4 * 1024 * 1024);
    expect(countEvents(`<root a="${value}"/>`, [64]).kind).toBe("read");
  });
});

/** mulberry32, so every run explores the same inputs and a failure replays. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seeds = [
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(A1:A2)&amp;"x"</f><v>3</v></c></row></sheetData><hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks></worksheet>`,
  `<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2"><x:si><x:t xml:space="preserve"> a &lt;b&gt; </x:t></x:si><x:si><x:r><x:t>c</x:t></x:r><x:rPh><x:t>d</x:t></x:rPh></x:si></x:sst>`,
  `<root><!-- note --><?pi data?><![CDATA[raw <text> & ]]><a b='1' c="&#x10000;">&#233;t&#xE9;</a></root>`,
];

const alphabet = [
  ..."<>&;=\"'/!?[]-: \r\n\tax1#",
  "]]>",
  "<!--",
  "-->",
  "&amp;",
  "&#",
  "xmlns:",
  "\u0000",
  "\uFFFE",
  "\u00E9",
  "\u{1F600}",
];

function mutate(source: string, next: () => number): string {
  let text = source;
  const edits = 1 + Math.floor(next() * 3);
  for (let edit = 0; edit < edits; edit += 1) {
    const at = Math.floor(next() * (text.length + 1));
    const piece = alphabet[Math.floor(next() * alphabet.length)] ?? "<";
    const choice = next();
    if (choice < 0.4) text = text.slice(0, at) + piece + text.slice(at);
    else if (choice < 0.7)
      text = text.slice(0, at) + text.slice(at + 1 + Math.floor(next() * 4));
    else text = text.slice(0, at) + piece + text.slice(at + piece.length);
  }
  return text;
}

const trimmedNamespaces = (events: readonly string[]): string =>
  JSON.stringify(
    events.map((event) =>
      event.replace(/\{([^}]*)\}/g, (_, uri: string) => `{${uri.trim()}}`),
    ),
  );

/**
 * Where saxes 6.0.0 departs from the specifications, so a disagreement of
 * this shape is saxes's, not the tokenizer's:
 * - it trims a namespace name, while Namespaces in XML 1.0 section 2.3
 *   compares namespace names as strings, character for character;
 * - it accepts a processing instruction target that is not a Name, such as
 *   `pi?`, against XML 1.0 section 2.6.
 */
function knownSaxesDeviation(
  xml: string,
  expected: ReturnType<typeof oracle>,
  actual: ReturnType<typeof ours>,
): string | undefined {
  if (expected.kind === "read" && actual.kind === "read") {
    return trimmedNamespaces(expected.events) ===
      trimmedNamespaces(actual.events)
      ? "namespace name trimmed"
      : undefined;
  }
  if (expected.kind === "read" && actual.kind === "refused") {
    const name = /^'([^']*)' is not a valid name/.exec(actual.reason)?.[1];
    if (name !== undefined && name.includes("?") && xml.includes(`<?${name}`)) {
      return "processing instruction target is not a Name";
    }
  }
  return undefined;
}

describe("differential fuzzing against saxes", () => {
  it("agrees with saxes on every mutated part, read whole and in random chunks", () => {
    const next = random(0x5e221ee);
    const disagreements: string[] = [];
    const deviations = new Map<string, number>();
    for (let round = 0; round < 6000; round += 1) {
      const seed = seeds[round % seeds.length] ?? "";
      const xml = mutate(seed, next);
      const expected = oracle(xml);
      const whole = ours(xml);
      const chunked = ours(xml, [
        1 + Math.floor(next() * 9),
        1 + Math.floor(next() * 40),
      ]);
      const label = JSON.stringify(xml);
      const deviation = knownSaxesDeviation(xml, expected, whole);
      if (deviation !== undefined) {
        deviations.set(deviation, (deviations.get(deviation) ?? 0) + 1);
      } else if (whole.kind !== expected.kind) {
        disagreements.push(
          `${label}: saxes ${expected.kind}${expected.kind === "refused" ? ` (${expected.reason})` : ""}, ours ${whole.kind}${whole.kind === "refused" ? ` (${whole.reason})` : ""}`,
        );
      } else if (whole.kind === "read" && expected.kind === "read") {
        if (JSON.stringify(whole.events) !== JSON.stringify(expected.events))
          disagreements.push(`${label}: events differ`);
      }
      if (
        JSON.stringify(chunked) !== JSON.stringify(whole) &&
        !(chunked.kind === "refused" && whole.kind === "refused")
      ) {
        disagreements.push(`${label}: chunked read differs`);
      }
    }
    expect(disagreements.slice(0, 20)).toStrictEqual([]);
    expect([...deviations.keys()].sort()).toStrictEqual([
      "namespace name trimmed",
      "processing instruction target is not a Name",
    ]);
  }, 30_000);
});
