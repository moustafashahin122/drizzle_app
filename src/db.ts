/**
 * @module app/db
 *
 * Production Drizzle handle backed by the on-disk `todo.db`. Imports the
 * schema declarations from `./schema.js` (kept connection-free so tests
 * can build their own handle) and re-exports them for callers that want
 * one-stop access to `{ db, users, todos, ... }`.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { logger } from "drizzle-graphql-rbac";
import * as schema from "./schema.js";

export * from "./schema.js";

const dbLog = logger.child({ component: "app.db" });

const sqlite = new Database("todo.db");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, {
  schema,
  logger: {
    logQuery: (query, params) => dbLog.debug({ query, params }, "drizzle query"),
  },
});
