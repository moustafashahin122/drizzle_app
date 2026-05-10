import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";

import { buildRbac } from "./rbac.js";
import { buildRbacDb } from "./rbacDb.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./config.js";

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});
const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  ownerId: integer("owner_id").references(() => users.id),
});
const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  xid: text("xid").notNull().unique(),
  key: text("key").notNull().unique(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
});
const accessRights = sqliteTable(
  "access_rights",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    xid: text("xid").notNull().unique(),
    roleId: integer("role_id").notNull().references(() => roles.id),
    resource: text("resource").notNull(),
    canCreate: integer("can_create", { mode: "boolean" }).notNull().default(false),
    canRead: integer("can_read", { mode: "boolean" }).notNull().default(false),
    canUpdate: integer("can_update", { mode: "boolean" }).notNull().default(false),
    canDelete: integer("can_delete", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({ uniqRoleResource: uniqueIndex("ar_role_resource_uniq").on(t.roleId, t.resource) }),
);
const recordRules = sqliteTable(
  "record_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    xid: text("xid").notNull().unique(),
    roleId: integer("role_id").notNull().references(() => roles.id),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    domain: text("domain").notNull(),
  },
  (t) => ({ uniqRoleResAct: uniqueIndex("rr_role_res_act_uniq").on(t.roleId, t.resource, t.action) }),
);
const userRoles = sqliteTable(
  "user_roles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id),
    roleId: integer("role_id").notNull().references(() => roles.id),
  },
  (t) => ({ uniqUserRole: uniqueIndex("ur_user_role_uniq").on(t.userId, t.roleId) }),
);

const allTables = { users, todos, roles, accessRights, recordRules, userRoles };
const rbacSchema = { roles, accessRights, recordRules, userRoles };

function createTablesSql(): string {
  return `
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      owner_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      xid TEXT NOT NULL UNIQUE,
      key TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE access_rights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      xid TEXT NOT NULL UNIQUE,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      resource TEXT NOT NULL,
      can_create INTEGER NOT NULL DEFAULT 0,
      can_read INTEGER NOT NULL DEFAULT 0,
      can_update INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX ar_role_resource_uniq ON access_rights(role_id, resource);
    CREATE TABLE record_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      xid TEXT NOT NULL UNIQUE,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      resource TEXT NOT NULL,
      action TEXT NOT NULL,
      domain TEXT NOT NULL
    );
    CREATE UNIQUE INDEX rr_role_res_act_uniq ON record_rules(role_id, resource, action);
    CREATE TABLE user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      role_id INTEGER NOT NULL REFERENCES roles(id)
    );
    CREATE UNIQUE INDEX ur_user_role_uniq ON user_roles(user_id, role_id);
  `;
}

const own = [["ownerId", "=", "current_user.id"]];
const rbacConfig = {
  roles: defineRoles({
    reader: { xid: "t.role.reader" },
    admin: { xid: "t.role.admin", isAdmin: true },
  }),
  accessRights: defineAccessRights({
    reader: {
      todos: {
        xid: "t.ar.reader.todos",
        read: true,
        update: true,
        delete: true,
      },
    },
  }),
  recordRules: defineRecordRules({
    reader: {
      todos: {
        read:   { xid: "t.rr.reader.todos.read",   domain: own },
        update: { xid: "t.rr.reader.todos.update", domain: own },
        delete: { xid: "t.rr.reader.todos.delete", domain: own },
      },
    },
  }),
};

let db: ReturnType<typeof drizzle>;
let sqlite: Database.Database;
let rdbFor: ReturnType<typeof buildRbacDb>;
let rbacRef: ReturnType<typeof buildRbac>;
let roleIdByKey: Map<string, number>;

before(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec(createTablesSql());
  db = drizzle(sqlite);
  rbacRef = buildRbac(db, rbacSchema, rbacConfig);
  rdbFor = buildRbacDb({ db, schema: allTables, enforce: rbacRef.enforce });
  await rbacRef.sync();
  const rows: { key: string; id: number }[] = await db
    .select({ id: roles.id, key: roles.key })
    .from(roles);
  roleIdByKey = new Map(rows.map((r) => [r.key, r.id]));
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM user_roles;
    DELETE FROM todos;
    DELETE FROM users;
  `);
  rbacRef.clearCache();
});

const ctxFor = (id: number, name = "u") => ({
  user: { id, name } as any,
  session: null,
  batch: new Map<string, unknown>(),
});

async function seed() {
  const [u1] = await db.insert(users).values({ name: "Alice" }).returning();
  const [u2] = await db.insert(users).values({ name: "Bob" }).returning();
  const [u3] = await db.insert(users).values({ name: "Carol" }).returning();
  await db.insert(userRoles).values([
    { userId: u1.id, roleId: roleIdByKey.get("reader")! },
    { userId: u2.id, roleId: roleIdByKey.get("admin")! },
  ]);
  await db.insert(todos).values([
    { title: "alice-1", ownerId: u1.id },
    { title: "alice-2", ownerId: u1.id },
    { title: "bob-1", ownerId: u2.id },
    { title: "carol-1", ownerId: u3.id },
  ]);
  return { u1, u2, u3 };
}

describe("rbacDb — select", () => {
  it("admin sees every row", async () => {
    const { u2 } = await seed();
    const rdb = rdbFor(ctxFor(u2.id));
    const rows = await rdb.select().from(todos);
    assert.equal(rows.length, 4);
  });

  it("reader narrows to own rows via record rule", async () => {
    const { u1 } = await seed();
    const rdb = rdbFor(ctxFor(u1.id));
    const rows = await rdb.select().from(todos);
    const titles = rows.map((r: any) => r.title).sort();
    assert.deepEqual(titles, ["alice-1", "alice-2"]);
  });

  it("reader's user-where AND-s with the record-rule where", async () => {
    const { u1 } = await seed();
    const rdb = rdbFor(ctxFor(u1.id));
    const rows = await rdb.select().from(todos).where(eq(todos.title, "bob-1"));
    assert.deepEqual(rows, []);
  });

  it("denies users with no roles", async () => {
    const { u3 } = await seed();
    const rdb = rdbFor(ctxFor(u3.id));
    await assert.rejects(
      () => rdb.select().from(todos),
      /Access denied/,
    );
  });

  it("denies unauthenticated callers", async () => {
    await seed();
    const rdb = rdbFor({ user: null, batch: new Map() } as any);
    await assert.rejects(
      () => rdb.select().from(todos),
      /Not authenticated/,
    );
  });

  it("forwards orderBy and limit through the proxy", async () => {
    const { u2 } = await seed();
    const rdb = rdbFor(ctxFor(u2.id));
    const rows = await rdb.select().from(todos).orderBy(todos.id).limit(2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].title, "alice-1");
  });
});

describe("rbacDb — update", () => {
  it("reader update is narrowed to their own rows", async () => {
    const { u1 } = await seed();
    const rdb = rdbFor(ctxFor(u1.id));
    const updated = await rdb
      .update(todos)
      .set({ title: "stolen" })
      .where(eq(todos.title, "bob-1"))
      .returning();
    assert.deepEqual(updated, []);
    const [bob] = await db.select().from(todos).where(eq(todos.title, "bob-1"));
    assert.equal(bob.title, "bob-1");
  });

  it("reader can update their own row", async () => {
    const { u1 } = await seed();
    const rdb = rdbFor(ctxFor(u1.id));
    const updated = await rdb
      .update(todos)
      .set({ title: "renamed" })
      .where(eq(todos.title, "alice-1"))
      .returning();
    assert.equal(updated.length, 1);
    assert.equal(updated[0].title, "renamed");
  });
});

describe("rbacDb — delete", () => {
  it("reader cannot delete other users' rows", async () => {
    const { u1 } = await seed();
    const rdb = rdbFor(ctxFor(u1.id));
    const deleted = await rdb
      .delete(todos)
      .where(eq(todos.title, "bob-1"))
      .returning();
    assert.deepEqual(deleted, []);
    const remaining = await db.select().from(todos);
    assert.equal(remaining.length, 4);
  });
});

describe("rbacDb — insert", () => {
  it("ACL gate — no canCreate denies", async () => {
    const { u1 } = await seed();
    const rdb = rdbFor(ctxFor(u1.id));
    await assert.rejects(
      () => rdb.insert(todos).values({ title: "x", ownerId: u1.id }).returning(),
      /Access denied/,
    );
  });

  it("ACL gate — canCreate allows when granted via a different config", async () => {
    const sqlite2 = new Database(":memory:");
    sqlite2.exec(createTablesSql());
    const db2 = drizzle(sqlite2);
    const cfg = {
      roles: defineRoles({ reader: { xid: "t2.role.reader" } }),
      accessRights: defineAccessRights({
        reader: {
          todos: { xid: "t2.ar.reader.todos", create: true, read: true },
        },
      }),
      recordRules: defineRecordRules({}),
    };
    const rbac2 = buildRbac(db2, rbacSchema, cfg);
    const rdb2For = buildRbacDb({ db: db2, schema: allTables, enforce: rbac2.enforce });
    await rbac2.sync();

    const [readerRole] = await db2.select({ id: roles.id }).from(roles).where(eq(roles.key, "reader"));
    const [u] = await db2.insert(users).values({ name: "Alice" }).returning();
    await db2.insert(userRoles).values({ userId: u.id, roleId: readerRole.id });
    const rdb = rdb2For(ctxFor(u.id));
    const out = await rdb
      .insert(todos)
      .values({ title: "fresh", ownerId: u.id })
      .returning();
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "fresh");
  });
});

describe("rbacDb — bypass and escape hatch", () => {
  it("bypassResources passes through to raw db", async () => {
    const { u3 } = await seed();
    const bypassRdbFor = buildRbacDb({
      db,
      schema: allTables,
      enforce: rbacRef.enforce,
      bypassResources: new Set(["todos"]),
    });
    const rdb = bypassRdbFor(ctxFor(u3.id)); // u3 has no roles
    const rows = await rdb.select().from(todos);
    assert.equal(rows.length, 4);
  });

  it("rdb.raw is the unwrapped db", async () => {
    const { u3 } = await seed();
    const rdb = rdbFor(ctxFor(u3.id));
    const rows = await rdb.raw.select().from(todos);
    assert.equal(rows.length, 4);
  });
});
