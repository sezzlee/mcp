import { describe, expect, it } from "vitest";
import {
  bytes,
  minimalContentTypes,
  samplePackage,
  zipOf,
} from "./fixtures/build.js";
import type { OpcPackage } from "../src/model/package.js";
import { expectRefusal, reader } from "./fixtures/harness.js";

function openSample(limits?: Parameters<typeof reader>[0]) {
  const api = reader(limits);
  return api.openPackage(api.zipSource(samplePackage()));
}

function openWith(files: Record<string, string | Uint8Array>) {
  const api = reader();
  return api.openPackage(api.zipSource(zipOf(files)));
}

function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    out[2 + index * 2] = code & 0xff;
    out[3 + index * 2] = code >>> 8;
  }
  return out;
}

describe("content types", () => {
  it("gives an Override precedence over a Default", () => {
    const types = openSample().contentTypes;
    expect(types.contentTypeOf("/doc/main.xml")).toBe(
      "application/vnd.custom.main+xml",
    );
  });

  it("matches an extension without regard to ASCII case", () => {
    const types = openSample().contentTypes;
    expect(types.contentTypeOf("media/image1.PNG")).toBe("image/png");
    expect(types.contentTypeOf("media/image9.png")).toBe("image/png");
  });

  it("reports no type for a part the package never typed", () => {
    expect(
      openSample().contentTypes.contentTypeOf("doc/other.zzz"),
    ).toBeUndefined();
  });

  it("refuses an archive with no content types part", () => {
    expectRefusal(() => openWith({ "doc/main.xml": "<a/>" }), "not_a_package");
  });
});

describe("relationships", () => {
  it("resolves a package relationship against the root, not the _rels folder", () => {
    const main = openSample().packageRelationships.get("rId1");
    expect(main).toStrictEqual({
      kind: "internal",
      id: "rId1",
      type: "http://example.test/main",
      target: "doc/main.xml",
    });
  });

  it("keeps an external target verbatim and marks it", () => {
    expect(openSample().packageRelationships.get("rId2")).toStrictEqual({
      kind: "external",
      id: "rId2",
      type: "http://example.test/site",
      target: "https://example.test/x",
    });
  });

  it("resolves a part's own relationships against its folder", () => {
    const rels = openSample().relationshipsFor("doc/main.xml");
    expect(rels.get("rId1")?.target).toBe("media/image1.PNG");
    expect(rels.get("rId2")?.target).toBe("doc/notes.xml");
  });

  it("drops a relationship whose target climbs above the root", () => {
    expect(openSample().relationshipsFor("doc/main.xml").has("rId3")).toBe(
      false,
    );
  });

  it("reports an empty map for a part with no relationships", () => {
    expect(openSample().relationshipsFor("doc/notes.xml").size).toBe(0);
  });

  it("names the relationships part, not its owner, when it is not well-formed", () => {
    const opened = openWith({
      "[Content_Types].xml": minimalContentTypes,
      "doc/main.xml": "<a/>",
      "doc/_rels/main.xml.rels": "<Relationships",
    });
    const error = expectRefusal(
      () => opened.relationshipsFor("doc/main.xml"),
      "corrupt_package",
    );
    expect(error.message).toMatch(/^'doc\/_rels\/main\.xml\.rels' is not/);
  });
});

describe("parts", () => {
  it("separates a present empty part from an absent one", () => {
    const opened = openSample();
    expect(opened.part("doc/notes.xml")).toBe("");
    expect(opened.part("doc/missing.xml")).toBeUndefined();
  });

  it("accepts a leading slash the way a relationship writes it", () => {
    const opened = openSample();
    expect(opened.part("/doc/notes.xml")).toBe("");
    expect(opened.partSize("/doc/main.xml")).toBe(
      opened.partSize("doc/main.xml"),
    );
  });

  it("hands back the raw bytes of a binary part", () => {
    expect(openSample().partBytes("media/image1.PNG")).toStrictEqual(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("lists every indexed part", () => {
    expect(openSample().parts.length).toBe(6);
  });
});

const readsOfAPart = [
  ["part", (opened: OpcPackage, path: string) => opened.part(path)],
  ["scanPart", (opened: OpcPackage, path: string) => opened.scanPart(path, {})],
] as const;

describe("part decoding", () => {
  it("strips a UTF-8 byte order mark", () => {
    const body = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...bytes(`<a xmlns="http://example.test/ns"/>`),
    ]);
    const opened = openWith({
      "[Content_Types].xml": minimalContentTypes,
      "doc/main.xml": body,
    });
    expect(opened.part("doc/main.xml")?.startsWith("<a ")).toBe(true);
  });

  it("decodes a UTF-16 part", () => {
    const opened = openWith({
      "[Content_Types].xml": minimalContentTypes,
      "doc/main.xml": utf16le(`<a xmlns="http://example.test/ns"/>`),
    });
    expect(opened.part("doc/main.xml")).toBe(
      `<a xmlns="http://example.test/ns"/>`,
    );
  });

  it.each(readsOfAPart)(
    "refuses a part that declares a code page it does not decode, through %s",
    (_, read) => {
      const opened = openWith({
        "[Content_Types].xml": minimalContentTypes,
        "doc/main.xml": `<?xml version="1.0" encoding="Shift_JIS"?><a/>`,
      });
      expectRefusal(
        () => read(opened, "doc/main.xml"),
        "unsupported_part_encoding",
      );
    },
  );

  /**
   * XML 1.0 section 2.2 and appendix F: bytes that are not the encoding's are
   * a fatal error. These are the CESU-8 form of U+D800, which UTF-8 forbids.
   */
  it.each(readsOfAPart)(
    "refuses a part that is not valid UTF-8, through %s",
    (_, read) => {
      const opened = openWith({
        "[Content_Types].xml": minimalContentTypes,
        "doc/main.xml": new Uint8Array([
          ...bytes("<a>"),
          0xed,
          0xa0,
          0x80,
          ...bytes("</a>"),
        ]),
      });
      const refusal = expectRefusal(
        () => read(opened, "doc/main.xml"),
        "corrupt_package",
      );
      expect(refusal.message).toMatch(/UTF-8/);
    },
  );

  /** XML 1.0 section 4.3.3: a UTF-16 entity begins with a byte order mark. */
  it.each(readsOfAPart)(
    "refuses a part that declares UTF-16 without a byte order mark, through %s",
    (_, read) => {
      const opened = openWith({
        "[Content_Types].xml": minimalContentTypes,
        "doc/main.xml": `<?xml version="1.0" encoding="UTF-16"?><a/>`,
      });
      const refusal = expectRefusal(
        () => read(opened, "doc/main.xml"),
        "corrupt_package",
      );
      expect(refusal.message).toMatch(/byte order mark/);
    },
  );

  it("accepts a part that declares the encoding it is written in", () => {
    const opened = openWith({
      "[Content_Types].xml": minimalContentTypes,
      "doc/main.xml": `<?xml version="1.0" encoding="UTF-8"?><a/>`,
    });
    expect(opened.part("doc/main.xml")).toContain("<a/>");
  });

  it("memoises a decoded part", () => {
    const opened = openSample();
    expect(opened.part("doc/main.xml")).toBe(opened.part("doc/main.xml"));
  });

  it("refuses to decode past the package budget, counting every part it decoded", () => {
    const filler = "<a>".padEnd(4096, "x");
    const tight = reader({ maxDecodedPackageBytes: 2048 });
    const opened = tight.openPackage(
      tight.zipSource(
        zipOf({
          "[Content_Types].xml": minimalContentTypes,
          "doc/main.xml": filler,
          "doc/other.xml": filler,
        }),
      ),
    );
    const error = expectRefusal(
      () => opened.part("doc/main.xml"),
      "package_too_large",
    );
    expect(error.message).toContain("decoding budget");
  });

  it("decodes a part lazily, so an unread part never touches the budget", () => {
    const filler = "<a>".padEnd(4096, "x");
    const tight = reader({ maxDecodedPackageBytes: 8192 });
    const opened = tight.openPackage(
      tight.zipSource(
        zipOf({
          "[Content_Types].xml": minimalContentTypes,
          "doc/main.xml": filler,
          "doc/other.xml": filler,
        }),
      ),
    );
    expect(opened.part("doc/main.xml")?.length).toBe(4096);
  });
});
