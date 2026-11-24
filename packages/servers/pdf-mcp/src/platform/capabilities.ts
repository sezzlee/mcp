export interface PdfCapabilities {
  readonly pageMarkdown: boolean;
  readonly literalSearch: boolean;
  readonly perPageOcrDetection: boolean;
  readonly ocr: boolean;
  readonly pageImages: boolean;
  readonly tableExtraction: boolean;
  readonly regionExtraction: boolean;
  readonly textPositions: boolean;
  readonly passwordProtected: boolean;
  readonly write: boolean;
}

/** Reports which provider-backed features are available on this server. */
export function capabilitiesWith(
  ocr: boolean,
  pageImages: boolean = ocr,
): PdfCapabilities {
  return { ...capabilities, ocr, pageImages };
}

export const capabilities: PdfCapabilities = {
  pageMarkdown: true,
  literalSearch: true,
  perPageOcrDetection: true,
  ocr: false,
  pageImages: false,
  tableExtraction: false,
  regionExtraction: false,
  textPositions: false,
  passwordProtected: false,
  write: false,
};
