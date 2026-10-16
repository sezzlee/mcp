import JSZip from "jszip";

const transitionalMain =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const strictMain = "http://purl.oclc.org/ooxml/spreadsheetml/main";
const relationshipsNs =
  "http://schemas.openxmlformats.org/package/2006/relationships";
export const officeRelationships =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const strictRelationships =
  "http://purl.oclc.org/ooxml/officeDocument/relationships";

export interface RawWorkbookOptions {
  readonly prefix?: string;
  readonly strict?: boolean;
  readonly sheetData: string;
  readonly sharedStrings?: string;
  readonly styles?: string;
  readonly beforeSheetData?: string;
  readonly afterSheetData?: string;
  readonly sheetRelationships?: string;
}

/**
 * Builds a one-sheet workbook from raw SpreadsheetML, so a test controls every
 * byte of the parts the reader sees.
 */
export async function rawWorkbook({
  prefix = "",
  strict = false,
  sheetData,
  sharedStrings,
  styles,
  beforeSheetData = "",
  afterSheetData = "",
  sheetRelationships,
}: RawWorkbookOptions): Promise<Uint8Array> {
  const q = prefix === "" ? "" : `${prefix}:`;
  const main = strict ? strictMain : transitionalMain;
  const markupRelationships = strict
    ? strictRelationships
    : officeRelationships;
  const xmlns = prefix === "" ? `xmlns="${main}"` : `xmlns:${prefix}="${main}"`;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="${relationshipsNs}"><Relationship Id="rId1" Type="${officeRelationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<${q}workbook ${xmlns} xmlns:r="${markupRelationships}"><${q}sheets><${q}sheet name="S" sheetId="1" r:id="rId1"/></${q}sheets></${q}workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="${relationshipsNs}"><Relationship Id="rId1" Type="${officeRelationships}/worksheet" Target="worksheets/sheet1.xml"/>` +
      (sharedStrings === undefined
        ? ""
        : `<Relationship Id="rId2" Type="${officeRelationships}/sharedStrings" Target="strings.xml"/>`) +
      (styles === undefined
        ? ""
        : `<Relationship Id="rId3" Type="${officeRelationships}/styles" Target="looks.xml"/>`) +
      "</Relationships>",
  );
  if (styles !== undefined) {
    zip.file(
      "xl/looks.xml",
      `<${q}styleSheet ${xmlns}>${styles}</${q}styleSheet>`,
    );
  }
  if (sharedStrings !== undefined) {
    zip.file("xl/strings.xml", `<${q}sst ${xmlns}>${sharedStrings}</${q}sst>`);
  }
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<${q}worksheet ${xmlns} xmlns:r="${markupRelationships}">${beforeSheetData}<${q}sheetData>${sheetData}</${q}sheetData>${afterSheetData}</${q}worksheet>`,
  );
  if (sheetRelationships !== undefined) {
    zip.file(
      "xl/worksheets/_rels/sheet1.xml.rels",
      `<Relationships xmlns="${relationshipsNs}">${sheetRelationships}</Relationships>`,
    );
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
