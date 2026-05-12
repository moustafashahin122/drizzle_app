/**
 * @module drizzle-graphql-rbac/testing/schemaPush
 *
 * Apply Drizzle DDL to a better-sqlite3 handle via drizzle-kit's introspection,
 * without going through `drizzle.all(...)` (which rejects DDL with "statement
 * does not return data"). Shared by every test fixture that needs to
 * materialize a schema into an in-memory DB.
 *
 * `drizzle-kit/api`'s ESM bundle has a broken dynamic-require polyfill; the
 * CJS entry works under ESM via `createRequire`. Same workaround used
 * elsewhere in this package.
 */
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

const kitApi = createRequire(import.meta.url)("drizzle-kit/api") as {
  pushSQLiteSchema: (
    imports: Record<string, unknown>,
    drizzleInstance: unknown,
  ) => Promise<{ statementsToExecute: string[] }>;
};

/**
 * Push a Drizzle schema namespace onto a sqlite handle. Idempotent — when
 * the schema is already materialized, drizzle-kit emits an empty statement
 * list and this is a no-op.
 *
 * Enables `PRAGMA foreign_keys = ON` as a side effect so FK constraints
 * declared in the schema actually fire.
 */
export async function pushDrizzleSchema(
  sqlite: Database.Database,
  schema: Record<string, unknown>,
): Promise<void> {
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  const { statementsToExecute } = await kitApi.pushSQLiteSchema(schema, db);
  for (const stmt of statementsToExecute) sqlite.exec(stmt);
}
