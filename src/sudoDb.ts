/**
 * @module app/db
 *
 * Production Drizzle handle backed by the on-disk `todo.db`. Imports the
 * schema declarations from `./schema.js` (kept connection-free so tests
 * can build their own handle).
 *
 * The connection is exported as `sudoDb` — the name signals that any direct
 * use bypasses RBAC enforcement. App code should generally go through the
 * per-request `rdbFor(ctx)` factory returned by `createApp`. Reach for
 * `sudoDb` only in pre-user bootstrap paths (`server.ts` startup, the seed
 * scripts in `src/scripts/`).
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { logger } from "drizzle-graphql-rbac";
import * as schema from "./schema.js";

const dbLog = logger.child({ component: "app.db" });

const sqlite = new Database("todo.db");
sqlite.pragma("foreign_keys = ON");

export const sudoDb = drizzle(sqlite, {
  schema,
  logger: {
    logQuery: (query, params) => dbLog.debug({ query, params }, "drizzle query"),
  },
});
