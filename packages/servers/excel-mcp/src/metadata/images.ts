import { limits } from "../platform/limits.js";
import type { MetadataLimitation } from "./support.js";
import { reportedPlacement } from "./placement.js";
import type { OoxmlImage } from "./spreadsheetml/drawing.js";

export interface SheetImage {
  readonly imageId: number;
  readonly anchor: "oneCell" | "twoCell" | "absolute";
  readonly range?: string;
  readonly cell?: string;
  readonly extension?: string;
  readonly sizeBytes?: number;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly editAs?: string;
  readonly hyperlink?: string;
  readonly tooltip?: string;
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
  const { anchor, range, cell, widthPx, heightPx } = reportedPlacement(image);
  const extension = part?.split(".").pop();
  const sizeBytes = entry?.sizeBytes;
  return {
    imageId: entry?.id ?? -1,
    anchor,
    ...(range === undefined ? {} : { range }),
    ...(cell === undefined ? {} : { cell }),
    ...(extension === undefined ? {} : { extension }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(widthPx === undefined ? {} : { widthPx }),
    ...(heightPx === undefined ? {} : { heightPx }),
    ...(image.editAs === undefined ? {} : { editAs: image.editAs }),
    ...(image.hyperlink === undefined ? {} : { hyperlink: image.hyperlink }),
    ...(image.tooltip === undefined ? {} : { tooltip: image.tooltip }),
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
