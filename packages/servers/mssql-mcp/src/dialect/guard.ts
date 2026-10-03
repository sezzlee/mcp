import {
  asciiLower,
  asciiUpper,
  sqlText,
  type GuardOutcome,
} from "@sezzlee/db-core";

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
 * Guard: advisory. The boundary is the database principal, which `run_query`
 * verifies before every statement; this check only keeps a batch or a
 * non-query from reaching the server. Its `allow` arm is nonetheless the only
 * place agent text becomes `SqlText`.
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
  return { verdict: "allow", statement: sqlText(sql) };
}
