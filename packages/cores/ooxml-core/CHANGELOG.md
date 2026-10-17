# Changelog

## 0.2.0

### Compatibility changes

- `OpcPackage` gains a required `scanPart(path, visitor)`, which scans a part as it is inflated and decoded and keeps none of its text. `XmlNode` gains a required `namespaceOf(prefix)`. A consumer that implements either type itself must add them. `PartSource` gains an optional `stream(path, onChunk)`; a source without it is read whole.
- Every part read is checked against the CRC-32 the central directory records, and its local header must agree with the central directory. A damaged archive, or one whose two headers disagree, is refused with `corrupt_package`. A part that inflates past its declared size is stopped at the first byte over.
- A part that is not valid UTF-8 or UTF-16, or that declares UTF-16 without a byte order mark, is refused with `corrupt_package` instead of being read with replacement characters. A declared code page that is not read stays `unsupported_part_encoding`.
- `saxes` is no longer a runtime dependency. Parts are read by the package's own XML tokenizer (`src/xml/tokenizer.ts`), 2.2 times faster on the largest corpus parts with the same events. Text in a CDATA section, which the `saxes` reader dropped, is now read. `fflate` is the only runtime dependency.

### Added

- `selectAlternateContent` applies Markup Compatibility: it chooses one branch of an `mc:AlternateContent` element.

### Reading

- A relationships part that is not well-formed is named in its own refusal; the part it belongs to was named instead.

## 0.1.0

First published version.
