import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { buildAdminRoutes } from "./routes.js";
import { buildAuthRoutes } from "../auth/routes.js";
import { parseSessionCookie, CSRF_COOKIE_NAME } from "../auth/session.js";

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
import { buildRbac, type BuiltRbac } from "../graphql/rbac/rbac.js";
import { buildRbacDb } from "../graphql/rbac/rbacDb.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "../graphql/rbac/config.js";

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  userId: integer("user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
});
const allTables = { users, sessions };

const rbacConfig = {
  roles: defineRoles({
    admin: { isAdmin: true },
    user: {},
  }),
  accessRights: defineAccessRights({}),
  recordRules: defineRecordRules({}),
};

let db: ReturnType<typeof drizzle>;
let sqlite: Database.Database;
let authApp: ReturnType<typeof buildAuthRoutes>;
let adminApp: ReturnType<typeof buildAdminRoutes>;
let rbac: BuiltRbac;

before(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
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
  const rdbFor = buildRbacDb({ db, schema: allTables, enforce: rbac.enforce });
  authApp = buildAuthRoutes({ db, schema: { users, sessions } });
  adminApp = buildAdminRoutes({
    db,
    schema: { users, sessions },
    usersTable: users,
    rdbFor,
    rbac,
  });
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM sessions;
    DELETE FROM users;
  `);
  for (let id = 1; id < 1000; id++) {
    for (const key of rbac.listUserRoles(id)) rbac.revokeRole(id, key);
  }
});

async function loginAs(email: string, password: string): Promise<{ token: string; csrf: string }> {
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
  const csrf = cookieFromList(list, CSRF_COOKIE_NAME);
  if (!token || !csrf) {
    throw new Error(`login failed: ${res.status} ${res.headers.get("set-cookie")}`);
  }
  return { token, csrf };
}

async function admin(
  auth: { token: string; csrf: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    cookie: `sid=${auth.token}; csrf_token=${auth.csrf}`,
    "x-csrf-token": auth.csrf,
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

  it("denies non-admin callers (no canRead grant) with 403", async () => {
    await seedUser("Bob", "bob@x.com", "pw");
    const token = await loginAs("bob@x.com", "pw");
    const r = await admin(token, "GET", "/users");
    assert.equal(r.status, 403);
  });

  it("admin can list / create / update / delete users", async () => {
    const me = await seedUser("Admin", "admin@x.com", "pw");
    rbac.assignRole(me.id, "admin");
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
    const me = await seedUser("Admin", "admin@x.com", "pw");
    rbac.assignRole(me.id, "admin");
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
    const me = await seedUser("Admin", "admin@x.com", "pw");
    rbac.assignRole(me.id, "admin");
    const token = await loginAs("admin@x.com", "pw");

    const r = await admin(token, "PATCH", `/users/${me.id}`, {});
    assert.equal(r.status, 400);
  });
});

describe("admin REST — role membership", () => {
  it("lists every code-defined role key", async () => {
    const me = await seedUser("Admin", "admin@x.com", "pw");
    rbac.assignRole(me.id, "admin");
    const token = await loginAs("admin@x.com", "pw");
    const r = await admin(token, "GET", "/roles");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.roles, ["admin", "user"]);
  });

  it("assigns and revokes a role for a user (idempotent)", async () => {
    const me = await seedUser("Admin", "admin@x.com", "pw");
    rbac.assignRole(me.id, "admin");
    const token = await loginAs("admin@x.com", "pw");
    const eve = await seedUser("Eve", "eve@x.com", "pw");

    const before = await admin(token, "GET", `/users/${eve.id}/roles`);
    assert.deepEqual(before.body.roles, []);

    const assigned = await admin(token, "POST", `/users/${eve.id}/roles`, {
      roleKey: "user",
    });
    assert.equal(assigned.status, 201);
    assert.deepEqual(assigned.body.roles, ["user"]);

    const again = await admin(token, "POST", `/users/${eve.id}/roles`, {
      roleKey: "user",
    });
    assert.equal(again.status, 201);
    assert.deepEqual(again.body.roles, ["user"]);

    const removed = await admin(token, "DELETE", `/users/${eve.id}/roles/user`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.roles, []);
  });

  it("rejects assigning a role that isn't defined in code", async () => {
    const me = await seedUser("Admin", "admin@x.com", "pw");
    rbac.assignRole(me.id, "admin");
    const token = await loginAs("admin@x.com", "pw");
    const eve = await seedUser("Eve", "eve@x.com", "pw");
    const r = await admin(token, "POST", `/users/${eve.id}/roles`, {
      roleKey: "ghost",
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Unknown role/);
  });

  it("denies non-admin callers from managing memberships", async () => {
    const me = await seedUser("Bob", "bob@x.com", "pw");
    const eve = await seedUser("Eve", "eve@x.com", "pw");
    const token = await loginAs("bob@x.com", "pw");
    void me;
    const r = await admin(token, "POST", `/users/${eve.id}/roles`, {
      roleKey: "user",
    });
    assert.equal(r.status, 403);
  });
});
