import { describe, expect, it } from "vitest";
import { selectAlternateContent } from "../src/index.js";
import type { XmlVisitor } from "../src/model/xml.js";
import { reader } from "./fixtures/harness.js";

const mc = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const main = "http://example.test/main";
const known = "http://example.test/known";
const unknown = "http://example.test/unknown";

function seen(
  body: string,
  understood: readonly string[] = [known],
): readonly string[] {
  const events: string[] = [];
  const recorder: XmlVisitor = {
    onOpen: (node) => events.push(`<${node.local}`),
    onClose: (local) => events.push(`>${local}`),
    onText: (text) => events.push(`"${text}"`),
  };
  reader().readXmlPart(
    `<root xmlns="${main}" xmlns:mc="${mc}" xmlns:k="${known}" xmlns:u="${unknown}">${body}</root>`,
    "part.xml",
    selectAlternateContent(recorder, (uri) => understood.includes(uri)),
  );
  return events;
}

describe("selectAlternateContent (ECMA-376 Part 3, §10.2)", () => {
  it("passes the first Choice it understands and drops the other branches", () => {
    expect(
      seen(
        '<mc:AlternateContent><mc:Choice Requires="u"><a/></mc:Choice><mc:Choice Requires="k"><b/></mc:Choice><mc:Choice Requires="k"><c/></mc:Choice><mc:Fallback><d/></mc:Fallback></mc:AlternateContent>',
      ),
    ).toStrictEqual(["<root", "<b", ">b", ">root"]);
  });

  it("passes the Fallback when no Choice is understood", () => {
    expect(
      seen(
        '<mc:AlternateContent><mc:Choice Requires="u"><a/></mc:Choice><mc:Fallback><d>x</d></mc:Fallback></mc:AlternateContent>',
      ),
    ).toStrictEqual(["<root", "<d", '"x"', ">d", ">root"]);
  });

  it("passes nothing when no Choice is understood and there is no Fallback", () => {
    expect(
      seen(
        '<before/><mc:AlternateContent><mc:Choice Requires="u"><a/></mc:Choice></mc:AlternateContent><after/>',
      ),
    ).toStrictEqual([
      "<root",
      "<before",
      ">before",
      "<after",
      ">after",
      ">root",
    ]);
  });

  it("skips a Choice when any one of its required namespaces is unknown", () => {
    expect(
      seen(
        '<mc:AlternateContent><mc:Choice Requires="k u"><a/></mc:Choice><mc:Fallback><d/></mc:Fallback></mc:AlternateContent>',
      ),
    ).toStrictEqual(["<root", "<d", ">d", ">root"]);
  });

  it("resolves Requires by namespace, not by the prefix written", () => {
    expect(
      seen(
        `<mc:AlternateContent xmlns:other="${known}"><mc:Choice Requires="other"><a/></mc:Choice><mc:Fallback><d/></mc:Fallback></mc:AlternateContent>`,
      ),
    ).toStrictEqual(["<root", "<a", ">a", ">root"]);
    expect(
      seen(
        `<mc:AlternateContent xmlns:k="${unknown}"><mc:Choice Requires="k"><a/></mc:Choice><mc:Fallback><d/></mc:Fallback></mc:AlternateContent>`,
      ),
    ).toStrictEqual(["<root", "<d", ">d", ">root"]);
  });

  it("treats an undeclared or empty Requires as not understood", () => {
    expect(
      seen(
        '<mc:AlternateContent><mc:Choice Requires="nowhere"><a/></mc:Choice><mc:Choice Requires=" "><b/></mc:Choice><mc:Choice><c/></mc:Choice><mc:Fallback><d/></mc:Fallback></mc:AlternateContent>',
      ),
    ).toStrictEqual(["<root", "<d", ">d", ">root"]);
  });

  it("applies the rule again inside the selected branch", () => {
    expect(
      seen(
        '<mc:AlternateContent><mc:Choice Requires="k"><a><mc:AlternateContent><mc:Choice Requires="u"><b/></mc:Choice><mc:Fallback><c/></mc:Fallback></mc:AlternateContent></a></mc:Choice><mc:Fallback><d/></mc:Fallback></mc:AlternateContent>',
      ),
    ).toStrictEqual(["<root", "<a", "<c", ">c", ">a", ">root"]);
  });

  it("drops a skipped branch's nested content and text whole", () => {
    expect(
      seen(
        '<mc:AlternateContent><mc:Choice Requires="u"><a><b>x</b><mc:AlternateContent><mc:Fallback><c/></mc:Fallback></mc:AlternateContent></a></mc:Choice><mc:Fallback>y</mc:Fallback></mc:AlternateContent><after/>',
      ),
    ).toStrictEqual(["<root", '"y"', "<after", ">after", ">root"]);
  });

  it("leaves a part without AlternateContent unchanged", () => {
    expect(seen('<a k:x="1"><b>t</b></a><c/>')).toStrictEqual([
      "<root",
      "<a",
      "<b",
      '"t"',
      ">b",
      ">a",
      "<c",
      ">c",
      ">root",
    ]);
  });
});

describe("XmlNode.namespaceOf", () => {
  it("answers the binding in scope at each element", () => {
    const resolved: string[] = [];
    reader().readXmlPart(
      `<p:root xmlns:p="${main}" xmlns="${known}"><p:inner xmlns:p="${unknown}"/><sibling/></p:root>`,
      "part.xml",
      {
        onOpen(node) {
          resolved.push(
            `${node.local} p=${node.namespaceOf("p") ?? "-"} default=${node.namespaceOf("") ?? "-"} q=${node.namespaceOf("q") ?? "-"}`,
          );
        },
      },
    );
    expect(resolved).toStrictEqual([
      `root p=${main} default=${known} q=-`,
      `inner p=${unknown} default=${known} q=-`,
      `sibling p=${main} default=${known} q=-`,
    ]);
  });
});
