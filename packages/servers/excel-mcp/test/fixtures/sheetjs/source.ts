import type * as XLSX from "@e965/xlsx";
import type { PartEntry, PartSource } from "@sezzlee/ooxml-core";

interface RawFile {
  readonly content?: unknown;
  readonly size?: number;
}

function rawBytes(content: unknown): Uint8Array | undefined {
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string") return Buffer.from(content, "utf8");
  return undefined;
}

/**
 * Guard: SheetJS attaches its decompressed entry table to the workbook under an
 * undeclared `files` property, reachable only through a cast, and injects its
 * own "\u0001Sh33tJ5" sentinel into it. That key is not an archive entry, so a
 * name carrying a control character is skipped and this stays a faithful view
 * of the container. This exists so the zip reader can be compared against
 * SheetJS's own over every fixture workbook; it is not the path the server takes.
 */
export function sheetJsSource(book: XLSX.WorkBook): PartSource {
  const files =
    (book as unknown as { files?: Record<string, RawFile> }).files ?? {};
  const entries: PartEntry[] = [];
  for (const [path, file] of Object.entries(files)) {
    if (path.endsWith("/")) continue;
    if ((path.codePointAt(0) ?? 0) < 0x20) continue;
    const bytes = rawBytes(file.content);
    if (bytes === undefined) continue;
    entries.push({ path, sizeBytes: file.size ?? bytes.length });
  }
  return {
    entries,
    read: (path) => rawBytes(files[path]?.content),
  };
}
