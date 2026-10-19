import { readFileSync } from "node:fs";

/** Original XlsxWriter 3.2.9 output; see rich-values.PROVENANCE.md. */
function fixture(name: string): Buffer {
  return Buffer.from(
    readFileSync(new URL(name, import.meta.url), "utf8"),
    "base64",
  );
}

export function richWorkbook(): Buffer {
  return fixture("rich-values.xlsx.base64");
}
export function linkedWorkbook(): Buffer {
  return fixture("linked-seattle.xlsx.base64");
}
export function richErrorsWorkbook(): Buffer {
  return fixture("rich-errors.xlsx.base64");
}
