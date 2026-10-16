import { defineConfig } from "oxlint";
import { config } from "@sezzlee/oxlint-config/base";
import { casing } from "@sezzlee/oxlint-config/casing";

const platformMessage =
  "The platform layer is the @sezzlee/file-core and node boundary; it may not import a layer above it.";
const gridMessage =
  "The grid layer sees sheets only through SheetView; it must not reach a format adapter, a metadata reader or the tool surface.";
const metadataMessage =
  "The metadata layer reads SpreadsheetML parts and shapes reports; the adapter that opened the package is above it.";
const formatMessage =
  "A format adapter turns bytes into a SheetView; it never reaches the tool surface.";
const workerMessage =
  "The regex worker entry stays free of the server surface; it answers over the message port and the main side builds the error.";

const parserPackages = ["csv-parse", "csv-parse/sync"];

/**
 * Guard: SheetJS is the test oracle the OOXML reader is compared against, so it
 * is a dev dependency. An import from src would pass every local check and
 * fail only for a consumer installing the tarball. Every src override carries
 * the ban, because an override replaces the rule's options instead of merging.
 */
const oracle = {
  name: "@e965/xlsx",
  message:
    "@e965/xlsx is the test oracle and a dev dependency; src reads workbooks through the OOXML reader.",
};

/**
 * Guard: the platform layer may name the container reader, because sniffing the
 * leading bytes decides whether a file is readable at all and that is a
 * precondition of reading, not an adapter concern. No layer above platform may.
 */
const containerPackages = ["@sezzlee/ooxml-core"];

const formatPackages = [...parserPackages, ...containerPackages];
const serverPackages = [
  "@sezzlee/file-core",
  "@modelcontextprotocol/server",
  "zod",
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
      paths: [...paths.map((name) => ({ name, message })), oracle],
      patterns: [{ group: [...folders, ...entrypoints], message }],
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
        "no-restricted-imports": ["error", { paths: [oracle] }],
      },
    },
    {
      files: ["test/fixtures/*.mjs"],
      globals: {
        process: "readonly",
        console: "readonly",
        performance: "readonly",
        AbortController: "readonly",
      },
    },
    {
      files: ["src/platform/**/*.ts"],
      rules: restrict(platformMessage, {
        paths: parserPackages,
        folders: [
          "**/grid/**",
          "**/metadata/**",
          "**/format/**",
          "**/tools/**",
        ],
      }),
    },
    {
      files: ["src/grid/**/*.ts"],
      rules: restrict(gridMessage, {
        paths: formatPackages,
        folders: ["**/metadata/**", "**/format/**", "**/tools/**"],
      }),
    },
    {
      files: ["src/metadata/**/*.ts"],
      rules: restrict(metadataMessage, {
        folders: ["**/format/**", "**/tools/**"],
      }),
    },
    {
      files: ["src/format/**/*.ts"],
      rules: restrict(formatMessage, { folders: ["**/tools/**"] }),
    },
    {
      files: ["src/regex-worker.ts"],
      rules: {
        "no-console": "error",
        ...restrict(workerMessage, {
          paths: [...serverPackages, ...formatPackages],
          folders: [
            "**/platform/**",
            "**/grid/**",
            "**/metadata/**",
            "**/format/**",
            "**/tools/**",
          ],
        }),
      },
    },
  ],
});
