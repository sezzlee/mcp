import { invalidPresentation, presentationBudget } from "./presentation-xml.js";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let bit = 0; bit < 8; bit++)
    result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  return result >>> 0;
});

function dimensions(width: number, height: number): void {
  if (width < 1 || height < 1)
    invalidPresentation("Image dimensions must be positive.");
  if (width > 8192 || height > 8192 || width * height > 16_777_216)
    presentationBudget(
      "An embedded image exceeds 16,777,216 pixels or an 8,192-pixel side.",
    );
}

export function validatedImage(
  base64: string,
  mime: "image/png" | "image/jpeg",
): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  )
    invalidPresentation("Image data must be canonical base64.");
  const data = Buffer.from(base64, "base64");
  if (data.toString("base64") !== base64)
    invalidPresentation("Image data must be canonical base64.");
  if (data.length > 5 * 1024 * 1024)
    presentationBudget("An image exceeds 5 MiB.");
  if (mime === "image/png") {
    if (
      !data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      invalidPresentation("The image signature does not match its MIME type.");
    let cursor = 8,
      header = false,
      pixels = false,
      end = false;
    while (cursor + 12 <= data.length) {
      const size = data.readUInt32BE(cursor),
        type = data.subarray(cursor + 4, cursor + 8).toString("ascii");
      if (size > data.length - cursor - 12)
        invalidPresentation("A PNG chunk exceeds the image bytes.");
      let crc = 0xffffffff;
      for (const byte of data.subarray(cursor + 4, cursor + 8 + size))
        crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 255] ?? 0);
      if ((crc ^ 0xffffffff) >>> 0 !== data.readUInt32BE(cursor + 8 + size))
        invalidPresentation("A PNG chunk checksum is invalid.");
      if (!header && type !== "IHDR")
        invalidPresentation("The PNG header must be first.");
      if (type === "IHDR") {
        if (header || size !== 13)
          invalidPresentation("The PNG header is invalid.");
        dimensions(
          data.readUInt32BE(cursor + 8),
          data.readUInt32BE(cursor + 12),
        );
        header = true;
      }
      if (type === "IDAT") pixels = true;
      cursor += size + 12;
      if (type === "IEND") {
        end = size === 0 && cursor === data.length;
        break;
      }
    }
    if (!header || !pixels || !end)
      invalidPresentation("The PNG package is incomplete.");
  } else {
    if (
      data.length < 4 ||
      data[0] !== 255 ||
      data[1] !== 216 ||
      data.at(-2) !== 255 ||
      data.at(-1) !== 217
    )
      invalidPresentation("The image signature does not match its MIME type.");
    let cursor = 2,
      frame = false,
      scan = false;
    while (cursor + 4 <= data.length) {
      if (data[cursor++] !== 255)
        invalidPresentation("The JPEG marker sequence is invalid.");
      while (data[cursor] === 255) cursor++;
      const marker = data[cursor++];
      if (cursor + 2 > data.length)
        invalidPresentation("A JPEG marker is incomplete.");
      const size = data.readUInt16BE(cursor);
      if (size < 2 || cursor + size > data.length)
        invalidPresentation("A JPEG segment exceeds the image bytes.");
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (frame || size < 8)
          invalidPresentation("The JPEG frame is invalid.");
        dimensions(
          data.readUInt16BE(cursor + 5),
          data.readUInt16BE(cursor + 3),
        );
        frame = true;
      }
      if (marker === 0xda) {
        scan = true;
        break;
      }
      cursor += size;
    }
    if (!frame || !scan)
      invalidPresentation(
        "The JPEG frame/scan profile is unsupported or incomplete.",
      );
  }
  return data;
}
