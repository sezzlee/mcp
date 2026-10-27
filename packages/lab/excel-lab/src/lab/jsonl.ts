import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";

/** Streams the non-blank lines of a JSONL file; a missing file has none. */
export async function* lines(path: string): AsyncGenerator<string> {
  try {
    await access(path);
  } catch {
    return;
  }
  for await (const line of createInterface({
    input: createReadStream(path, "utf8"),
  }))
    if (line.trim() !== "") yield line;
}
