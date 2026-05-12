/**
 * Domain-specific test fixtures for the RBAC module.
 *
 * Tables (`users`, `roles`, `todos`) are declared once, the schema is applied
 * to the framework's shared singleton sqlite handle at module load, and the
 * drizzle wrapper is exported so every test file in this directory works
 * against the same connection. Per-test rollback is handled by
 * `transactionCase` (see `../../testing/`).
 *
 * Roles are real DB rows in this fixture (mirroring production: `roles` table
 * holds the role definitions, `users.role_id` holds each user's assignment).
 * The `assignRole(rbac, userId, name)` helper writes both — it's effectively
 * the production `setUserRole`, adapted to the test schema. `ctxFor(userId)`
 * loads the role back via a single FK JOIN, again mirroring production.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, relations } from "drizzle-orm";
import { sqliteTable, integer, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import {
  applySchemaSql,
  getSharedSqlite,
  transactionCase,
} from "../../testing/index.js";
import type { BuiltRbac, RbacContext, ResolvedUserRole } from "./rbac.js";

// Re-export so test files keep their existing import.
export { transactionCase };

export const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  roleId: integer("role_id").references((): AnySQLiteColumn => roles.id, {
    onDelete: "set null",
  }),
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

export const allTables = { users, roles, todos, usersRelations, todosRelations };

// Apply schema to the shared handle on first import. `IF NOT EXISTS` so
// modules sharing the handle can call this safely.
applySchemaSql(`
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    owner_id INTEGER REFERENCES users(id)
  );
`);

/** Shared sqlite + drizzle. */
export const sqlite = getSharedSqlite();
export const db = drizzle(sqlite, { schema: allTables });
export type Db = typeof db;

/** Build an isolated DB with the engine's test schema. */
export function freshDb(): { sqlite: Database.Database; db: Db } {
  const s = new Database(":memory:");
  s.exec(`
    CREATE TABLE roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL
    );
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      owner_id INTEGER REFERENCES users(id)
    );
  `);
  return { sqlite: s, db: drizzle(s, { schema: allTables }) };
}

// ---------------------------------------------------------------------------
// DB-backed role assignment helpers.
//
// `assignRole` upserts the role row from the engine's in-code config (so the
// `roles` table reflects what the rbac instance knows about) and points
// `users.role_id` at it. `ctxFor` reads the role back from the DB via the
// same FK join `sessionMiddleware` uses in production. The savepoint-based
// `transactionCase` rolls these DB writes back between tests.
// ---------------------------------------------------------------------------

/**
 * Ensure a `roles` row exists for `name` (using is_admin from the engine's
 * config) and point `users.role_id` at it. Throws if the engine doesn't
 * recognise the role name — same contract as production `setUserRole`.
 */
export async function assignRole(
  rbac: BuiltRbac,
  userId: number,
  roleName: string,
  targetDb: Db = db,
): Promise<void> {
  const def = rbac.findRole(roleName);
  if (!def) throw new Error(`rbac: unknown role '${roleName}'`);
  let [row] = await targetDb.select().from(roles).where(eq(roles.name, def.key)).limit(1);
  if (!row) {
    [row] = await targetDb
      .insert(roles)
      .values({ name: def.key, isAdmin: def.isAdmin })
      .returning();
  }
  await targetDb.update(users).set({ roleId: row.id }).where(eq(users.id, userId));
}

/** Clear a user's role (sets `users.role_id` to NULL). */
export async function revokeRole(
  userId: number,
  targetDb: Db = db,
): Promise<void> {
  await targetDb.update(users).set({ roleId: null }).where(eq(users.id, userId));
}

/**
 * Read back the name of the role currently assigned to a user, or `null`.
 * Single FK JOIN — same shape as production `getUserRole`.
 */
export async function userRoleName(
  userId: number,
  targetDb: Db = db,
): Promise<string | null> {
  const [row] = await targetDb
    .select({ name: roles.name })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId))
    .limit(1);
  return row?.name ?? null;
}

/**
 * Synchronously load the persisted role for a user via better-sqlite3.
 * `.all()` on a sqlite drizzle handle returns rows sync — same FK JOIN as
 * production `getUserRole`, just executed in a sync context so test bodies
 * don't need to `await` every ctx build.
 */
function loadRoleSync(userId: number, targetDb: Db): ResolvedUserRole | null {
  const rows = targetDb
    .select({ name: roles.name, isAdmin: roles.isAdmin })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId))
    .limit(1)
    .all();
  const row = rows[0];
  return row ? { name: row.name, isAdmin: !!row.isAdmin } : null;
}

/**
 * Build an authenticated test ctx. Without a second argument, looks up the
 * role from the shared DB. Pass an explicit `ResolvedUserRole | null` to
 * override, or a target `Db` to load from a different connection (used by
 * `freshDb`-based tests).
 */
export function ctxFor(
  id: number,
  roleOrDb: ResolvedUserRole | null | Db | undefined = undefined,
  name = "u",
): RbacContext & { session: null } {
  let role: ResolvedUserRole | null;
  if (roleOrDb === undefined) {
    role = loadRoleSync(id, db);
  } else if (roleOrDb !== null && typeof (roleOrDb as Db).select === "function") {
    role = loadRoleSync(id, roleOrDb as Db);
  } else {
    role = roleOrDb as ResolvedUserRole | null;
  }
  return {
    user: { id, name } as any,
    role,
    session: null,
    batch: new Map<string, unknown>(),
  };
}

export const anonCtx = () => ({
  user: null,
  role: null,
  session: null,
  batch: new Map<string, unknown>(),
}) as any;

/**
 * Insert the canonical three-actor cast and their owned todos.
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
  await assignRole(rbac, cast.alice.id, "user", targetDb);
  await assignRole(rbac, cast.bob.id,   "user", targetDb);
  await assignRole(rbac, cast.carol.id, "manager", targetDb);
  return cast;
}

/** Cast where Alice is `reader`, Bob is `admin`, Carol has no role. */
export async function seedReaderAdmin(rbac: BuiltRbac, targetDb: Db = db) {
  const cast = await insertCast(targetDb);
  await assignRole(rbac, cast.alice.id, "reader", targetDb);
  await assignRole(rbac, cast.bob.id,   "admin", targetDb);
  return cast;
}
