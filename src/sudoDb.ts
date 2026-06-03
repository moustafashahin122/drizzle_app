/**
 * @module app/db
 *
 * Production Drizzle handle. Dialect picked from `DATABASE_URL`:
 *
 *   - `postgres://…` / `postgresql://…` → node-postgres (`pg`) pool, ideal for
 *     Neon (Neon speaks the wire protocol). Drizzle wrapper is
 *     `drizzle-orm/node-postgres`.
 *   - anything else (incl. unset) → on-disk SQLite (`todo.db`).
 *
 * The connection is exported as `sudoDb` — the name signals that any direct
 * use bypasses RBAC enforcement. App code should generally go through the
 * per-request `rbacDbFor(ctx)` factory returned by `createApp`. Reach for
 * `sudoDb` only in pre-user bootstrap paths (`server.ts` startup, the seed
 * scripts in `src/scripts/`).
 */
import { logger } from "drizzle-graphql-rbac";
import * as schema from "./schema.js";

const dbLog = logger.child({ component: "app.db" });
const url = process.env.DATABASE_URL ?? "";
const isPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");

async function buildDb() {
  if (isPostgres) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    // Pool max defaults to 32 so concurrent GraphQL workers don't queue on the
    // pg default of 10 — at remote-DB RTTs that queueing dominates p95.
    const poolMax = Number(process.env.DATABASE_POOL_MAX ?? 32);
    const pool = new Pool({
      connectionString: url,
      max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 32,
      // Neon requires SSL; node-postgres reads `sslmode=require` from the URL
      // but does not infer the trusted CA chain — let it use the system store
      // with rejectUnauthorized true. For self-signed dev Postgres set
      // `DATABASE_SSL=disable`.
      ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: true },
    });
    return drizzle(pool, {
      schema,
      logger: {
        logQuery: (query, params) => dbLog.debug({ query, params }, "drizzle query"),
      },
    });
  }
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const sqlite = new Database("todo.db");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, {
    schema,
    logger: {
      logQuery: (query, params) => dbLog.debug({ query, params }, "drizzle query"),
    },
  });
}

export const sudoDb = await buildDb();
