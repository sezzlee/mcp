import {
  readOnly,
  toolNamesOf,
  type HandlersOf,
  type ToolDefinitions,
  type ToolInputOf,
  type ToolNameOf,
} from "@sezzlee/file-core";
import { z } from "zod";

import { limits } from "../platform/limits.js";
import { filePath, pages, query } from "./schemas.js";

export const toolDefinitions = {
  list_documents: {
    description:
      "List readable PDF documents under the server root. Returns filePath values that other tools accept verbatim. The listing never opens a file, so a listed path is a candidate, not a guarantee that the document parses. totalExact distinguishes a complete total; scanTruncated is separate from the result page limit.",
    inputSchema: z.object({
      subdirectory: z
        .string()
        .optional()
        .describe("Folder under the root to list."),
      pattern: z
        .string()
        .optional()
        .describe("Glob over the relative path, for example invoices/*.pdf."),
      maxResults: z
        .int()
        .min(1)
        .max(limits.maxListResults)
        .optional()
        .describe(
          "Maximum returned files, default 50. Does not increase the traversal budget.",
        ),
    }),
    annotations: readOnly,
  },
  describe_document: {
    description:
      "Summarise one PDF: page count, document type, which pages carry no trustworthy text, and whether OCR and page images are available. Use pagesNeedingOcr to identify likely scans and pagesWithoutText to find pages with no readable text, including blank pages. documentType and classificationConfidence come from a separate document-level classifier: the confidence scores that verdict, NOT the accuracy of any extracted text, and the classifier reports a whole document as image-based when a single page is a scan.",
    inputSchema: z.object({ filePath }),
    annotations: readOnly,
  },
  read_pages: {
    description:
      "Read selected pages as Markdown, one entry per page, with page numbers counted from 1. A page whose text the engine could not trust is returned with needsOcr true rather than omitted, so a scanned page is never presented as an empty one; empty distinguishes a genuinely blank page from an unreadable one. Each page reports source: text when the PDF's own text layer was used, ocr when a provider transcribed it. A page whose Markdown does not fit the response budget is clamped and marked truncatedMarkdown; nextCursor then resumes inside that page. With an explicit pages selection, nextCursor stays within the selected pages.",
    inputSchema: z.object({
      filePath,
      pages: pages.optional(),
      maxPages: z
        .int()
        .min(1)
        .max(limits.maxReadPages)
        .optional()
        .describe(
          "Maximum pages in one response, default 10. The response byte budget may stop the page earlier.",
        ),
      ocr: z
        .boolean()
        .optional()
        .describe(
          "Transcribe pages the text layer cannot answer, default false. Requires an OCR provider: describe_document reports whether one is configured. Sends those page images to that provider, which is slow and may leave this machine.",
        ),
      cursor: z
        .string()
        .optional()
        .describe(
          "nextCursor from a previous read_pages response. It carries the selection it was produced for, so it cannot be combined with pages.",
        ),
    }),
    annotations: readOnly,
  },
  view_pages: {
    description:
      "Render selected pages as images for a vision-capable model, including pages without readable text. Requires a configured rasterizer, reported by describe_document as capabilities.pageImages. Returns one image per requested page in request order and a text summary. The page pixels are sent to the caller.",
    inputSchema: z.object({
      filePath,
      pages: z
        .array(z.int().min(1))
        .min(1)
        .max(limits.maxViewPages)
        .describe("Distinct page numbers to render, counted from 1."),
    }),
    annotations: readOnly,
  },
  find_in_document: {
    description:
      "Find literal text in the extracted page text. The query is matched literally, never as a regular expression or a query language. Pages that need OCR carry no searchable text and are counted in unsearchablePages: when coverageComplete is false, an empty match list means the text was not found in the pages that could be read, NOT that it is absent from the document. Pass ocr to transcribe those pages first and search them too. Case-insensitive matching folds ASCII letters only.",
    inputSchema: z.object({
      filePath,
      query,
      matchMode: z
        .enum(["contains", "exact"])
        .optional()
        .describe(
          "Substring match within a line (default), or whole-line equality after trimming.",
        ),
      caseSensitive: z
        .boolean()
        .optional()
        .describe("Default true. When false, only ASCII letters are folded."),
      maxResults: z
        .int()
        .min(1)
        .max(limits.maxFindResults)
        .optional()
        .describe("Maximum matches in one page of results, default 50."),
      ocr: z
        .boolean()
        .optional()
        .describe(
          "Transcribe unsearchable pages before searching, default false. Requires an OCR provider; slow, and the page images leave this server.",
        ),
      cursor: z
        .string()
        .optional()
        .describe("nextCursor from a previous find_in_document response."),
    }),
    annotations: readOnly,
  },
} as const satisfies ToolDefinitions;

export type Definitions = typeof toolDefinitions;
export type ToolName = ToolNameOf<Definitions>;
export const toolNames: readonly ToolName[] = toolNamesOf(toolDefinitions);
export type ToolInput<K extends ToolName> = ToolInputOf<Definitions, K>;
export type ToolHandlers = HandlersOf<Definitions>;
