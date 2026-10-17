import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

const benchedPart = /^xl\/(?:worksheets\/[^/]+|sharedStrings)\.xml$/;

export interface DecodedPart {
  readonly name: string;
  readonly xml: string;
}

/**
 * The worksheet and shared string parts of one workbook, inflated and decoded
 * up front so a timed run measures the parser alone.
 */
export async function decodedParts(
  path: string,
): Promise<readonly DecodedPart[]> {
  const files = unzipSync(await readFile(path), {
    filter: (file) => benchedPart.test(file.name),
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return Object.entries(files)
    .map(([name, bytes]) => ({ name, xml: decoder.decode(bytes) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}
