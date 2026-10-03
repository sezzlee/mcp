import {
  asciiLower,
  asciiUpper,
  sqlText,
  type GuardOutcome,
} from "@sezzlee/db-core";

/**
 * Guard: T-SQL needs no `;` between statements, so `select 1 delete from t` is
 * a batch of two and counting semicolons cannot find the boundary. Every word
 * here is reserved in T-SQL and can only appear unbracketed as syntax, so
 * finding one is how a second statement, a write inside this one, or a rowset
 * function that runs under another server's login is recognised.
 */
const statementKeywords = [
  "insert",
  "update",
  "delete",
  "merge",
  "drop",
  "alter",
  "create",
  "truncate",
  "exec",
  "execute",
  "grant",
  "revoke",
  "deny",
  "backup",
  "restore",
  "shutdown",
  "reconfigure",
  "waitfor",
  "into",
  "openquery",
  "openrowset",
  "opendatasource",
  "bulk",
  "use",
  "declare",
  "set",
  "begin",
  "commit",
  "rollback",
  "kill",
  "dbcc",
];

const procedurePrefix = /\b(?:sp_|xp_)\w*/u;

interface Normalised {
  readonly masked: string;
  readonly statements: readonly string[];
}

/**
 * Guard: comments and literals are removed before statements are counted, so a
 * `;` inside a string, a bracketed identifier or a comment is not read as a
 * batch boundary and a comment cannot hide a second statement.
 */
function normalise(sql: string): Normalised {
  let masked = "";
  let index = 0;
  while (index < sql.length) {
    const here = sql[index];
    const next = sql[index + 1];
    if (here === "'") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "'") {
          if (sql[end + 1] === "'") {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      masked += "''";
      index = end + 1;
      continue;
    }
    if (here === "[") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "]") {
          if (sql[end + 1] === "]") {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      masked += "id";
      index = end + 1;
      continue;
    }
    if (here === '"') {
      let end = index + 1;
      while (end < sql.length && sql[end] !== '"') {
        end += 1;
      }
      masked += "id";
      index = end + 1;
      continue;
    }
    if (here === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      masked += " ";
      continue;
    }
    if (here === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
          continue;
        }
        if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
          continue;
        }
        index += 1;
      }
      masked += " ";
      continue;
    }
    masked += here;
    index += 1;
  }
  const statements = masked
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return { masked: asciiLower(masked), statements };
}

const refuse = (reason: string, recovery: string): GuardOutcome => ({
  verdict: "refuse",
  reason,
  recovery,
});

/**
 * Decides whether one statement may run.
 *
 * Guard: the principal `run_query` verifies is the boundary for writes in this
 * database. This check is what keeps the text to one statement, because MSSQL
 * has neither a read-only session nor a protocol that refuses a batch. Its
 * `allow` arm is the only place agent text becomes `SqlText`.
 */
export function readOnlyGuard(sql: string): GuardOutcome {
  const { masked, statements } = normalise(sql);
  if (statements.length === 0) {
    return refuse(
      "The statement is empty once comments are removed.",
      "Send one SELECT statement.",
    );
  }
  if (statements.length > 1) {
    return refuse(
      `The text carries ${statements.length} statements; only one is allowed.`,
      "Send a single SELECT statement, with no semicolon-separated batch.",
    );
  }
  const first = /^[\s(]*(\w+)/u.exec(masked)?.[1];
  if (first !== "select" && first !== "with") {
    return refuse(
      `A read-only statement has to begin with SELECT or WITH; this one begins with ${asciiUpper(first ?? "nothing")}.`,
      "Rewrite the request as a SELECT.",
    );
  }
  const hit = statementKeywords.find((word) =>
    new RegExp(`\\b${word}\\b`, "u").test(masked),
  );
  if (hit !== undefined) {
    return refuse(
      `The statement carries the keyword ${asciiUpper(hit)}, which starts another statement, writes, or runs outside this database.`,
      "Send one plain SELECT over this database's tables and views.",
    );
  }
  if (procedurePrefix.test(masked)) {
    return refuse(
      "The statement names a system procedure.",
      "Use search_catalog and describe_table for catalogue questions.",
    );
  }
  return { verdict: "allow", statement: sqlText(sql) };
}
