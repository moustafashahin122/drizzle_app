import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { graphql, type GraphQLSchema } from "graphql";

import { buildSchema } from "../builder/builder.js";
import { buildRbac } from "./rbac.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./config.js";

// Self-contained schema mirror — keeps the test independent of src/db.ts and
// the on-disk todo.db. RBAC tables (`roles`, `accessRights`, `recordRules`,
// `userRoles`) are populated by the engine's sync routine from code.
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

const ownRows = [["ownerId", "=", "current_user.id"]];
const baseConfig = {
  roles: defineRoles({
    reader: { xid: "test.role.reader" },
    admin: { xid: "test.role.admin", isAdmin: true },
  }),
  accessRights: defineAccessRights({
    reader: {
      todos: { xid: "test.ar.reader.todos", read: true },
    },
  }),
  recordRules: defineRecordRules({
    reader: {
      todos: { read: { xid: "test.rr.reader.todos.read", domain: ownRows } },
    },
  }),
};

let db: ReturnType<typeof drizzle>;
let sqlite: Database.Database;
let schema: GraphQLSchema;
let roleIdByKey: Map<string, number>;

before(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec(createTablesSql());
  db = drizzle(sqlite);
  const rbac = buildRbac(db, rbacSchema, baseConfig);
  schema = buildSchema(db, allTables, { rbac: { enforce: rbac.enforce } }).schema;
  await rbac.sync();
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
});

const userCtx = (id: number, name = "u") => ({
  user: { id, name } as any,
  session: null,
  batch: new Map(),
});

async function run(query: string, contextValue: any, variableValues?: Record<string, unknown>) {
  return graphql({ schema, source: query, contextValue, variableValues });
}

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

describe("rbac — enforcement", () => {
  it("denies unauthenticated callers", async () => {
    await seed();
    const r = await run(`{ todos { id } }`, {
      user: null,
      session: null,
      batch: new Map(),
    });
    assert.match(r.errors?.[0]?.message ?? "", /Not authenticated/);
  });

  it("denies users with no roles", async () => {
    const { u3 } = await seed();
    const r = await run(`{ todos { id } }`, userCtx(u3.id));
    assert.match(r.errors?.[0]?.message ?? "", /Access denied/);
  });

  it("admin role bypasses ACL and record rules — sees every todo", async () => {
    const { u2 } = await seed();
    const r = await run(`{ todos { title } }`, userCtx(u2.id));
    assert.equal(r.errors, undefined);
    const titles = (r.data as any).todos.map((t: any) => t.title).sort();
    assert.deepEqual(titles, ["alice-1", "alice-2", "bob-1", "carol-1"]);
  });

  it("reader sees only their own rows via record rule", async () => {
    const { u1 } = await seed();
    const r = await run(`{ todos { title } }`, userCtx(u1.id));
    assert.equal(r.errors, undefined);
    const titles = (r.data as any).todos.map((t: any) => t.title).sort();
    assert.deepEqual(titles, ["alice-1", "alice-2"]);
  });

  it("reader cannot create todos (no canCreate)", async () => {
    const { u1 } = await seed();
    const r = await run(
      `mutation { insertIntoTodos(values: [{ title: "x", ownerId: ${u1.id} }]) { id } }`,
      userCtx(u1.id),
    );
    assert.match(r.errors?.[0]?.message ?? "", /Access denied/);
  });

  it("update is restricted by the matching record rule", async () => {
    const sqlite2 = new Database(":memory:");
    sqlite2.exec(createTablesSql());
    const db2 = drizzle(sqlite2);
    const own = [["ownerId", "=", "current_user.id"]];
    const cfg = {
      roles: defineRoles({ reader: { xid: "u.role.reader" } }),
      accessRights: defineAccessRights({
        reader: {
          todos: {
            xid: "u.ar.reader.todos",
            read: true,
            update: true,
          },
        },
      }),
      recordRules: defineRecordRules({
        reader: {
          todos: {
            read:   { xid: "u.rr.reader.todos.read",   domain: own },
            update: { xid: "u.rr.reader.todos.update", domain: own },
          },
        },
      }),
    };
    const rbac2 = buildRbac(db2, rbacSchema, cfg);
    const schema2 = buildSchema(db2, allTables, { rbac: { enforce: rbac2.enforce } }).schema;
    await rbac2.sync();

    const [readerRole] = await db2.select({ id: roles.id }).from(roles).where(eq(roles.key, "reader"));
    const [u1] = await db2.insert(users).values({ name: "Alice" }).returning();
    const [u2] = await db2.insert(users).values({ name: "Bob" }).returning();
    await db2.insert(userRoles).values({ userId: u1.id, roleId: readerRole.id });
    await db2.insert(todos).values([
      { title: "alice-1", ownerId: u1.id },
      { title: "bob-1", ownerId: u2.id },
    ]);

    const r = await graphql({
      schema: schema2,
      source: `mutation ($w: JSON) { updateTodos(set: { title: "stolen" }, where: $w) { id title } }`,
      contextValue: userCtx(u1.id),
      variableValues: { w: [["title", "=", "bob-1"]] },
    });
    assert.equal(r.errors, undefined);
    assert.deepEqual((r.data as any).updateTodos, []);
    const [bob] = await db2.select().from(todos).where(eq(todos.title, "bob-1"));
    assert.equal(bob.title, "bob-1");
  });

  it("ignores user_roles rows whose role row was deleted from the snapshot", async () => {
    // Insert a user_roles row pointing at a role id that doesn't exist in
    // the engine snapshot (simulating a stale row racing the sync).
    const [u] = await db.insert(users).values({ name: "Ghost" }).returning();
    // Use a role id that exists (so the FK is satisfied) but isn't admin;
    // 'reader' restricts to own-rows so unowned todos are filtered out.
    await db.insert(userRoles).values({ userId: u.id, roleId: roleIdByKey.get("reader")! });
    await db.insert(todos).values({ title: "anyone" });
    const r = await run(`{ todos { title } }`, userCtx(u.id));
    assert.equal(r.errors, undefined);
    assert.deepEqual((r.data as any).todos, []);
  });

  it("rejects role definitions missing an xid at config-build time", () => {
    assert.throws(
      () =>
        buildRbac(
          db,
          rbacSchema,
          {
            roles: { broken: {} as any },
            accessRights: {},
            recordRules: {},
          },
        ),
      /missing a string 'xid'/,
    );
  });
});
