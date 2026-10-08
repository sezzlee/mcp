import { createHighlighterCoreSync, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import csharp from "shiki/langs/csharp.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import sql from "shiki/langs/sql.mjs";
import toml from "shiki/langs/toml.mjs";
import typescript from "shiki/langs/typescript.mjs";
import xml from "shiki/langs/xml.mjs";

const THEME = "sezzlee-night";

const LANGUAGES: Readonly<Record<string, string>> = {
  sh: "bash",
  bash: "bash",
  shell: "bash",
  json: "json",
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  csharp: "csharp",
  cs: "csharp",
  toml: "toml",
  sql: "sql",
  xml: "xml",
};

/**
 * Guard: the highlighter is synchronous (JavaScript regex engine, no WASM), so the prerendered
 * HTML and the hydrated client render the same tokens and React never sees a mismatch.
 */
const highlighter = createHighlighterCoreSync({
  engine: createJavaScriptRegexEngine(),
  langs: [bash, csharp, javascript, json, sql, toml, typescript, xml],
  themes: [
    {
      name: THEME,
      type: "dark",
      fg: "#ece6dc",
      bg: "#1a1917",
      settings: [
        { settings: { foreground: "#ece6dc" } },
        {
          scope: ["comment", "punctuation.definition.comment"],
          settings: { foreground: "#9a9287", fontStyle: "italic" },
        },
        {
          scope: ["string", "string.quoted", "markup.inline.raw"],
          settings: { foreground: "#e0bd7a" },
        },
        {
          scope: ["constant.numeric", "constant.language", "constant.other"],
          settings: { foreground: "#8fcf9c" },
        },
        {
          scope: ["keyword", "storage", "storage.type", "keyword.operator.new"],
          settings: { foreground: "#6fbfb4" },
        },
        {
          scope: [
            "support.type.property-name",
            "meta.object-literal.key",
            "entity.name.tag",
            "variable.parameter",
          ],
          settings: { foreground: "#b6d3cf" },
        },
        {
          scope: [
            "entity.name.function",
            "support.function",
            "meta.function-call",
          ],
          settings: { foreground: "#e8d5b0" },
        },
        {
          scope: [
            "entity.name.type",
            "support.class",
            "entity.other.attribute-name",
          ],
          settings: { foreground: "#cfc8bc" },
        },
      ],
    },
  ],
});

/**
 * Tokenizes a code block for the dark code panel.
 *
 * @returns One token list per line, or `null` for a language the site does not highlight.
 */
export function highlight(code: string, lang: string): ThemedToken[][] | null {
  const grammar = LANGUAGES[lang];
  if (grammar === undefined) return null;
  return highlighter.codeToTokensBase(code, { lang: grammar, theme: THEME });
}
