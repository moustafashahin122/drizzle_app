/**
 * @module drizzle-graphql-rbac/tables
 *
 * Framework-owned table declarations, dialect-selected at import time.
 *
 * The dialect is picked by env:
 *   - `DATABASE_URL=postgres://…` or `DATABASE_URL=postgresql://…` → Postgres.
 *   - anything else (incl. unset, e.g. tests) → SQLite.
 *
 * Both flavors share identical JS keys and column names so all framework
 * code (auth, persistence, the GraphQL builder) is dialect-agnostic at the
 * source level. Types are exported from the sqlite flavor — the pg variants
 * are structurally compatible (same JS keys, same JS value types per column).
 */
import * as sqliteTables from "./tables.sqlite.js";
import * as pgTables from "./tables.pg.js";

const url = process.env.DATABASE_URL ?? "";
const usePg = url.startsWith("postgres://") || url.startsWith("postgresql://");

const t: typeof sqliteTables = (usePg ? pgTables : sqliteTables) as typeof sqliteTables;

export const roles = t.roles;
export const users = t.users;
export const sessions = t.sessions;

/** The full set of framework-owned tables, ready to spread into a schema namespace. */
export const frameworkTables = {
  roles,
  users,
  sessions,
};

export type { Role, NewRole, User, NewUser, Session } from "./tables.sqlite.js";
