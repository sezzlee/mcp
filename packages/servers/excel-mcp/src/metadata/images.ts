import { limits } from "../platform/limits.js";
import type { MetadataLimitation } from "./support.js";
import type { AnchorCell, OoxmlImage } from "./spreadsheetml/drawing.js";
import { formatRectangle } from "../grid/range.js";

export interface SheetImage {
  readonly imageId: number;
  readonly anchor: "oneCell" | "twoCell" | "absolute";
  readonly range?: string;
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

/**
 * A `to` anchor sitting exactly on a cell boundary stops at the previous cell;
 * any offset into the cell means the picture covers it. An absolute anchor has
 * no cell anchor at all, so it gets no range rather than a fabricated one.
 */
function occupiedRange(
  from: AnchorCell | undefined,
  to: AnchorCell | undefined,
): string | undefined {
  if (from === undefined) {
    return undefined;
  }
  const top = from.row + 1;
  const left = from.column + 1;
  if (to === undefined) {
    return formatRectangle(top, left, top, left);
  }
  const bottom = to.rowOffset === 0 ? to.row : to.row + 1;
  const right = to.columnOffset === 0 ? to.column : to.column + 1;
  return formatRectangle(
    top,
    left,
    Math.max(top, bottom),
    Math.max(left, right),
  );
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
  const range = occupiedRange(image.from, image.to);
  const extension = part?.split(".").pop();
  const sizeBytes = entry?.sizeBytes;
  return {
    imageId: entry?.id ?? -1,
    anchor: image.anchor,
    ...(range === undefined ? {} : { range }),
    ...(extension === undefined ? {} : { extension }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(image.widthPx === undefined ? {} : { widthPx: image.widthPx }),
    ...(image.heightPx === undefined ? {} : { heightPx: image.heightPx }),
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
