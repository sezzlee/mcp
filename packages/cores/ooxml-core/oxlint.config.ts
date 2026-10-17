import { defineConfig } from "oxlint";
import { config } from "@sezzlee/oxlint-config/base";
import { casing } from "@sezzlee/oxlint-config/casing";

const primitivesMessage =
  "primitives/ is the dependency-free leaf; it may not import another layer or a package.";
const modelMessage =
  "model/ carries the vocabulary as types only; it may not import a runtime layer or a package.";
const xmlMessage =
  "xml/ tokenizes a part itself; the container and the archive are above it, and saxes is only the test oracle.";
const zipMessage =
  "zip/ indexes the archive; the container layer is above it, and part parsing is not its job.";
const containerMessage =
  "container/ reads an OPC package through the injected PartSource; importing zip/ would make that injection decorative.";

const restrict = (
  message: string,
  { paths = [], folders = [] }: { paths?: string[]; folders?: string[] },
) => ({
  "no-restricted-imports": [
    "error",
    {
      paths: paths.map((name) => ({ name, message })),
      patterns: [
        { group: [...folders, "**/index.js", "**/reader.js"], message },
      ],
    },
  ],
});

export default defineConfig({
  extends: [config],
  ignorePatterns: ["dist/**"],
  overrides: [
    ...casing,
    {
      files: ["src/primitives/**/*.ts"],
      rules: restrict(primitivesMessage, {
        paths: ["fflate", "saxes"],
        folders: ["**/model/**", "**/xml/**", "**/zip/**", "**/container/**"],
      }),
    },
    {
      files: ["src/model/**/*.ts"],
      rules: restrict(modelMessage, {
        paths: ["fflate", "saxes"],
        folders: [
          "**/primitives/**",
          "**/xml/**",
          "**/zip/**",
          "**/container/**",
        ],
      }),
    },
    {
      files: ["src/xml/**/*.ts"],
      rules: restrict(xmlMessage, {
        paths: ["fflate", "saxes"],
        folders: ["**/zip/**", "**/container/**"],
      }),
    },
    {
      files: ["src/zip/**/*.ts"],
      rules: restrict(zipMessage, {
        paths: ["saxes"],
        folders: ["**/xml/**", "**/container/**"],
      }),
    },
    {
      files: ["src/container/**/*.ts"],
      rules: restrict(containerMessage, {
        paths: ["fflate", "saxes"],
        folders: ["**/zip/**"],
      }),
    },
  ],
});
