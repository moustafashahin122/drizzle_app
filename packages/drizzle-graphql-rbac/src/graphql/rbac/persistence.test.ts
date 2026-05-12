/**
 * Tests for the DB-backed RBAC persistence layer (`./persistence.ts`):
 * `syncRoles`, `getUserRole`, `setUserRole`, `listRoles`.
 *
 * Uses isolated in-memory sqlite per test (not the shared handle) so we can
 * exercise the real `roles` + `users` tables from `../../tables.ts` — these
 * tests are about that exact schema, not the simplified one in `__helpers__`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";

import { roles, users, type Role } from "../../tables.js";
import {
  syncRoles,
  getUserRole,
  setUserRole,
  listRoles,
} from "./persistence.js";
import type { ResolvedRole } from "./config.js";

type Db = BetterSQLite3Database<{ roles: typeof roles; users: typeof users }>;

const schema = { roles, users };

const role = (key: string, isAdmin = false): ResolvedRole => ({ key, isAdmin });

/** Build a fresh in-memory DB with the framework's user/role schema. */
function freshDb(): { sqlite: Database.Database; db: Db } {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema: { roles, users } }) as unknown as Db };
}

async function insertUser(db: Db, name: string, email: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ name, email, passwordHash: "x" })
    .returning();
  return row.id;
}

describe("syncRoles", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  it("inserts code-declared roles on a fresh DB", async () => {
    const out = await syncRoles(db, schema, [role("admin", true), role("user")]);
    const names = out.map((r) => r.name).sort();
    assert.deepEqual(names, ["admin", "user"]);
    const adminRow = out.find((r) => r.name === "admin")!;
    assert.equal(adminRow.isAdmin, true);
    assert.equal(out.find((r) => r.name === "user")!.isAdmin, false);
  });

  it("is idempotent — second call with the same config is a no-op", async () => {
    await syncRoles(db, schema, [role("user"), role("admin", true)]);
    const before: Role[] = await db.select().from(roles);
    await syncRoles(db, schema, [role("user"), role("admin", true)]);
    const after: Role[] = await db.select().from(roles);
    assert.deepEqual(
      after.map((r) => ({ id: r.id, name: r.name, isAdmin: r.isAdmin })),
      before.map((r) => ({ id: r.id, name: r.name, isAdmin: r.isAdmin })),
    );
  });

  it("deletes DB-only orphans and nulls users that reference them", async () => {
    // First start: roles `user` + `legacy` exist.
    const initial = await syncRoles(db, schema, [role("user"), role("legacy")]);
    const legacyId = initial.find((r) => r.name === "legacy")!.id;

    // A user points at the soon-to-be-deleted `legacy` role.
    const uid = await insertUser(db, "Mallory", "m@example.com");
    await db.update(users).set({ roleId: legacyId }).where(eq(users.id, uid));

    // Second start: `legacy` removed from code.
    const after = await syncRoles(db, schema, [role("user")]);
    assert.deepEqual(after.map((r) => r.name).sort(), ["user"]);

    // The dangling FK is nulled, not cascade-deleted.
    const [u] = await db.select().from(users).where(eq(users.id, uid));
    assert.equal(u.roleId, null);
  });

  it("invalidates is_admin on survivors — code config wins on drift", async () => {
    await syncRoles(db, schema, [role("manager", false)]);
    // Drift the DB: someone flips is_admin manually.
    await db.update(roles).set({ isAdmin: true }).where(eq(roles.name, "manager"));
    const drifted = (await db.select().from(roles)).find((r) => r.name === "manager")!;
    assert.equal(drifted.isAdmin, true);

    // Re-sync with the original code value — DB gets stomped.
    await syncRoles(db, schema, [role("manager", false)]);
    const fixed = (await db.select().from(roles)).find((r) => r.name === "manager")!;
    assert.equal(fixed.isAdmin, false);
    // Same row id — survivors are updated, not re-inserted.
    assert.equal(fixed.id, drifted.id);
  });

  it("handles the mixed case: insert + delete + drift in one call", async () => {
    await syncRoles(db, schema, [role("user"), role("legacy"), role("admin", false)]);
    // Drift admin to admin=true (will be stomped back).
    // Code change: drop `legacy`, add `manager`, set `admin` back to true.
    const out = await syncRoles(db, schema, [
      role("user"),
      role("admin", true),
      role("manager"),
    ]);
    const byName = Object.fromEntries(out.map((r) => [r.name, r.isAdmin]));
    assert.deepEqual(byName, { user: false, admin: true, manager: false });
  });

  it("treats a no-op call (empty code config matches empty DB) cleanly", async () => {
    const out = await syncRoles(db, schema, []);
    assert.deepEqual(out, []);
  });

  it("deletes every DB role when code declares none — and unhooks users first", async () => {
    const initial = await syncRoles(db, schema, [role("user")]);
    const uid = await insertUser(db, "X", "x@e.com");
    await db
      .update(users)
      .set({ roleId: initial[0].id })
      .where(eq(users.id, uid));

    const after = await syncRoles(db, schema, []);
    assert.deepEqual(after, []);
    const [u] = await db.select().from(users).where(eq(users.id, uid));
    assert.equal(u.roleId, null);
  });
});

describe("getUserRole", () => {
  let db: Db;
  beforeEach(async () => {
    db = freshDb().db;
    await syncRoles(db, schema, [role("user"), role("admin", true)]);
  });

  it("returns null for a roleless user", async () => {
    const uid = await insertUser(db, "A", "a@e.com");
    const r = await getUserRole(db, schema, uid);
    assert.equal(r, null);
  });

  it("returns null for a non-existent user", async () => {
    const r = await getUserRole(db, schema, 9999);
    assert.equal(r, null);
  });

  it("returns the row with name + isAdmin for an assigned user", async () => {
    const uid = await insertUser(db, "B", "b@e.com");
    await setUserRole(db, schema, uid, "admin");
    const r = await getUserRole(db, schema, uid);
    assert.ok(r);
    assert.equal(r!.name, "admin");
    assert.equal(r!.isAdmin, true);
  });
});

describe("setUserRole", () => {
  let db: Db;
  beforeEach(async () => {
    db = freshDb().db;
    await syncRoles(db, schema, [role("user"), role("admin", true)]);
  });

  it("assigns a role by name and returns the row", async () => {
    const uid = await insertUser(db, "C", "c@e.com");
    const assigned = await setUserRole(db, schema, uid, "user");
    assert.ok(assigned);
    assert.equal(assigned!.name, "user");
    const reloaded = await getUserRole(db, schema, uid);
    assert.equal(reloaded!.name, "user");
  });

  it("clears the role when passed null", async () => {
    const uid = await insertUser(db, "D", "d@e.com");
    await setUserRole(db, schema, uid, "user");
    const cleared = await setUserRole(db, schema, uid, null);
    assert.equal(cleared, null);
    assert.equal(await getUserRole(db, schema, uid), null);
  });

  it("throws on an unknown role name", async () => {
    const uid = await insertUser(db, "E", "e@e.com");
    await assert.rejects(
      () => setUserRole(db, schema, uid, "ghost"),
      /rbac: unknown role 'ghost'/,
    );
  });

  it("overwrites a previous role (one-role-per-user)", async () => {
    const uid = await insertUser(db, "F", "f@e.com");
    await setUserRole(db, schema, uid, "user");
    await setUserRole(db, schema, uid, "admin");
    const r = await getUserRole(db, schema, uid);
    assert.equal(r!.name, "admin");
    assert.equal(r!.isAdmin, true);
  });
});

describe("listRoles", () => {
  it("returns every persisted role row, post-sync", async () => {
    const { db } = freshDb();
    await syncRoles(db, schema, [role("user"), role("admin", true), role("manager")]);
    const rows = await listRoles(db, schema);
    assert.deepEqual(
      rows.map((r) => r.name).sort(),
      ["admin", "manager", "user"],
    );
  });

  it("returns an empty array on a DB with no synced roles", async () => {
    const { db } = freshDb();
    const rows = await listRoles(db, schema);
    assert.deepEqual(rows, []);
  });
});
