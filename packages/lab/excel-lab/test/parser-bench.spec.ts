import { describe, expect, it } from "vitest";
import { parserNames, type BenchVisitor } from "../src/parser-bench/events.ts";
import { parsers } from "../src/parser-bench/parsers.ts";

const ns = "http://example.test/ns";

function trace(name: (typeof parserNames)[number], xml: string) {
  const events: string[] = [];
  let text = "";
  const flush = () => {
    if (text !== "") events.push(`text ${JSON.stringify(text)}`);
    text = "";
  };
  const visitor: BenchVisitor = {
    onOpen(node) {
      flush();
      const attributes = node
        .attributes()
        .map(
          (attribute) =>
            `${attribute.uri}|${attribute.local}=${JSON.stringify(attribute.value)}`,
        );
      events.push(
        `open ${node.uri}|${node.local} ${attributes.join(" ")}`.trimEnd(),
      );
    },
    onClose(local, uri) {
      flush();
      events.push(`close ${uri}|${local}`);
    },
    onText(chunk) {
      text += chunk;
    },
  };
  const outcome = parsers[name](xml, visitor);
  flush();
  return outcome.kind === "read" ? events : "refused";
}

/**
 * Where a parser breaks the rule a case states, measured on sax 1.6.1 in
 * strict mode. A case listed here is expected to differ, so a parser that
 * starts conforming fails its row and the list shrinks.
 */
const deviations: Readonly<
  Record<(typeof parserNames)[number], readonly string[]>
> = {
  saxes: [],
  sax: [
    "line ends become LF in text, spaces in attributes, and a reference keeps CR",
    "an undefined entity",
    "a repeated attribute",
    "a second root",
  ],
  own: [],
};

/**
 * Expected values follow XML 1.0 (Fifth Edition) and Namespaces in XML 1.0:
 * §2.11 line ends, §3.3.3 attribute whitespace, §4.6 the predefined entities,
 * §4.1 character references, §2.7 CDATA.
 */
describe.each(parserNames)("%s", (name) => {
  it.each([
    [
      "a prefixed element names the same element as an unprefixed one",
      `<x:root xmlns:x="${ns}"><x:c r="A1"/></x:root>`,
      [
        `open ${ns}|root`,
        `open ${ns}|c |r="A1"`,
        `close ${ns}|c`,
        `close ${ns}|root`,
      ],
    ],
    [
      "references are decoded in text and attributes",
      `<root v="a&amp;b&#65;&#x42;">1 &lt; 2 &gt; &quot;&apos;</root>`,
      [`open |root |v="a&bAB"`, `text "1 < 2 > \\"'"`, "close |root"],
    ],
    [
      "line ends become LF in text, spaces in attributes, and a reference keeps CR",
      `<root v="a\r\nb\tc&#13;">x\r\ny\rz</root>`,
      [`open |root |v="a b c\\r"`, `text "x\\ny\\nz"`, "close |root"],
    ],
    [
      "CDATA is character data",
      `<root><![CDATA[<not a tag> & ]]></root>`,
      ["open |root", `text "<not a tag> & "`, "close |root"],
    ],
    [
      "a declaration, a comment and a processing instruction carry no events",
      `\uFEFF<?xml version="1.0"?><!-- c --><root><?pi x?></root>`,
      ["open |root", "close |root"],
    ],
  ])("%s", (rule, xml, expected) => {
    if (deviations[name].includes(rule)) {
      expect(trace(name, xml)).not.toStrictEqual(expected);
    } else {
      expect(trace(name, xml)).toStrictEqual(expected);
    }
  });

  it.each([
    ["a DOCTYPE", `<!DOCTYPE root [<!ENTITY x "y">]><root>&x;</root>`],
    ["mismatched tags", "<root><a></b></root>"],
    ["an unbound prefix", "<x:root/>"],
    ["an undefined entity", "<root>&nbsp;</root>"],
    ["a repeated attribute", '<root a="1" a="2"/>'],
    ["a second root", "<root/><root/>"],
    ["text outside the root", "<root/>x"],
    ["an unterminated element", "<root>"],
  ])("refuses %s", (rule, xml) => {
    if (deviations[name].includes(rule)) {
      expect(trace(name, xml)).not.toBe("refused");
    } else {
      expect(trace(name, xml)).toBe("refused");
    }
  });
});
