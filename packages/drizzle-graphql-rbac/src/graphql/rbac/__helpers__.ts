/**
 * Domain-specific test fixtures for the RBAC module.
 *
 * Tables (`users`, `todos`) are declared once, the schema is applied to the
 * framework's shared singleton sqlite handle at module load, and the
 * drizzle wrapper is exported so every test file in this directory works
 * against the same connection. Per-test rollback is handled by
 * `transactionCase` (see `../../testing/`).
 *
 * Seeding helpers (`seedUserManager`, `seedReaderAdmin`) are intended to be
 * called from each suite's `setUpClass` — that runs inside the suite-level
 * SAVEPOINT, so each file's reference data is rolled back when its tests
 * end and the next file starts with an empty schema.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { relations } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

import {
  applySchemaSql,
  getSharedSqlite,
  transactionCase,
} from "../../testing/index.js";
import type { BuiltRbac } from "./rbac.js";

// Re-export so test files keep their existing import.
export { transactionCase };

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

export const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  ownerId: integer("owner_id").references(() => users.id),
});

// Explicit relations() — required for Drizzle's native `db.query.<table>.findMany({ with: ... })`
// API. We name the forward "one" relation after the FK column (`ownerId`) so it
// coincides with our framework's auto-promoted relation name; the inverse "many"
// is named `todos` on the users side. The introspector merges these with any
// auto-detected FK relations (same name → de-duped).
export const usersRelations = relations(users, ({ many }) => ({
  todos: many(todos),
}));
export const todosRelations = relations(todos, ({ one }) => ({
  ownerId: one(users, { fields: [todos.ownerId], references: [users.id] }),
}));

export const allTables = { users, todos, usersRelations, todosRelations };

// Apply schema to the shared handle on first import. `IF NOT EXISTS` keeps
// this idempotent if multiple files reach into the same singleton in one
// process (the default `node --test` mode forks per file, but we don't
// want to rely on that for correctness).
applySchemaSql(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    owner_id INTEGER REFERENCES users(id)
  );
`);

/** Shared sqlite + drizzle. Test files import these directly; no per-file DB. */
export const sqlite = getSharedSqlite();
// Pass `schema` so the relational query API (`db.query.<jsKey>.findMany`) is
// available — required for the `RbacDb.query.*` tests. Regular select/insert/
// update/delete APIs behave identically regardless of this argument.
export const db = drizzle(sqlite, { schema: allTables });
export type Db = typeof db;

/**
 * Escape hatch: build a fully isolated DB (separate sqlite handle and
 * schema). Use only for tests that need a different schema or rbac config
 * and therefore cannot share the singleton — e.g., the alt-config
 * mutation test in `rbac.test.ts`.
 */
export function freshDb(): { sqlite: Database.Database; db: Db } {
  const s = new Database(":memory:");
  s.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      owner_id INTEGER REFERENCES users(id)
    );
  `);
  return { sqlite: s, db: drizzle(s) };
}

export const ctxFor = (id: number, name = "u") => ({
  user: { id, name } as any,
  session: null,
  batch: new Map<string, unknown>(),
});

export const anonCtx = () => ({
  user: null,
  session: null,
  batch: new Map<string, unknown>(),
}) as any;

/**
 * Insert the canonical three-actor cast and their owned todos. Does NOT
 * assign roles — callers do that, since the role names vary by config.
 *
 *  - Alice owns alice-1 and alice-2
 *  - Bob   owns bob-1
 *  - Carol owns carol-1
 */
export async function insertCast(targetDb: Db = db) {
  const [alice] = await targetDb.insert(users).values({ name: "Alice" }).returning();
  const [bob]   = await targetDb.insert(users).values({ name: "Bob" }).returning();
  const [carol] = await targetDb.insert(users).values({ name: "Carol" }).returning();
  await targetDb.insert(todos).values([
    { title: "alice-1", ownerId: alice.id },
    { title: "alice-2", ownerId: alice.id },
    { title: "bob-1",   ownerId: bob.id   },
    { title: "carol-1", ownerId: carol.id },
  ]);
  return { alice, bob, carol };
}

/** Cast where Alice + Bob are `user` and Carol is `manager`. */
export async function seedUserManager(rbac: BuiltRbac, targetDb: Db = db) {
  const cast = await insertCast(targetDb);
  rbac.assignRole(cast.alice.id, "user");
  rbac.assignRole(cast.bob.id,   "user");
  rbac.assignRole(cast.carol.id, "manager");
  return cast;
}

/** Cast where Alice is `reader`, Bob is `admin`, Carol has no role. */
export async function seedReaderAdmin(rbac: BuiltRbac, targetDb: Db = db) {
  const cast = await insertCast(targetDb);
  rbac.assignRole(cast.alice.id, "reader");
  rbac.assignRole(cast.bob.id,   "admin");
  // Carol intentionally unassigned — used as the no-role actor in deny tests.
  return cast;
}
