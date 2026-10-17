import { describe, expect, it } from "vitest";
import { expectRefusal, reader } from "./fixtures/harness.js";

const ns = "http://example.test/ns";

function opened(xml: string): { local: string; uri: string }[] {
  const seen: { local: string; uri: string }[] = [];
  reader().readXmlPart(xml, "part.xml", {
    onOpen(node) {
      seen.push({ local: node.local, uri: node.uri });
    },
  });
  return seen;
}

describe("readXmlPart", () => {
  it("matches a prefixed element the same as an unprefixed one", () => {
    const unprefixed = `<root xmlns="${ns}"><child/></root>`;
    const prefixed = `<x:root xmlns:x="${ns}"><x:child/></x:root>`;
    expect(opened(prefixed)).toStrictEqual(opened(unprefixed));
    expect(opened(prefixed)).toStrictEqual([
      { local: "root", uri: ns },
      { local: "child", uri: ns },
    ]);
  });

  it("reads an attribute by name and namespace", () => {
    const other = "http://example.test/other";
    let plain: string | undefined;
    let qualified: string | undefined;
    reader().readXmlPart(
      `<root xmlns="${ns}" xmlns:o="${other}" id="1" o:id="2"/>`,
      "part.xml",
      {
        onOpen(node) {
          plain = node.attr("id");
          qualified = node.attr("id", other);
        },
      },
    );
    expect(plain).toBe("1");
    expect(qualified).toBe("2");
  });

  it("reports closing tags and text", () => {
    const closed: string[] = [];
    const text: string[] = [];
    reader().readXmlPart(`<root xmlns="${ns}"><a>hi</a></root>`, "part.xml", {
      onClose(local) {
        closed.push(local);
      },
      onText(chunk) {
        text.push(chunk);
      },
    });
    expect(closed).toStrictEqual(["a", "root"]);
    expect(text.join("")).toBe("hi");
  });

  it("reports a CDATA section as text", () => {
    const text: string[] = [];
    reader().readXmlPart(
      `<root xmlns="${ns}"><a><![CDATA[1 < 2]]></a></root>`,
      "part.xml",
      {
        onText(chunk) {
          text.push(chunk);
        },
      },
    );
    expect(text.join("")).toBe("1 < 2");
  });

  it("refuses a part that declares a DOCTYPE", () => {
    const error = expectRefusal(
      () =>
        reader().readXmlPart(
          `<!DOCTYPE root [<!ENTITY x "y">]><root/>`,
          "part.xml",
          {},
        ),
      "corrupt_package",
    );
    expect(error.message).toContain("DOCTYPE");
  });

  it("lets a visitor's own error through unchanged and stops reading", () => {
    const refusal = new Error("the visitor refuses this part");
    const seen: string[] = [];
    expect(() =>
      reader().readXmlPart(
        `<root xmlns="${ns}"><a/><b/><c/></root>`,
        "part.xml",
        {
          onOpen(node) {
            seen.push(node.local);
            if (node.local === "a") throw refusal;
          },
        },
      ),
    ).toThrow(refusal);
    expect(seen).toStrictEqual(["root", "a"]);
  });

  it("refuses a part that is not well-formed", () => {
    const error = expectRefusal(
      () => reader().readXmlPart(`<root><a></root>`, "part.xml", {}),
      "corrupt_package",
    );
    expect(error.message).toContain("'part.xml' is not well-formed XML");
  });
});
