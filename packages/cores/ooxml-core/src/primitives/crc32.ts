const table = (() => {
  const entries = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    entries[index] = value >>> 0;
  }
  return entries;
})();

/**
 * The CRC-32 (ISO 3309, reflected polynomial 0xEDB88320) a zip directory
 * records for each entry's uncompressed bytes.
 *
 * @param previous the CRC of the bytes before these, so an entry read in
 *   chunks is checked chunk by chunk; 0 for the first.
 */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (const byte of bytes) {
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
