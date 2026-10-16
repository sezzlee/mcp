const endSignature = 0x06054b50;
const zip64LocatorSignature = 0x07064b50;
const zip64EndSignature = 0x06064b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;
const zip64ExtraId = 0x0001;
const overflow32 = 0xffffffff;
const maxCommentBytes = 0xffff;
/**
 * Guard: part names are printable ASCII or refused before this runs, so a
 * byte-for-byte decode yields the same string `fflate` keys its entries by.
 */
const latin1 = new TextDecoder("latin1");

export interface DirectoryRecord {
  readonly crc32: number;
  readonly localOffset: number;
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
}

function u64(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) + u32(bytes, at + 4) * 0x1_0000_0000;
}

function endRecordAt(bytes: Uint8Array): number | undefined {
  const lowest = Math.max(0, bytes.length - 22 - maxCommentBytes);
  for (let at = bytes.length - 22; at >= lowest; at -= 1) {
    if (u32(bytes, at) === endSignature) return at;
  }
  return undefined;
}

function directoryOffset(bytes: Uint8Array, end: number): number | undefined {
  const offset = u32(bytes, end + 16);
  if (offset !== overflow32) return offset;
  const locator = end - 20;
  if (locator < 0 || u32(bytes, locator) !== zip64LocatorSignature) {
    return undefined;
  }
  const record = u64(bytes, locator + 8);
  if (u32(bytes, record) !== zip64EndSignature) return undefined;
  return u64(bytes, record + 48);
}

/**
 * The local header offset of a central entry: the 32-bit field, or, when that
 * overflows, the ZIP64 extra field's copy, which follows the uncompressed and
 * compressed sizes of the entry that overflowed too (APPNOTE 4.5.3).
 */
function localOffsetOf(bytes: Uint8Array, at: number): number | undefined {
  const offset = u32(bytes, at + 42);
  if (offset !== overflow32) return offset;
  const nameLength = u16(bytes, at + 28);
  const extraLength = u16(bytes, at + 30);
  let field = at + 46 + nameLength;
  const last = field + extraLength;
  while (field + 4 <= last) {
    const id = u16(bytes, field);
    const size = u16(bytes, field + 2);
    if (id === zip64ExtraId) {
      let skip = 0;
      if (u32(bytes, at + 24) === overflow32) skip += 8;
      if (u32(bytes, at + 20) === overflow32) skip += 8;
      return skip + 8 <= size ? u64(bytes, field + 4 + skip) : undefined;
    }
    field += 4 + size;
  }
  return undefined;
}

/**
 * Reads, for each entry the central directory lists, the CRC-32 it records and
 * where its local header starts. `fflate` exposes neither, and checks no CRC.
 *
 * @returns undefined when the directory cannot be walked; the caller has
 *   already indexed the same directory through `fflate`, so that means damage.
 */
export function readDirectory(
  bytes: Uint8Array,
): ReadonlyMap<string, DirectoryRecord> | undefined {
  const end = endRecordAt(bytes);
  if (end === undefined) return undefined;
  let at = directoryOffset(bytes, end);
  if (at === undefined) return undefined;
  const records = new Map<string, DirectoryRecord>();
  while (at + 46 <= bytes.length && u32(bytes, at) === centralSignature) {
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const name = latin1.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const localOffset = localOffsetOf(bytes, at);
    if (localOffset === undefined) return undefined;
    records.set(name, { crc32: u32(bytes, at + 16), localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

/**
 * Guard: the local header must open with its signature and repeat the name
 * the central directory gives the entry. `fflate` trusts the directory alone,
 * and an archive whose two headers disagree is the shape of a parser
 * differential: a second reader that walks local headers sees other content.
 */
export function localHeaderAgrees(
  bytes: Uint8Array,
  name: string,
  record: DirectoryRecord,
): boolean {
  const at = record.localOffset;
  if (at + 30 > bytes.length || u32(bytes, at) !== localSignature) return false;
  const nameLength = u16(bytes, at + 26);
  return latin1.decode(bytes.subarray(at + 30, at + 30 + nameLength)) === name;
}
