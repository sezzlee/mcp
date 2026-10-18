export type DelimiterName = "comma" | "semicolon" | "tab" | "pipe";

export const encodingNames = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "windows-1254",
  "iso-8859-9",
  "windows-1252",
  "windows-1251",
  "windows-1256",
  "shift_jis",
  "gb18030",
  "big5",
  "euc-kr",
] as const;

export type EncodingName = (typeof encodingNames)[number];

export const delimiterNames: Readonly<Record<DelimiterName, string>> = {
  comma: ",",
  semicolon: ";",
  tab: "\t",
  pipe: "|",
};

export interface CsvOptions {
  readonly delimiter?: DelimiterName;
  readonly encoding?: EncodingName;
}
