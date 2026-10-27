import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

export function createResultId(): string {
  return `result_${randomUUID()}`;
}

export function resultUtf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
