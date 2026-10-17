import { zipSync, type ZippableFile } from "fflate";
import { describe, expect, it } from "vitest";
import type { OpcPackage } from "../src/model/package.js";
import {
  bytes,
  minimalContentTypes,
  patchHeaders,
  zipOf,
} from "./fixtures/build.js";
import { expectRefusal, reader } from "./fixtures/harness.js";

const ns = "http://example.test/ns";
const path = "doc/main.xml";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Values a compressor barely shrinks, mixing one- to four-byte UTF-8
 * characters and the two characters XML must escape, so that byte sequences
 * and references straddle the chunk boundaries.
 */
function values(count: number): string[] {
  const alphabet = [
    "a",
    "Z",
    "7",
    "ı",
    "ş",
    "Ğ",
    "ç",
    "€",
    "東",
    "😀",
    "&",
    "<",
  ];
  const random = mulberry32(7);
  const pick = () => alphabet[Math.floor(random() * alphabet.length)] ?? "a";
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(random() * 12) }, pick).join(""),
  );
}

const escaped = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

function partOf(list: readonly string[]): string {
  return `<root xmlns="${ns}">${list.map((value) => `<v>${escaped(value)}</v>`).join("")}</root>`;
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

function archiveOf(part: ZippableFile): Uint8Array {
  return zipSync({
    "[Content_Types].xml": bytes(minimalContentTypes),
    [path]: part,
  });
}

function opened(archive: Uint8Array, maxDecodedPackageBytes?: number) {
  const api = reader(
    maxDecodedPackageBytes === undefined ? {} : { maxDecodedPackageBytes },
  );
  return api.openPackage(api.zipSource(archive));
}

function chunksOf(archive: Uint8Array): number {
  let chunks = 0;
  reader()
    .zipSource(archive)
    .stream?.(path, () => {
      chunks += 1;
    });
  return chunks;
}

function valuesScanned(opc: OpcPackage): string[] {
  const seen: string[] = [];
  let current: string | undefined;
  const found = opc.scanPart(path, {
    onOpen(node) {
      if (node.local === "v") current = "";
    },
    onText(text) {
      if (current !== undefined) current += text;
    },
    onClose(local) {
      if (local !== "v" || current === undefined) return;
      seen.push(current);
      current = undefined;
    },
  });
  expect(found).toBe(true);
  return seen;
}

const list = values(40_000);

describe("scanning a part as it inflates", () => {
  it.each([
    ["deflated UTF-8", archiveOf(bytes(partOf(list)))],
    ["stored UTF-8", archiveOf([bytes(partOf(list)), { level: 0 }])],
    ["deflated UTF-16", archiveOf(utf16le(partOf(list)))],
  ])(
    "hands the visitor every value whole in %s, across chunks",
    (_, archive) => {
      expect(chunksOf(archive)).toBeGreaterThan(1);
      expect(valuesScanned(opened(archive))).toStrictEqual(list);
    },
  );

  it("reports an absent part as absent", () => {
    expect(opened(archiveOf(bytes("<a/>"))).scanPart("doc/other.xml", {})).toBe(
      false,
    );
  });

  it("refuses bytes that are not UTF-8 found past the first chunk", () => {
    const body = bytes(partOf(list));
    const broken = new Uint8Array([...body.subarray(0, -7), 0xed, 0xa0, 0x80]);
    const archive = archiveOf(broken);
    expect(chunksOf(archive)).toBeGreaterThan(1);

    const error = expectRefusal(
      () => opened(archive).scanPart(path, {}),
      "corrupt_package",
    );
    expect(error.message).toBe(`'${path}' is not valid UTF-8.`);
  });

  it("refuses a part that stops being well-formed past the first chunk", () => {
    const archive = archiveOf(bytes(`${partOf(list).slice(0, -7)}</rot>`));

    const error = expectRefusal(
      () => opened(archive).scanPart(path, {}),
      "corrupt_package",
    );
    expect(error.message).toMatch(/is not well-formed XML/);
  });

  it("lets a visitor's own error through unchanged, not as a failed decompression", () => {
    const refusal = new Error("the visitor refuses this part");
    let opens = 0;

    expect(() =>
      opened(archiveOf(bytes(partOf(list)))).scanPart(path, {
        onOpen() {
          opens += 1;
          if (opens === 30_000) throw refusal;
        },
      }),
    ).toThrow(refusal);
  });

  it("refuses a part whose bytes no longer match the directory's CRC-32", () => {
    const archive = archiveOf([
      bytes(`<a xmlns="${ns}">value</a>`),
      { level: 0 },
    ]);
    const at = Buffer.from(archive).indexOf("value");
    const tampered = Uint8Array.from(archive);
    tampered[at] = (tampered[at] ?? 0) ^ 0x01;

    const error = expectRefusal(
      () => opened(tampered).scanPart(path, {}),
      "corrupt_package",
    );
    expect(error.message).toMatch(/CRC-32/);
  });

  it("stops a part that inflates past the size its directory declares", () => {
    const forged = patchHeaders(zipOf({ "a.xml": "<a/>" }), {
      uncompressedSize: 2,
    });
    const source = reader().zipSource(forged);

    const error = expectRefusal(
      () => source.stream?.("a.xml", () => undefined),
      "corrupt_package",
    );
    expect(error.message).toBe("'a.xml' declares 2 bytes but expands to more.");
  });

  it("counts a part against the decoding budget once however often it is scanned", () => {
    const body = bytes(partOf(list.slice(0, 100)));
    const contentTypes = bytes(minimalContentTypes).length;
    const opc = opened(
      archiveOf(body),
      contentTypes + body.length + body.length / 2,
    );

    expect(valuesScanned(opc)).toStrictEqual(list.slice(0, 100));
    expect(valuesScanned(opc)).toStrictEqual(list.slice(0, 100));
    expect(opc.part(path)).toBe(partOf(list.slice(0, 100)));
  });
});
