# @sezzlee/ooxml-core

Shared reader for OOXML (ECMA-376) containers: a zip part source, the OPC package model,
relationships, content types and single-pass XML part scanning. `@sezzlee/excel-mcp` consumes it
today; `docx-mcp` and `pptx-mcp` are meant to sit on the same core later.

## Usage

A consumer injects an error factory and reads a package through the resulting reader:

```ts
const reader = createOoxmlReader({
  fail: (code, message) =>
    new SezzleeExcelError(excelCodeFor(code), message, recoveryFor(code)),
});
```

The core hands back only the fact it alone knows (which part, which zip property, what the parser
reported); the consumer chooses the error class, the code vocabulary and the recovery text —
format nouns belong there, not in this package.

## API

| Module      | Exports                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reader`    | `createOoxmlReader`, `OoxmlEnvironment`, `OoxmlReader`                                                                                                   |
| `container` | `classifyContainerMagic`; `extensionOf`, `normalisePartPath`, `relationshipsPathFor`, `resolveTarget`                                                    |
| `xml`       | `ooxmlNamespaces`, `XmlPartReader`                                                                                                                       |
| `limits`    | `ooxmlLimits`, `OoxmlLimits`                                                                                                                             |
| `model`     | `OoxmlErrorCode`, `OoxmlErrorFactory`; `ContainerKind`, `ContentTypes`, `OpcPackage`, `PartEntry`, `PartSource`, `Relationship`; `XmlNode`, `XmlVisitor` |

## Rules

- **No format-specific vocabulary.** An `xl/`, `word/` or `ppt/` prefix, a SpreadsheetML /
  WordprocessingML / PresentationML namespace, or the noun "workbook", "sheet", "document" or
  "presentation" inside this package is a defect. Container nouns — package, part, relationship,
  archive — are ECMA-376 vocabulary and are allowed.
- **Names no `@sezzlee/*` package.** The error factory and the part source both arrive by
  injection, so `@e965/xlsx` never enters this package.
- **`fflate` is its only runtime dependency.** `saxes` is a dev dependency, the oracle the
  tokenizer is fuzzed against.

## Design notes

**Why SAX, not DOM.** `packages/servers/xml-mcp` uses `libxml2-wasm` because it needs DOM and
XPath over a document whose schema is **unknown** — that choice brought worker isolation, a pool,
and a machine-checked worker module graph with it. An OOXML part's schema is **known** and every
read is a single forward pass. Random access happens _between_ parts, which the `PartSource` index
already covers. So there is no worker, no pool and no WASM here.

**Zip.** Two passes over `fflate`: a counting pass indexes the directory without inflating
anything and applies the deny list; the read pass inflates only the requested part. The size gates
run during the counting pass — a gate applied after inflation is not a gate. Three gates work
together, because one threshold alone either rejects real files or lets a bomb through:

| Gate                     | Value   | Basis                                                                                  |
| ------------------------ | ------- | -------------------------------------------------------------------------------------- |
| `maxPartBytes`           | 384 MiB | Node's `MAX_STRING_LENGTH` is 512 Mi characters; `part()` returns a decoded string     |
| `maxExpansionRatio`      | 200:1   | The measured real-world maximum is 40:1; a single deflate stream cannot exceed ~1032:1 |
| `ratioFloorBytes`        | 16 MiB  | Below this, ratio is not checked — a small, highly repetitive part is normal           |
| `maxDecodedPackageBytes` | 512 MiB | Bounds the sum of many parts that each stay under their own limit                      |

**Integrity.** The read pass checks each inflated part against its CRC-32 and each local header
against the central directory, so a damaged archive fails as `corrupt_package` and two zip readers
cannot be shown two different parts under one name. Bytes that start with a zip signature but do
not index are `corrupt_package`; bytes that do not are `not_a_package`.

**The tokenizer.** `src/xml/tokenizer.ts` reads XML 1.0 for an OOXML part: elements, attributes,
text, CDATA, comments and processing instructions, the five predefined entities and character
references. A DOCTYPE is refused, so no other entity can exist. `src/xml/scope.ts` resolves names
against Namespaces in XML 1.0. Every check is linear in the part: names are validated once and
remembered, repeated attributes are found through a set, and namespace bindings live in one map that
an element restores when it closes. Input may arrive in chunks; a construct cut by a chunk boundary
is retried only once the buffer has doubled. It replaced `saxes` (archived upstream since 2021)
after a benchmark on the largest corpus parts showed it 2.2 times faster with the same events on
every part (`packages/lab/excel-lab/FINDINGS.md`). What proves it:

| Test                           | What it checks                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/xml-tokenizer.spec.ts`   | the rules with expected values from the specifications, inputs that would be quadratic in a naive scan, and 6,000 seeded mutations compared with `saxes` read whole and in random chunks         |
| `test/xml-conformance.spec.ts` | the W3C XML Conformance Test Suite, gated on `SEZZLEE_CORPUS`: every not-well-formed case whose error lies outside a DTD refused, every well-formed one read and matched to its canonical output |

**Encoding.** A part is decoded by its byte order mark, and decoding is fatal on a malformed
sequence: a replacing decoder would turn damaged bytes into U+FFFD, a legal character. A part that
names UTF-16 without a byte order mark, or a code page this reader does not decode, is refused.

**Visitor errors.** An error thrown by an `XmlVisitor` callback stops the scan and reaches the
caller unchanged. Only a failure of the XML itself becomes `corrupt_package`.

**Known limitation.** Per-entry zip encryption (PKWARE) is **not detected**: `fflate`'s
general-purpose flag bit is not exposed to the filter callback. A document Office actually
encrypts is already a CFB container, not a zip, and `classifyContainerMagic` catches it outside
the package. An encrypted entry fails as a corrupt part instead.

## Rejected alternatives

- **An in-house zip reader.** About 330 lines and a 30-case test matrix as a precondition.
  `fflate` is mature, MIT, dependency-free, and its `filter` callback still leaves the bomb gate to
  this package.
- **A `file-core` dependency for `asciiLower`.** A twelve-line function would pull in the MCP SDK
  and zod peers and invert the layering; it is copied instead (`src/primitives/text.ts`).
- **An in-process BIFF8 or Word binary reader.** Thousands of lines of parser for an effectively
  undocumented format, over untrusted input, inside a read-only server whose value is a small
  attack surface.
- **Shelling out to `soffice --convert-to`.** It writes the converted file, depends on an install
  no manifest can express and no CI runner has, costs seconds per document, and hands untrusted
  input to a large C++ surface with a macro and URL-fetch CVE history.
- **A `PartPath` brand.** A forged part path is a cache miss (`part()` returns `undefined`), not a
  traversal; nothing is opened on disk, so the brand buys nothing. The `Relationship` union already
  prevents mix-ups.
- **An `"encrypted"` `ContainerKind`.** It would separate encrypted OOXML from legacy binaries, but
  the combined message is never wrong today, and a new member breaks every exhaustive switch.

## Development

```bash
pnpm turbo run build check-types lint --filter=@sezzlee/ooxml-core
pnpm turbo run test --filter=@sezzlee/ooxml-core
```
