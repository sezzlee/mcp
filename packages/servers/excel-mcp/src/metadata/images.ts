import { limits } from "../platform/limits.js";
import { truncateWellFormed } from "@sezzlee/file-core";
import type { MetadataLimitation } from "./support.js";
import { reportedPlacement } from "./placement.js";
import type { OoxmlImage } from "./spreadsheetml/drawing.js";

export interface SheetImage {
  readonly imageId: number;
  readonly anchor: "oneCell" | "twoCell" | "absolute" | "inCell";
  readonly range?: string;
  readonly cell?: string;
  readonly extension?: string;
  readonly sizeBytes?: number;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly editAs?: string;
  readonly hyperlink?: string;
  readonly tooltip?: string;
  readonly altText?: string;
  readonly altTextTruncatedFrom?: number;
  readonly decorative?: boolean;
}

export interface ImageReport {
  readonly complete: false;
  readonly limitations: readonly MetadataLimitation[];
  readonly sheet: string;
  readonly count: number;
  readonly images: readonly SheetImage[];
  readonly truncated: boolean;
  readonly truncationReason?: "maxImagesPerSheet";
  readonly hint?: string;
}

export interface MediaEntry {
  readonly id: number;
  readonly sizeBytes?: number;
}

function describe(
  image: OoxmlImage,
  media: ReadonlyMap<string, MediaEntry>,
): SheetImage {
  const part = image.mediaPart;
  const entry = part === undefined ? undefined : media.get(part);
  const placement =
    image.anchor === "inCell"
      ? { anchor: image.anchor, cell: image.cell }
      : reportedPlacement(image);
  const extension = part?.split(".").pop();
  const sizeBytes = entry?.sizeBytes;
  return {
    imageId: entry?.id ?? -1,
    ...placement,
    ...(extension === undefined ? {} : { extension }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(image.anchor === "inCell" || image.editAs === undefined
      ? {}
      : { editAs: image.editAs }),
    ...(image.hyperlink === undefined ? {} : { hyperlink: image.hyperlink }),
    ...(image.tooltip === undefined ? {} : { tooltip: image.tooltip }),
    ...(image.altText === undefined
      ? {}
      : { altText: truncateWellFormed(image.altText, limits.maxStringChars) }),
    ...(image.altText !== undefined &&
    image.altText.length > limits.maxStringChars
      ? { altTextTruncatedFrom: image.altText.length }
      : {}),
    ...(image.decorative === undefined ? {} : { decorative: image.decorative }),
  };
}

export function collectImages(
  sheet: string,
  images: readonly OoxmlImage[],
  media: ReadonlyMap<string, MediaEntry>,
): ImageReport {
  const truncated = images.length > limits.maxImagesPerSheet;
  const kept = truncated ? images.slice(0, limits.maxImagesPerSheet) : images;
  return {
    sheet,
    count: images.length,
    images: kept.map((image) => describe(image, media)),
    complete: false,
    limitations: [],
    truncated,
    ...(truncated
      ? {
          truncationReason: "maxImagesPerSheet" as const,
          hint: `${images.length} images are anchored on this sheet; the first ${limits.maxImagesPerSheet} are listed. Call describe_workbook for the count on every sheet.`,
        }
      : {}),
  };
}
