import type { DriverFailure } from "@sezzlee/db-core";

export function mapDriverError(error: unknown): DriverFailure | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  )
    return undefined;
  const code = error.code;
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "PostgreSQL rejected the operation.";
  /** Guard: PostgreSQL uses SQLSTATE 57014 for both statement deadlines and external cancellation; the canonical timeout diagnostic distinguishes only the deadline case. */
  const statementTimeout =
    code === "57014" &&
    /canceling statement due to statement timeout\b/i.test(message);
  const mapped =
    code === "3D000"
      ? "database_unavailable"
      : code === "PG_TLS_UNSUPPORTED"
        ? "connection_failed"
        : code === "ETIMEDOUT" || code === "ETIMEOUT" || statementTimeout
          ? "query_timeout"
          : code === "ECANCEL" || code === "57014"
            ? "query_cancelled"
            : code.startsWith("28")
              ? "authentication_failed"
              : code === "25006"
                ? "write_not_permitted"
                : code === "42501"
                  ? "permission_denied"
                  : code === "42P01" || code === "42703"
                    ? "object_not_found"
                    : code === "40P01"
                      ? "deadlock"
                      : code.startsWith("08") ||
                          [
                            "ECONNREFUSED",
                            "ECONNRESET",
                            "ENOTFOUND",
                            "EPIPE",
                            "PG_CONNECTION_CLOSED",
                            "57P01",
                            "57P02",
                            "57P03",
                          ].includes(code)
                        ? "connection_failed"
                        : "query_failed";
  return {
    code: mapped,
    message,
    engineCode: code,
    recovery:
      code === "PG_TLS_UNSUPPORTED"
        ? "The server does not accept TLS. Enable TLS on the server, or set sslMode to disable only on a trusted network."
        : mapped === "database_unavailable"
          ? "Check that the configured database exists and that the principal can open it."
          : mapped === "authentication_failed"
            ? "Check the configured database credentials."
            : mapped === "connection_failed"
              ? "Check database reachability and verified TLS settings."
              : "Narrow the SELECT or correct the statement using catalog metadata.",
  };
}
