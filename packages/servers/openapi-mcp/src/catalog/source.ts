import type { BoundedFetch } from "../net/fetch.js";
import type { DocumentRead, DocumentValidators } from "./reload.js";

export interface DocumentRequest {
  readonly fetch: BoundedFetch;
  readonly url: URL;
  readonly validators: DocumentValidators;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/**
 * Reads a document over http(s), conditionally when validators from an earlier answer are given.
 * A `304` counts as unchanged only for a conditional request; any other answer but `200` throws.
 */
export async function fetchDocument(
  request: DocumentRequest,
): Promise<DocumentRead> {
  const { etag, lastModified } = request.validators;
  const response = await request.fetch(
    {
      method: "GET",
      url: request.url,
      headers: {
        accept: "application/json, application/yaml;q=0.9, */*;q=0.1",
        ...(etag === undefined ? {} : { "if-none-match": etag }),
        ...(lastModified === undefined
          ? {}
          : { "if-modified-since": lastModified }),
      },
    },
    AbortSignal.timeout(request.timeoutMs),
    request.maxBytes,
  );
  const conditional = etag !== undefined || lastModified !== undefined;
  if (conditional && response.status === 304) {
    return { kind: "unchanged" };
  }
  if (response.status !== 200 || response.body === undefined) {
    throw new Error(
      `sezzlee-openapi: ${request.url.href} answered ${String(response.status)}.`,
    );
  }
  const answeredEtag = response.headers["etag"];
  const answeredLastModified = response.headers["last-modified"];
  return {
    kind: "document",
    text: response.body,
    validators: {
      ...(answeredEtag === undefined ? {} : { etag: answeredEtag }),
      ...(answeredLastModified === undefined
        ? {}
        : { lastModified: answeredLastModified }),
    },
  };
}
