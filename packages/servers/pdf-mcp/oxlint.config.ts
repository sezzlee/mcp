import { defineConfig } from "oxlint";
import { config } from "@sezzlee/oxlint-config/base";
import { casing } from "@sezzlee/oxlint-config/casing";

const platformMessage =
  "The platform layer is the @sezzlee/file-core and node boundary; it may not import a layer above it.";
const engineMessage =
  "The engine layer is the only pdf-inspector adapter; it answers in this server's own vocabulary and never reaches the layers above it.";
const documentMessage =
  "The document layer caches an extraction; the OCR, search and tool surfaces are above it.";
const ocrMessage =
  "The OCR layer drives the injected ports over a loaded document; the tool surface is above it.";
const searchMessage =
  "The search layer scans an extracted document; it never reaches the tool surface.";

/**
 * Guard: the engine folder is the only place the library is named, so every
 * 0-based index the library reports is converted in one place. A second import
 * site would reintroduce the mixed-base bug this boundary exists to prevent.
 */
const inspectorPackages = ["@firecrawl/pdf-inspector"];

/**
 * Guard: this server never opens a socket. OCR reaches a model through the
 * injected OcrProvider, so the decision to leave the machine belongs to whoever
 * binds that port. The ban
 * is folded into every layer's rule rather than declared once, because a later
 * override replaces no-restricted-imports outright instead of merging with it;
 * a standalone override would silently stop applying to every folder that
 * declares its own layer rule.
 */
const networkMessage =
  "pdf-mcp performs no network access; an OCR provider is injected through src/ocr/port.ts and owns any connection.";

const networkModules = [
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "node:dgram",
  "http",
  "https",
  "net",
  "tls",
  "undici",
  "node-fetch",
  "axios",
];

/**
 * Guard: the entrypoints are listed alongside the folder globs because
 * no-restricted-imports matches the specifier string, not the resolved module.
 * Without them a layer could reach anything through ../index.js and the rule
 * would never fire.
 */
const entrypoints = ["**/index.js", "**/server.js", "**/cli.js"];

const restrict = (
  message: string,
  { paths = [], folders = [] }: { paths?: string[]; folders?: string[] },
) => ({
  "no-restricted-imports": [
    "error",
    {
      paths: [
        ...networkModules.map((name) => ({ name, message: networkMessage })),
        ...paths.map((name) => ({ name, message })),
      ],
      ...(folders.length === 0
        ? {}
        : { patterns: [{ group: [...folders, ...entrypoints], message }] }),
    },
  ],
});

export default defineConfig({
  extends: [config],
  ignorePatterns: ["dist/**"],
  overrides: [
    ...casing,
    {
      files: ["src/**/*.ts"],
      rules: {
        "no-restricted-globals": [
          "error",
          { name: "fetch", message: networkMessage },
          { name: "WebSocket", message: networkMessage },
          { name: "EventSource", message: networkMessage },
        ],
        ...restrict(networkMessage, {}),
      },
    },
    {
      files: ["test/fixtures/*.mjs"],
      globals: {
        process: "readonly",
        console: "readonly",
        performance: "readonly",
        AbortController: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
      },
    },
    {
      files: ["src/platform/**/*.ts"],
      rules: restrict(platformMessage, {
        paths: inspectorPackages,
        folders: [
          "**/engine/**",
          "**/document/**",
          "**/ocr/**",
          "**/search/**",
          "**/tools/**",
        ],
      }),
    },
    {
      files: ["src/engine/**/*.ts"],
      rules: restrict(engineMessage, {
        folders: ["**/document/**", "**/ocr/**", "**/search/**", "**/tools/**"],
      }),
    },
    {
      files: ["src/document/**/*.ts"],
      rules: restrict(documentMessage, {
        paths: inspectorPackages,
        folders: ["**/ocr/**", "**/search/**", "**/tools/**"],
      }),
    },
    {
      files: ["src/ocr/**/*.ts"],
      rules: restrict(ocrMessage, {
        paths: inspectorPackages,
        folders: ["**/search/**", "**/tools/**"],
      }),
    },
    {
      files: ["src/search/**/*.ts"],
      rules: restrict(searchMessage, {
        paths: inspectorPackages,
        folders: ["**/tools/**"],
      }),
    },
    {
      files: [
        "src/tools/**/*.ts",
        "src/cli.ts",
        "src/server.ts",
        "src/index.ts",
      ],
      rules: restrict(engineMessage, { paths: inspectorPackages }),
    },
  ],
});
