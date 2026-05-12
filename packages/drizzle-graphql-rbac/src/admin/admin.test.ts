import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { buildAdminRoutes } from "./routes.js";
import { buildAuthRoutes } from "../auth/routes.js";
import { parseSessionCookie } from "../auth/session.js";
import { buildRbac, type BuiltRbac } from "../graphql/rbac/rbac.js";
import { buildRbacDb } from "../graphql/rbac/rbacDb.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "../graphql/rbac/config.js";
import { syncRoles, setUserRole, getUserRole } from "../graphql/rbac/persistence.js";

function cookieFromList(list: string[], name: string): string | null {
  for (const raw of list) {
    const first = raw.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    if (first.slice(0, eq).trim() !== name) continue;
    const v = first.slice(eq + 1).trim();
    return v || null;
  }
  return null;
}

const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
});
const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  roleId: integer("role_id").references((): AnySQLiteColumn => roles.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  userId: integer("user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
});
const allTables = { roles, users, sessions };

const rbacConfig = {
  roles: defineRoles({
    admin: { isAdmin: true },
    user: {},
  }),
  accessRights: defineAccessRights({
    user: {
      users: { read: true, update: true },
    },
  }),
  recordRules: defineRecordRules({}),
};

let db: ReturnType<typeof drizzle>;
let sqlite: Database.Database;
let authApp: ReturnType<typeof buildAuthRoutes>;
let adminApp: ReturnType<typeof buildAdminRoutes>;
let rbac: BuiltRbac;

const adminSchema = { users, sessions, roles };

before(async () => {
  sqlite = new Database(":memory:");
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
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );
  `);
  db = drizzle(sqlite);
  rbac = buildRbac(rbacConfig);
  // Reconcile the `roles` table with the in-code config — same as production startup.
  await syncRoles(db, { roles, users }, rbac.roles());
  const rdbFor = buildRbacDb({ db, schema: allTables, enforce: rbac.enforce });
  authApp = buildAuthRoutes({ db, schema: adminSchema });
  adminApp = buildAdminRoutes({
    db,
    schema: adminSchema,
    usersTable: users,
    rolesTable: roles,
    rdbFor,
    rbac,
  });
});

beforeEach(async () => {
  // DB DELETE wipes per-test state. Roles rows themselves persist across
  // tests (they're code-defined and synced in `before`).
  sqlite.exec(`
    DELETE FROM sessions;
    DELETE FROM users;
  `);
});

async function loginAs(email: string, password: string): Promise<{ token: string }> {
  const res = await authApp.request("/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const list: string[] =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")!]
        : [];
  const token = cookieFromList(list, "sid") ?? parseSessionCookie(res.headers.get("set-cookie"));
  if (!token) {
    throw new Error(`login failed: ${res.status} ${res.headers.get("set-cookie")}`);
  }
  return { token };
}

async function admin(
  auth: { token: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    cookie: `sid=${auth.token}`,
  };
  let init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await adminApp.request(path, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function seedUser(name: string, email: string, password = "secret") {
  const passwordHash = await bcrypt.hash(password, 10);
  const [row] = await db
    .insert(users)
    .values({ name, email, passwordHash, active: true })
    .returning();
  return row;
}

/** Seed user + assign a role via the DB-backed persistence helper. */
async function seedUserWithRole(name: string, email: string, role: string, password = "pw") {
  const u = await seedUser(name, email, password);
  await setUserRole(db, { roles, users }, u.id, role);
  return u;
}

describe("admin REST — /admin/* is admin-only at the middleware layer", () => {
  it("unauthenticated GET /users → 401", async () => {
    const r = await adminApp.request("/users");
    assert.equal(r.status, 401);
  });
  it("authenticated non-admin GET /users → 403 (requireAdmin gate)", async () => {
    await seedUser("Bob", "bob@x.com", "pw");
    const token = await loginAs("bob@x.com", "pw");
    const r = await admin(token, "GET", "/users");
    assert.equal(r.status, 403);
    assert.match(r.body.error, /admin/i);
  });
  it("authenticated non-admin with a non-admin role → 403 on every method", async () => {
    await seedUserWithRole("Bob", "bob@x.com", "user");
    const eve = await seedUser("Eve", "eve@x.com", "pw");
    const token = await loginAs("bob@x.com", "pw");
    for (const [m, p, b] of [
      ["GET", "/users", undefined],
      ["POST", "/users", { name: "x", email: "x@y", password: "p" }],
      ["PATCH", `/users/${eve.id}`, { name: "x" }],
      ["DELETE", `/users/${eve.id}`, undefined],
      ["GET", "/roles", undefined],
      ["GET", `/users/${eve.id}/role`, undefined],
      ["PUT", `/users/${eve.id}/role`, { roleName: "user" }],
      ["DELETE", `/users/${eve.id}/role`, undefined],
    ] as const) {
      const r = await admin(token, m, p, b);
      assert.equal(r.status, 403, `expected 403 on ${m} ${p}, got ${r.status}`);
    }
  });
});

describe("admin REST — /admin/users (RBAC enforced)", () => {
  it("requires auth on every endpoint", async () => {
    const list = await adminApp.request("/users");
    assert.equal(list.status, 401);
    const create = await adminApp.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", email: "x@y", password: "p" }),
    });
    assert.equal(create.status, 401);
  });

  it("denies non-admin callers (no admin role) with 403", async () => {
    await seedUser("Bob", "bob@x.com", "pw");
    const token = await loginAs("bob@x.com", "pw");
    const r = await admin(token, "GET", "/users");
    assert.equal(r.status, 403);
  });

  it("admin can list / create / update / delete users", async () => {
    await seedUserWithRole("Admin", "admin@x.com", "admin");
    const token = await loginAs("admin@x.com", "pw");

    const created = await admin(token, "POST", "/users", {
      name: "Eve", email: "eve@x.com", password: "pw",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.email, "eve@x.com");
    assert.ok(!("passwordHash" in created.body.user));
    const eveId = created.body.user.id;

    const listed = await admin(token, "GET", "/users");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.users.length, 2);

    const patched = await admin(token, "PATCH", `/users/${eveId}`, { active: false });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.user.active, false);

    const deleted = await admin(token, "DELETE", `/users/${eveId}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.id, eveId);

    const after = await admin(token, "GET", "/users");
    assert.equal(after.body.users.length, 1);
  });

  it("create rejects duplicate emails with 409", async () => {
    await seedUserWithRole("Admin", "admin@x.com", "admin");
    const token = await loginAs("admin@x.com", "pw");

    await admin(token, "POST", "/users", {
      name: "Eve", email: "eve@x.com", password: "pw",
    });
    const dup = await admin(token, "POST", "/users", {
      name: "Eve2", email: "eve@x.com", password: "pw",
    });
    assert.equal(dup.status, 409);
  });

  it("update with no editable fields returns 400", async () => {
    const me = await seedUserWithRole("Admin", "admin@x.com", "admin");
    const token = await loginAs("admin@x.com", "pw");

    const r = await admin(token, "PATCH", `/users/${me.id}`, {});
    assert.equal(r.status, 400);
  });
});

describe("admin REST — role assignment", () => {
  it("lists every persisted role with its isAdmin flag", async () => {
    await seedUserWithRole("Admin", "admin@x.com", "admin");
    const token = await loginAs("admin@x.com", "pw");
    const r = await admin(token, "GET", "/roles");
    assert.equal(r.status, 200);
    // Sorted by name; both seeded by syncRoles.
    assert.deepEqual(r.body.roles, [
      { name: "admin", isAdmin: true },
      { name: "user", isAdmin: false },
    ]);
  });

  it("assigns and revokes a role for a user (single-role; overwrite-on-assign)", async () => {
    await seedUserWithRole("Admin", "admin@x.com", "admin");
    const token = await loginAs("admin@x.com", "pw");
    const eve = await seedUser("Eve", "eve@x.com", "pw");

    const before = await admin(token, "GET", `/users/${eve.id}/role`);
    assert.equal(before.status, 200);
    assert.equal(before.body.role, null);

    const assigned = await admin(token, "PUT", `/users/${eve.id}/role`, {
      roleName: "user",
    });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.role.name, "user");

    // PUT is idempotent — second call with the same role keeps state.
    const again = await admin(token, "PUT", `/users/${eve.id}/role`, {
      roleName: "user",
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.role.name, "user");

    const removed = await admin(token, "DELETE", `/users/${eve.id}/role`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.role, null);
  });

  it("rejects assigning a role that isn't defined in code", async () => {
    await seedUserWithRole("Admin", "admin@x.com", "admin");
    const token = await loginAs("admin@x.com", "pw");
    const eve = await seedUser("Eve", "eve@x.com", "pw");
    const r = await admin(token, "PUT", `/users/${eve.id}/role`, {
      roleName: "ghost",
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Unknown role/);
  });

  it("denies non-admin callers from managing roles", async () => {
    await seedUser("Bob", "bob@x.com", "pw");
    const eve = await seedUser("Eve", "eve@x.com", "pw");
    const token = await loginAs("bob@x.com", "pw");
    const r = await admin(token, "PUT", `/users/${eve.id}/role`, {
      roleName: "user",
    });
    assert.equal(r.status, 403);
  });
});

describe("admin REST — admin-role guard", () => {
  it("admin caller CAN grant the admin role", async () => {
    await seedUserWithRole("Admin", "admin@x.com", "admin");
    const eve = await seedUser("Eve", "eve@x.com", "pw");
    const token = await loginAs("admin@x.com", "pw");

    const r = await admin(token, "PUT", `/users/${eve.id}/role`, {
      roleName: "admin",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.userId, eve.id);
    assert.equal(r.body.role.name, "admin");
    assert.equal(r.body.role.isAdmin, true);

    // Verify via direct DB lookup.
    const persisted = await getUserRole(db, { roles, users }, eve.id);
    assert.equal(persisted?.name, "admin");
  });

  it("admin caller CAN revoke the admin role", async () => {
    await seedUserWithRole("Admin", "admin@x.com", "admin");
    const eve = await seedUserWithRole("Eve", "eve@x.com", "admin");
    const token = await loginAs("admin@x.com", "pw");

    const r = await admin(token, "DELETE", `/users/${eve.id}/role`);
    assert.equal(r.status, 200);
    assert.equal(r.body.userId, eve.id);
    assert.equal(r.body.role, null);
    const persisted = await getUserRole(db, { roles, users }, eve.id);
    assert.equal(persisted, null);
  });
});

describe("admin REST — password rotation and deletion invalidate sessions", () => {
  async function seedSession(userId: number, token: string) {
    const [row] = await db
      .insert(sessions)
      .values({
        token,
        userId,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
      .returning();
    return row;
  }

  it("PATCH with password purges only the target user's sessions", async () => {
    await seedUserWithRole("Admin", "admin@x.com", "admin");
    const eve = await seedUser("Eve", "eve@x.com", "pw");
    const other = await seedUser("Other", "other@x.com", "pw");

    await seedSession(eve.id, "eve-token-1");
    await seedSession(eve.id, "eve-token-2");
    await seedSession(other.id, "other-token-1");

    const [eveBefore] = await db.select().from(users).where(eq(users.id, eve.id));
    const oldHash = eveBefore.passwordHash;

    const auth = await loginAs("admin@x.com", "pw");
    const r = await admin(auth, "PATCH", `/users/${eve.id}`, { password: "newpw" });
    assert.equal(r.status, 200);

    const eveSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, eve.id));
    assert.deepEqual(eveSessions, []);

    const otherSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, other.id));
    assert.equal(otherSessions.length, 1);
    assert.equal(otherSessions[0].token, "other-token-1");
    assert.equal(otherSessions[0].userId, other.id);

    const [eveAfter] = await db.select().from(users).where(eq(users.id, eve.id));
    assert.notEqual(eveAfter.passwordHash, oldHash);
  });

  it("PATCH without password does NOT purge sessions", async () => {
    await seedUserWithRole("Admin", "admin@x.com", "admin");
    const eve = await seedUser("Eve", "eve@x.com", "pw");

    await seedSession(eve.id, "eve-token-1");
    await seedSession(eve.id, "eve-token-2");

    const [eveBefore] = await db.select().from(users).where(eq(users.id, eve.id));
    const oldHash = eveBefore.passwordHash;

    const auth = await loginAs("admin@x.com", "pw");
    const r = await admin(auth, "PATCH", `/users/${eve.id}`, { name: "new name" });
    assert.equal(r.status, 200);

    const eveSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, eve.id))
      .orderBy(sessions.token);
    assert.equal(eveSessions.length, 2);
    assert.equal(eveSessions[0].token, "eve-token-1");
    assert.equal(eveSessions[0].userId, eve.id);
    assert.equal(eveSessions[1].token, "eve-token-2");
    assert.equal(eveSessions[1].userId, eve.id);

    const [eveAfter] = await db.select().from(users).where(eq(users.id, eve.id));
    assert.equal(eveAfter.passwordHash, oldHash);
  });

  it("DELETE /users/:id cascades to the user's sessions only", async () => {
    await seedUserWithRole("Admin", "admin@x.com", "admin");
    const eve = await seedUser("Eve", "eve@x.com", "pw");
    const other = await seedUser("Other", "other@x.com", "pw");

    await seedSession(eve.id, "eve-token-1");
    await seedSession(eve.id, "eve-token-2");
    await seedSession(other.id, "other-token-1");

    const auth = await loginAs("admin@x.com", "pw");
    const r = await admin(auth, "DELETE", `/users/${eve.id}`);
    assert.equal(r.status, 200);

    const eveSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, eve.id));
    assert.deepEqual(eveSessions, []);

    const otherSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, other.id));
    assert.equal(otherSessions.length, 1);
    assert.equal(otherSessions[0].token, "other-token-1");
    assert.equal(otherSessions[0].userId, other.id);
  });
});
