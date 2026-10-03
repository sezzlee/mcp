import {
  sqlText,
  type Dialect,
  type QueryScope,
  type QuerySpec,
} from "@sezzlee/db-core";
import type { PostgresConfig } from "../platform/env.js";
import { secretPatterns } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import { mapDriverError } from "./errors.js";
import { readOnlyGuard } from "./guard.js";
import { createIntrospection } from "./introspect.js";
import { quoteIdentifier, quoteQualified } from "./quote.js";
import { describeType } from "./types.js";

const statement = (
  sql: string,
  timeoutMs: number,
  parameters: QuerySpec["parameters"] = [],
): QuerySpec => ({ sql: sqlText(sql), parameters, timeoutMs, maxRows: 1 });

/**
 * Guard: every setting is transaction-local and the transaction itself is read
 * only, so a statement cannot switch it to read-write after its snapshot is
 * taken, and a transaction pooler never carries a setting to another client's
 * session as a session-level `SET` would. Session advisory locks outlive the
 * transaction, so they are released before it commits.
 */
const queryScope = (spec: QuerySpec): QueryScope => ({
  kind: "transaction",
  begin: [
    statement("start transaction read only", spec.timeoutMs),
    statement(
      "select pg_catalog.set_config('statement_timeout', $1, true), pg_catalog.set_config('lock_timeout', $1, true), pg_catalog.set_config('search_path', 'pg_catalog', true), pg_catalog.set_config('standard_conforming_strings', 'on', true)",
      spec.timeoutMs,
      [{ name: "timeout", value: String(spec.timeoutMs) }],
    ),
  ],
  commit: [
    statement("select pg_catalog.pg_advisory_unlock_all()", spec.timeoutMs),
    statement("commit", spec.timeoutMs),
  ],
});

export function createPostgresDialect(timeoutMs: number) {
  return {
    id: "postgres",
    secretPatterns,
    sessionSetup: () => [],
    sessionIntent: () => "read_only" as const,
    queryScope,
    quoteIdentifier,
    quoteQualified,
    describeType,
    introspection: createIntrospection(timeoutMs, {
      maxColumns: limits.maxColumns,
      maxKeys: limits.maxKeys,
    }),
    mapDriverError,
    readOnlyGuard,
  } as const satisfies Dialect<PostgresConfig>;
}
export const postgresDialect = createPostgresDialect(limits.queryTimeoutMs);
