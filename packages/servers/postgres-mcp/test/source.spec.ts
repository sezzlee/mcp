import { describe, expect, it, vi } from "vitest";
import { sqlText } from "@sezzlee/db-core";
import { createPostgresSource } from "../src/server.js";
import type { PostgresClient, PostgresCursor } from "../src/driver/adapter.js";
import { readPostgresEnv, type PostgresConfig } from "../src/platform/env.js";
import { redact } from "../src/platform/errors.js";

const config: PostgresConfig = {
  server: "db.example",
  port: 5432,
  database: "data",
  user: "reader",
  password: "secret",
  sslMode: "verify-full",
  connectTimeoutMs: 1000,
  queryTimeoutMs: 1000,
};
const scoped = (sql: string) =>
  sql === "start transaction read only" ||
  sql === "commit" ||
  sql.startsWith("select pg_catalog.");
const query = {
  sql: sqlText("select 1"),
  parameters: [],
  timeoutMs: 1000,
  maxRows: 2,
};

describe("PostgreSQL source", () => {
  it("keeps the server statement timeout typed through the core error wrapper", async () => {
    const client: PostgresClient = {
      connect: async () => {},
      end: async () => {},
      on: () => {},
      query: () => {},
    };
    const cursorFactory = (sql: string): PostgresCursor => ({
      close: async () => {},
      read: (_count, callback) =>
        scoped(sql)
          ? callback(undefined, [], { fields: [] })
          : callback(
              Object.assign(
                new Error("canceling statement due to statement timeout"),
                { code: "57014" },
              ),
              [],
              { fields: [] },
            ),
    });
    const source = createPostgresSource(config, {
      clientFactory: () => client,
      cursorFactory,
    });
    await expect(source.runner.run(query)).rejects.toMatchObject({
      code: "query_timeout",
    });
    await source.close();
  });
  it("runs each query inside its own read-only transaction and discards a failed one", async () => {
    const issued: string[] = [];
    const clients: PostgresClient[] = [];
    const clientFactory = () => {
      const client: PostgresClient = {
        connect: async () => {},
        end: vi.fn(async () => {}),
        on: () => {},
        query: () => {},
      };
      clients.push(client);
      return client;
    };
    const cursorFactory = (sql: string): PostgresCursor => ({
      close: async () => {},
      read: (_count, callback) => {
        issued.push(sql);
        if (sql === "select broken")
          callback(
            Object.assign(new Error("division by zero"), { code: "22012" }),
            [],
            { fields: [] },
          );
        else callback(undefined, [], { fields: [] });
      },
    });
    const source = createPostgresSource(config, {
      clientFactory,
      cursorFactory,
    });
    await source.runner.run(query);
    expect(issued).toEqual([
      "start transaction read only",
      expect.stringContaining("set_config('statement_timeout', $1, true)"),
      "select 1",
      "select pg_catalog.pg_advisory_unlock_all()",
      "commit",
    ]);
    await expect(
      source.runner.run({ ...query, sql: sqlText("select broken") }),
    ).rejects.toMatchObject({ code: "query_failed" });
    expect(clients[0]?.end).toHaveBeenCalledOnce();
    await source.runner.run(query);
    expect(clients).toHaveLength(2);
    await source.close();
  });
  it("reuses capped connections and opens another after a cancelled physical query", async () => {
    let stalled = false;
    const clients: PostgresClient[] = [];
    const clientFactory = () => {
      const client: PostgresClient = {
        connect: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        on: vi.fn(),
        query: vi.fn(),
      };
      clients.push(client);
      return client;
    };
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cursorFactory = (sql: string): PostgresCursor => {
      let read = false;
      return {
        close: vi.fn(async () => {}),
        read: (_count, callback) => {
          if (scoped(sql)) {
            callback(undefined, [], { fields: [] });
            return;
          }
          if (stalled) {
            started();
            return;
          }
          callback(undefined, read ? [] : [[1], [2], [3]], {
            fields: [{ name: "n", dataTypeID: 23 }],
          });
          read = true;
        },
      };
    };
    const source = createPostgresSource(config, {
      clientFactory,
      cursorFactory,
    });
    expect(source.sessionIntent).toBe("read_only");
    expect((await source.runner.run(query)).more).toBe(true);
    await source.runner.run(query);
    expect(clients).toHaveLength(1);
    stalled = true;
    const controller = new AbortController();
    const pending = source.runner.run(query, controller.signal);
    await startedPromise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "query_cancelled" });
    expect(clients[0]?.end).toHaveBeenCalledOnce();
    stalled = false;
    await source.runner.run(query);
    expect(clients).toHaveLength(2);
    await source.close();
  });
  it("preserves unavailable database failure from core acquisition", async () => {
    const client: PostgresClient = {
      connect: async () => {
        throw Object.assign(new Error("database missing"), { code: "3D000" });
      },
      end: async () => {},
      on: () => {},
      query: () => {},
    };
    const source = createPostgresSource(config, {
      clientFactory: () => client,
    });
    await expect(source.runner.run(query)).rejects.toMatchObject({
      code: "database_unavailable",
    });
    await source.close();
  });
  it("reports a server that refuses TLS as a TLS problem, not a certificate one", async () => {
    const client: PostgresClient = {
      connect: async () => {
        throw new Error("The server does not support SSL connections");
      },
      end: async () => {},
      on: () => {},
      query: () => {},
    };
    const source = createPostgresSource(config, {
      clientFactory: () => client,
    });
    await expect(source.runner.run(query)).rejects.toMatchObject({
      code: "connection_failed",
      message: expect.stringContaining("PG_TLS_UNSUPPORTED"),
      recovery: expect.stringContaining("does not accept TLS"),
    });
    await source.close();
  });
  it("defaults CLI connections to verified TLS without echoing invalid secrets", () => {
    const env = {
      SEZZLEE_POSTGRES_SERVER: "host",
      SEZZLEE_POSTGRES_DATABASE: "db",
      SEZZLEE_POSTGRES_USER: "u",
      SEZZLEE_POSTGRES_PASSWORD: "secret",
    };
    expect(readPostgresEnv(env)).toMatchObject({
      kind: "ready",
      config: { sslMode: "verify-full", port: 5432 },
    });
    expect(
      readPostgresEnv({ ...env, SEZZLEE_POSTGRES_SSL_MODE: "secret-invalid" }),
    ).toEqual({
      kind: "invalid",
      reason: "Invalid PostgreSQL configuration: sslMode.",
    });
    expect(
      redact(
        "postgresql://reader:secret@host/database host=secret password='secret' user=secret",
      ),
    ).not.toContain("secret");
  });
});
