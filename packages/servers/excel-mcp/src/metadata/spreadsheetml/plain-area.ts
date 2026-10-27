import { asciiUpper } from "@sezzlee/file-core";

const singleArea =
  /^(?:'((?:[^']|'')+)'|([^'!:\s[\]]+))!\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]*))?$/;

export interface PlainArea {
  readonly sheetName: string;
  readonly range: string;
}

export function plainAreaOf(ref: string): PlainArea | undefined {
  const match = singleArea.exec(ref.trim());
  const sheetName = match?.[1]?.replace(/''/g, "'") ?? match?.[2];
  if (match === null || sheetName === undefined) return undefined;
  const range = `${match[3]}${match[4]}${match[5] === undefined ? "" : `:${match[5]}${match[6]}`}`;
  return { sheetName, range: asciiUpper(range) };
}
