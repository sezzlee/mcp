import {
  clampJsonField,
  createPageBudget,
  imageResult,
  json,
  measureJson,
  type Fingerprint,
} from "@sezzlee/file-core";

import { assertSelectablePages } from "../engine/pages.js";
import {
  createPdfDocumentStore,
  readDocumentBytes,
  type LoadedPdf,
  type PdfDocumentStore,
} from "../document/store.js";
import {
  pageAt,
  resolvedPagesOf,
  type ResolvedPage,
} from "../document/extraction.js";
import { applyOcr, createOcrCache, type OcrCache } from "../ocr/apply.js";
import type { OcrBinding, PageImageBinding } from "../ocr/port.js";
import { pageImageSettings, renderPageImages } from "../ocr/view.js";
import { capabilitiesWith } from "../platform/capabilities.js";
import { SezzleePdfError } from "../platform/errors.js";
import {
  createDeadline,
  createGate,
  holdUntilSettled,
  type Gate,
} from "../platform/gate.js";
import { limits, modePolicy } from "../platform/limits.js";
import {
  listDocuments,
  resolveDocumentPath,
  type DocumentRoot,
  type SandboxedPath,
} from "../platform/paths.js";
import {
  resumeAt,
  scanLiteral,
  type LiteralMatch,
  type MatchMode,
  type ScanOptions,
  type ScanResume,
} from "../search/literal.js";
import {
  assertFresh,
  assertSameOptions,
  assertSameText,
  cursorTtlMs,
  decodeCursor,
  encodePosition,
  optionsHash,
  pageDigest,
  type PageAnchor,
  type PdfPosition,
} from "./cursor.js";
import type { ToolHandlers } from "./definitions.js";
import { guard } from "./guard.js";

export interface PdfHandlerDeps {
  readonly store?: PdfDocumentStore;
  readonly ocr?: OcrBinding;
  readonly pageImages?: PageImageBinding;
  readonly maxConcurrentListings?: number;
  readonly maxConcurrentExtractions?: number;
  /**
   * The budget one response page is assembled against. Lowering it is how the
   * suite reaches the continuation path: a real PDF page rarely holds half a
   * megabyte of text, so the path would otherwise never be exercised. The
   * unbypassable gate in `guard()` still applies on top of this.
   */
  readonly maxPayloadBytes?: number;
  readonly ocrCache?: OcrCache;
}

interface PageEntry {
  readonly page: number;
  readonly markdown: string;
  readonly needsOcr: boolean;
  readonly empty: boolean;
  readonly source: "text" | "ocr";
  readonly ocrReason?: string;
  readonly ocrConfidence?: number;
  readonly truncatedMarkdown?: true;
  /** Characters of this page delivered before this response. */
  readonly markdownOffset?: number;
}

function entryFor(pages: readonly ResolvedPage[], page: number): PageEntry {
  const found = pageAt(pages, page);
  if (found === undefined) {
    throw new SezzleePdfError(
      "invalid_argument",
      `The document has ${String(pages.length)} pages; page ${String(page)} does not exist.`,
    );
  }
  return {
    page: found.page,
    markdown: found.markdown,
    needsOcr: found.needsOcr,
    /**
     * Guard: empty is only true for a page the engine trusted and found blank.
     * Without the needsOcr term a scanned page would be indistinguishable from
     * a genuinely empty one, which is the failure this field exists to prevent.
     */
    empty: !found.needsOcr && found.markdown.trim() === "",
    source: found.source,
    ...(found.ocrReason === undefined ? {} : { ocrReason: found.ocrReason }),
    ...(found.ocrConfidence === undefined
      ? {}
      : { ocrConfidence: found.ocrConfidence }),
  };
}

function expiry(): number {
  return Date.now() + cursorTtlMs;
}

function pagesFrom(first: number, pageCount: number): number[] {
  return Array.from(
    { length: Math.max(0, pageCount - first + 1) },
    (_unused, index) => first + index,
  );
}

const worstDigest = "0".repeat(16);

function anchorOf(anchor: PageAnchor): PageAnchor {
  return anchor.c === undefined ? {} : { c: anchor.c, h: anchor.h };
}

export function createHandlers(
  root: DocumentRoot,
  deps: PdfHandlerDeps = {},
): ToolHandlers {
  const store = deps.store ?? createPdfDocumentStore(root.real);
  const maxPayloadBytes = deps.maxPayloadBytes ?? limits.maxPayloadBytes;
  const imageBinding =
    deps.pageImages ??
    (deps.ocr === undefined ? undefined : { rasterizer: deps.ocr.rasterizer });
  const pageImages =
    imageBinding === undefined ? undefined : pageImageSettings(imageBinding);
  const listings: Gate = createGate(
    deps.maxConcurrentListings ?? limits.maxConcurrentListings,
    () => {
      throw new SezzleePdfError(
        "resource_limit",
        "Too many listings are already running.",
        "Retry once an earlier list_documents call finishes.",
      );
    },
  );
  const extractions: Gate = createGate(
    deps.maxConcurrentExtractions ?? limits.maxConcurrentExtractions,
    () => {
      throw new SezzleePdfError(
        "resource_limit",
        "Too many documents are already being read.",
        "Retry once an earlier read finishes; PDF extraction is memory-bound. A read that exceeded its budget keeps its slot until it ends, and only a server restart reclaims one that never does.",
      );
    },
  );

  /**
   * Guard: the gate is taken before the bytes are read, so a waiting request
   * never pins a snapshot. It is also the only real bound on concurrent native
   * work — an extraction already running on the libuv pool cannot be cancelled.
   */
  const open = async (
    raw: string,
  ): Promise<{ path: SandboxedPath; loaded: LoadedPdf }> => {
    const path: SandboxedPath = await resolveDocumentPath(root, raw);
    const release = extractions.enter();
    const work = store.load(path);
    holdUntilSettled(work, release);
    const deadline = createDeadline(
      limits.maxExtractMs,
      () =>
        new SezzleePdfError(
          "resource_limit",
          `Reading '${raw}' exceeded the ${String(limits.maxExtractMs)} ms extraction budget.`,
          "Read a smaller document; the work already started is not cancelled, and its slot stays taken until it finishes.",
        ),
    );
    return { path, loaded: await deadline.run(work) };
  };

  const ocrCache: OcrCache = deps.ocrCache ?? createOcrCache();
  const rasterRuns: Gate = createGate(limits.maxConcurrentOcr, () => {
    throw new SezzleePdfError(
      "resource_limit",
      "An OCR or page rendering run is already in progress.",
      "Retry once it finishes. A run that exceeded its budget keeps its slot until it ends, and only a server restart reclaims one that never does.",
    );
  });

  /**
   * Resolves the pages a tool will report. Without ocr the engine's extraction
   * is reported as-is; with it, pages the text layer could not answer are sent
   * to the injected ports.
   *
   * Guard: asking for OCR with no provider bound is an error, never a silent
   * fallback to the untranscribed pages. A caller that paid for the flag must
   * not be told "no matches" by a document nobody transcribed.
   */
  const resolve = async (
    path: SandboxedPath,
    loaded: LoadedPdf,
    wanted: readonly number[],
    requested: boolean,
  ): Promise<{
    pages: readonly ResolvedPage[];
    pending: ReadonlySet<number>;
    ocr?: {
      provider: string;
      recognizedPages: readonly number[];
      truncated: boolean;
    };
  }> => {
    if (!requested) {
      return {
        pages: resolvedPagesOf(loaded.pages),
        pending: new Set<number>(),
      };
    }
    if (deps.ocr === undefined) {
      throw new SezzleePdfError(
        "ocr_unavailable",
        "No OCR provider is configured, so pages without a text layer cannot be transcribed.",
        "Call describe_document and read capabilities.ocr, or omit ocr to read the text layer alone.",
      );
    }
    const binding = deps.ocr;
    const timeoutMs = Math.min(
      binding.timeoutMs ?? limits.maxOcrMs,
      limits.maxOcrMs,
    );
    const release = rasterRuns.enter();
    const deadline = createDeadline(
      timeoutMs,
      () =>
        new SezzleePdfError(
          "ocr_failed",
          `OCR exceeded the ${String(timeoutMs)} ms budget.`,
          "Request fewer pages, or configure a faster provider; the run already started keeps its slot until it finishes.",
        ),
    );
    const work = (async () => {
      const bytes = await readDocumentBytes(root, path, loaded.stamp);
      return applyOcr(binding, ocrCache, {
        bytes,
        stamp: loaded.stamp,
        pages: loaded.pages,
        wanted,
        signal: deadline.signal,
      });
    })();
    holdUntilSettled(work, release);
    {
      const outcome = await deadline.run(work);
      return {
        pages: outcome.pages,
        pending: new Set(outcome.pendingPages),
        ocr: {
          provider: outcome.provider,
          recognizedPages: outcome.recognizedPages,
          truncated: outcome.truncated,
        },
      };
    }
  };

  const cursorFor = (stamp: Fingerprint, position: PdfPosition): string =>
    encodePosition(stamp, position);

  return {
    list_documents: guard(
      { root: root.real, tool: "list_documents" },
      async (args) => {
        const release = listings.enter();
        try {
          const listing = await listDocuments(root, {
            ...(args.subdirectory === undefined
              ? {}
              : { subdirectory: args.subdirectory }),
            ...(args.pattern === undefined ? {} : { pattern: args.pattern }),
            maxResults: args.maxResults ?? limits.defaultListResults,
            mode: modePolicy,
          });
          return json({ root: root.real, ...listing });
        } finally {
          release();
        }
      },
    ),

    describe_document: guard(
      { root: root.real, tool: "describe_document" },
      async (args) => {
        const { loaded } = await open(args.filePath);
        return json({
          filePath: args.filePath,
          pageCount: loaded.pageCount,
          documentType: loaded.documentType,
          classificationConfidence: loaded.classificationConfidence,
          pagesNeedingOcr: loaded.pagesNeedingOcr,
          pagesWithoutText: loaded.pages
            .filter((page) => page.needsOcr || page.markdown.trim() === "")
            .map((page) => page.page),
          needsOcr: loaded.pagesNeedingOcr.length > 0,
          pagesWithTables: loaded.pagesWithTables,
          capabilities: capabilitiesWith(
            deps.ocr !== undefined,
            pageImages !== undefined,
          ),
          ...(deps.ocr === undefined
            ? {}
            : { ocrProvider: deps.ocr.provider.name }),
          limits: {
            maxPages: limits.maxPages,
            maxPdfBytes: limits.maxPdfBytes,
            maxReadPages: limits.maxReadPages,
            ...(pageImages === undefined
              ? {}
              : { maxViewPages: pageImages.maxPagesPerCall }),
          },
          sizeBytes: loaded.sizeBytes,
          modifiedAt: loaded.modifiedAt,
          mode: loaded.mode,
        });
      },
    ),

    view_pages: guard(
      {
        root: root.real,
        tool: "view_pages",
        maxImagePayloadBytes: limits.maxViewImagePayloadBytes,
      },
      async ({ filePath, pages }, _tool, signal) => {
        if (pageImages === undefined) {
          throw new SezzleePdfError(
            "pages_unavailable",
            "No page rasterizer is configured.",
            "Configure a page-image binding to use view_pages.",
          );
        }
        if (pages.length < 1 || pages.length > pageImages.maxPagesPerCall) {
          throw new SezzleePdfError(
            "invalid_argument",
            `Request between 1 and ${String(pageImages.maxPagesPerCall)} pages at a time.`,
          );
        }
        if (new Set(pages).size !== pages.length) {
          throw new SezzleePdfError(
            "invalid_argument",
            "pages must contain distinct page numbers.",
          );
        }
        const { path, loaded } = await open(filePath);
        assertSelectablePages(pages, loaded.pageCount);

        const release = rasterRuns.enter();
        const deadline = createDeadline(
          pageImages.timeoutMs,
          () =>
            new SezzleePdfError(
              "pages_failed",
              `Page rendering exceeded the ${String(pageImages.timeoutMs)} ms budget.`,
              "Request fewer pages or configure a lower DPI.",
            ),
        );
        const renderSignal =
          signal === undefined
            ? deadline.signal
            : AbortSignal.any([deadline.signal, signal]);
        const work = (async () => {
          const bytes = await readDocumentBytes(root, path, loaded.stamp);
          return renderPageImages(pageImages, bytes, pages, renderSignal);
        })();
        holdUntilSettled(work, release);
        const rendered = await deadline.run(work);
        return imageResult(
          `Showing ${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")}.`,
          rendered.map(({ image, mediaType }) => ({
            bytes: image,
            mimeType: mediaType,
          })),
        );
      },
    ),

    read_pages: guard({ root: root.real, tool: "read_pages" }, async (args) => {
      const maxPages = args.maxPages ?? limits.defaultReadPages;
      /**
       * Guard: page size is deliberately not part of the cursor identity. The
       * resume position is a page number, so walking with a different maxPages
       * still yields every page exactly once and in order. ocr is: it decides
       * which text a page answers with, and a resume offset measured in one
       * mode's text means nothing in the other's.
       */
      const hash = optionsHash({ tool: "read", ocr: args.ocr === true });
      if (args.cursor !== undefined && args.pages !== undefined) {
        throw new SezzleePdfError(
          "invalid_argument",
          "cursor cannot be combined with pages.",
          "The cursor already carries the pages and the position the previous response stopped at.",
        );
      }
      const cursor =
        args.cursor === undefined
          ? undefined
          : decodeCursor(args.cursor, "read");
      if (cursor !== undefined) assertSameOptions(cursor, hash);

      const { path, loaded } = await open(args.filePath);
      if (cursor !== undefined) assertFresh(cursor, loaded.stamp);

      const chosen = cursor?.s ?? args.pages;
      if (chosen !== undefined) {
        assertSelectablePages(chosen, loaded.pageCount);
      }
      const selection =
        chosen === undefined
          ? pagesFrom(cursor?.p ?? 1, loaded.pageCount)
          : [...chosen];

      const resolved = await resolve(
        path,
        loaded,
        selection.slice(0, maxPages),
        args.ocr === true,
      );

      const reserveBytes =
        measureJson({
          filePath: args.filePath,
          pageCount: loaded.pageCount,
          returnedPages: maxPages,
          pages: [],
          truncated: true,
          truncationReason: "maxPayloadBytes",
          nextCursor: cursorFor(loaded.stamp, {
            t: "read",
            o: hash,
            x: expiry(),
            p: loaded.pageCount,
            ...(chosen === undefined
              ? {}
              : { s: chosen.map(() => loaded.pageCount) }),
            c: Number.MAX_SAFE_INTEGER,
            h: worstDigest,
          }),
          pagesNeedingOcr: loaded.pagesNeedingOcr,
          mode: loaded.mode,
        }) + 64;
      const budget = createPageBudget({
        maxBytes: maxPayloadBytes,
        reserveBytes,
      });

      const entries: PageEntry[] = [];
      let truncationReason: "maxPages" | "maxPayloadBytes" | undefined;
      let next: ({ readonly index: number } & PageAnchor) | undefined;

      for (const [index, page] of selection.entries()) {
        if (entries.length >= maxPages) {
          truncationReason = "maxPages";
          next = { index };
          break;
        }
        const whole = entryFor(resolved.pages, page);
        const offset = index === 0 ? (cursor?.c ?? 0) : 0;
        if (offset > 0) assertSameText(cursor?.h, page, whole.markdown);
        const entry: PageEntry =
          offset === 0
            ? whole
            : {
                ...whole,
                markdown: whole.markdown.slice(offset),
                markdownOffset: offset,
              };
        if (budget.admit(entry)) {
          entries.push(entry);
          continue;
        }
        truncationReason = "maxPayloadBytes";
        next = { index };
        if (entries.length > 0) {
          break;
        }
        /**
         * Guard: the first page is clamped rather than refused, and the cursor
         * resumes inside it. Advancing to the next page here is what made the
         * clipped tail unreachable by any call.
         */
        const room = maxPayloadBytes - reserveBytes;
        const kept = clampJsonField(entry.markdown, room, (markdown) => ({
          ...entry,
          markdown,
          truncatedMarkdown: true,
        }));
        if (kept.length === 0) {
          throw new SezzleePdfError(
            "resource_limit",
            `No part of page ${String(page)} fits the ${String(maxPayloadBytes)} byte response budget.`,
            "Read a document with smaller pages.",
          );
        }
        entries.push({ ...entry, markdown: kept, truncatedMarkdown: true });
        const delivered = offset + kept.length;
        next =
          delivered >= whole.markdown.length
            ? { index: index + 1 }
            : { index, c: delivered, h: pageDigest(whole.markdown) };
        break;
      }

      const rest = next === undefined ? [] : selection.slice(next.index);
      const [nextPage] = rest;
      return json({
        filePath: args.filePath,
        pageCount: loaded.pageCount,
        returnedPages: entries.length,
        pages: entries,
        pagesNeedingOcr: resolved.pages
          .filter((page) => page.needsOcr)
          .map((page) => page.page),
        ...(resolved.ocr === undefined ? {} : { ocr: resolved.ocr }),
        truncated: truncationReason !== undefined,
        ...(truncationReason === undefined ? {} : { truncationReason }),
        ...(next === undefined || nextPage === undefined
          ? {}
          : {
              nextCursor: cursorFor(loaded.stamp, {
                t: "read",
                o: hash,
                x: expiry(),
                p: nextPage,
                ...(chosen === undefined ? {} : { s: rest }),
                ...anchorOf(next),
              }),
            }),
        mode: loaded.mode,
      });
    }),

    find_in_document: guard(
      { root: root.real, tool: "find_in_document" },
      async (args) => {
        const matchMode: MatchMode = args.matchMode ?? "contains";
        const caseSensitive = args.caseSensitive ?? true;
        const maxResults = args.maxResults ?? limits.defaultFindResults;
        /**
         * Guard: query, matchMode and caseSensitive decide which matches exist and
         * so must survive a resume. maxResults only decides how many are handed
         * back per call, and the resume position is a (page, ordinal) pair, so
         * changing it mid-walk can neither skip nor repeat a match.
         */
        const hash = optionsHash({
          query: args.query,
          matchMode,
          caseSensitive,
          ocr: args.ocr === true,
        });
        const cursor =
          args.cursor === undefined
            ? undefined
            : decodeCursor(args.cursor, "find");
        if (cursor !== undefined) assertSameOptions(cursor, hash);

        const { path, loaded } = await open(args.filePath);
        if (cursor !== undefined) assertFresh(cursor, loaded.stamp);

        /**
         * Guard: only the pages from the cursor on are offered for OCR. The scan
         * never reads the pages behind it, and offering them again once their
         * transcriptions leave the cache spends every batch behind the cursor,
         * so the walk stops advancing on any document larger than the cache.
         */
        const resolved = await resolve(
          path,
          loaded,
          pagesFrom(cursor?.p ?? 1, loaded.pageCount),
          args.ocr === true,
        );
        if (cursor !== undefined && cursor.i > 0) {
          assertSameText(
            cursor.h,
            cursor.p,
            pageAt(resolved.pages, cursor.p)?.markdown ?? "",
          );
        }

        const scanOptions: ScanOptions = {
          query: args.query,
          matchMode,
          caseSensitive,
          maxResults,
          pending: resolved.pending,
          ...(cursor === undefined
            ? {}
            : {
                from: {
                  page: cursor.p,
                  ordinal: cursor.i,
                  unsearchableBehind: cursor.u,
                },
              }),
        };
        const scan = scanLiteral(resolved.pages, scanOptions);

        const reserveBytes =
          measureJson({
            filePath: args.filePath,
            query: args.query,
            matches: [],
            searchedPages: loaded.pageCount,
            pageCount: loaded.pageCount,
            unsearchablePages: scan.unsearchablePages,
            pagesNeedingOcr: loaded.pagesNeedingOcr,
            coverageComplete: false,
            truncated: true,
            note: "",
            nextCursor: cursorFor(loaded.stamp, {
              t: "find",
              o: hash,
              x: expiry(),
              p: loaded.pageCount,
              i: 0,
              u: loaded.pageCount,
              h: worstDigest,
            }),
          }) + 256;
        const budget = createPageBudget({
          maxBytes: maxPayloadBytes,
          reserveBytes,
        });

        const admitted: LiteralMatch[] = [];
        let cut: ScanResume | undefined;
        for (const match of scan.matches) {
          if (budget.admit(match)) {
            admitted.push(match);
            continue;
          }
          cut = resumeAt(resolved.pages, scanOptions, {
            page: match.page,
            ordinal: match.ordinal,
          });
          break;
        }
        const next = cut ?? scan.next;
        const coverageComplete =
          scan.unsearchablePages === 0 && next === undefined;

        return json({
          filePath: args.filePath,
          query: args.query,
          matchMode,
          matches: admitted,
          searchedPages: scan.searchedPages,
          pageCount: loaded.pageCount,
          unsearchablePages: scan.unsearchablePages,
          pagesNeedingOcr: resolved.pages
            .filter((page) => page.needsOcr)
            .map((page) => page.page),
          ...(resolved.ocr === undefined ? {} : { ocr: resolved.ocr }),
          coverageComplete,
          truncated: next !== undefined,
          ...(scan.unsearchablePages > 0
            ? {
                note: `${String(scan.unsearchablePages)} of ${String(loaded.pageCount)} pages carry no readable text and were not searched; an empty result is not proof the text is absent from the document.`,
              }
            : {}),
          ...(next === undefined
            ? {}
            : {
                nextCursor: cursorFor(loaded.stamp, {
                  t: "find",
                  o: hash,
                  x: expiry(),
                  p: next.page,
                  i: next.ordinal,
                  u: next.unsearchableBehind,
                  ...(next.ordinal === 0
                    ? {}
                    : {
                        h: pageDigest(
                          pageAt(resolved.pages, next.page)?.markdown ?? "",
                        ),
                      }),
                }),
              }),
          mode: loaded.mode,
        });
      },
    ),
  };
}
