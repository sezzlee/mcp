import {
  asciiLower,
  asciiUpper,
  sqlText,
  type GuardOutcome,
} from "@sezzlee/db-core";

type Scan =
  | { readonly kind: "open" }
  | {
      readonly kind: "closed";
      readonly first: string | undefined;
      readonly statements: number;
    };

const word = /^[A-Za-z_][A-Za-z_0-9$]*/;
const dollarTag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/;

function closingQuote(
  sql: string,
  start: number,
  quote: string,
  backslash: boolean,
): number {
  for (let index = start; index < sql.length; index++) {
    if (backslash && sql[index] === "\\") {
      index++;
      continue;
    }
    if (sql[index] === quote) {
      if (sql[index + 1] !== quote) return index + 1;
      index++;
    }
  }
  return -1;
}

function closingComment(sql: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < sql.length) {
    if (sql.startsWith("/*", index)) {
      depth++;
      index += 2;
    } else if (sql.startsWith("*/", index)) {
      depth--;
      index += 2;
      if (depth === 0) return index;
    } else index++;
  }
  return -1;
}

/**
 * Guard: the lexer has to agree with the server about where a literal ends, or
 * a `;` inside one is counted as a statement boundary and the other way round.
 * `E'…'` is the only form where a backslash escapes the quote; every other form
 * relies on the `standard_conforming_strings=on` the query scope sets.
 */
function scan(sql: string): Scan {
  let first: string | undefined;
  let statements = 0;
  let pending = false;
  let index = 0;
  const token = (value: string) => {
    if (!pending) first ??= value;
    pending = true;
  };
  while (index < sql.length) {
    const here = sql[index]!;
    if (/\s/.test(here)) {
      index++;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      index = closingComment(sql, index + 2);
      if (index < 0) return { kind: "open" };
      continue;
    }
    if (here === ";") {
      if (pending) statements++;
      pending = false;
      index++;
      continue;
    }
    if (here === "'" || here === '"') {
      index = closingQuote(sql, index + 1, here, false);
      if (index < 0) return { kind: "open" };
      token(here);
      continue;
    }
    const tag =
      here === "$" ? dollarTag.exec(sql.slice(index))?.[0] : undefined;
    if (tag !== undefined) {
      const end = sql.indexOf(tag, index + tag.length);
      if (end < 0) return { kind: "open" };
      index = end + tag.length;
      token("$");
      continue;
    }
    const name = word.exec(sql.slice(index))?.[0];
    if (name !== undefined) {
      const lower = asciiLower(name);
      index += name.length;
      if (lower === "e" && sql[index] === "'") {
        index = closingQuote(sql, index + 1, "'", true);
        if (index < 0) return { kind: "open" };
        token("'");
        continue;
      }
      if (
        lower === "u" &&
        sql[index] === "&" &&
        /['"]/.test(sql[index + 1] ?? "")
      ) {
        index = closingQuote(sql, index + 2, sql[index + 1]!, false);
        if (index < 0) return { kind: "open" };
        token("'");
        continue;
      }
      token(lower);
      continue;
    }
    if (here !== "(") token(here);
    index++;
  }
  if (pending) statements++;
  return { kind: "closed", first, statements };
}

const refuse = (reason: string, recovery: string): GuardOutcome => ({
  verdict: "refuse",
  reason,
  recovery,
});

export function readOnlyGuard(sql: string): GuardOutcome {
  const outcome = scan(sql);
  if (outcome.kind === "open")
    return refuse(
      "A string, quoted identifier, dollar-quoted body or block comment is not closed.",
      "Close it and send the statement again.",
    );
  if (outcome.statements === 0)
    return refuse(
      "The statement is empty once comments are removed.",
      "Send one SELECT statement.",
    );
  if (outcome.statements > 1)
    return refuse(
      `The text carries ${outcome.statements} statements; only one is allowed.`,
      "Send a single SELECT or WITH statement, with no semicolon-separated batch.",
    );
  if (outcome.first !== "select" && outcome.first !== "with")
    return refuse(
      `A query has to begin with SELECT or WITH; this one begins with ${asciiUpper(outcome.first ?? "nothing")}.`,
      "Rewrite the request as a SELECT.",
    );
  return { verdict: "allow", statement: sqlText(sql) };
}
