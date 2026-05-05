import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { graphql, type GraphQLSchema } from "graphql";

import { buildSchema } from "./builder.js";
import { buildRbac, parseDomain, domainToSql } from "./rbac.js";
import type { ColumnMap } from "./filters.js";

// Self-contained schema mirror — keeps the test independent of src/db.ts and
// the on-disk todo.db.
const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});
const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  ownerId: integer("owner_id").references(() => users.id),
});
const groups = sqliteTable("groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  parentGroupId: integer("parent_group_id"),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
});
const userGroups = sqliteTable("user_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  groupId: integer("group_id").notNull().references(() => groups.id),
});
const accessRights = sqliteTable("access_rights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: integer("group_id").notNull().references(() => groups.id),
  resource: text("resource").notNull(),
  canCreate: integer("can_create", { mode: "boolean" }).notNull().default(false),
  canRead: integer("can_read", { mode: "boolean" }).notNull().default(false),
  canUpdate: integer("can_update", { mode: "boolean" }).notNull().default(false),
  canDelete: integer("can_delete", { mode: "boolean" }).notNull().default(false),
});
const recordRules = sqliteTable("record_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: integer("group_id").notNull().references(() => groups.id),
  resource: text("resource").notNull(),
  permType: text("perm_type").notNull(),
  domain: text("domain").notNull(),
});

const rbacTables = { groups, userGroups, accessRights, recordRules };
const allTables = { users, todos, ...rbacTables };

let db: ReturnType<typeof drizzle>;
let sqlite: Database.Database;
let schema: GraphQLSchema;

before(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      owner_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      parent_group_id INTEGER,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      group_id INTEGER NOT NULL REFERENCES groups(id)
    );
    CREATE TABLE access_rights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id),
      resource TEXT NOT NULL,
      can_create INTEGER NOT NULL DEFAULT 0,
      can_read INTEGER NOT NULL DEFAULT 0,
      can_update INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE record_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id),
      resource TEXT NOT NULL,
      perm_type TEXT NOT NULL,
      domain TEXT NOT NULL
    );
  `);
  db = drizzle(sqlite);
  const rbac = buildRbac(db, rbacTables);
  schema = buildSchema(db, allTables, {
    rbac: { enforce: rbac.enforce },
  }).schema;
});

beforeEach(() => {
  // Reset every table; reuse the same SQLite file between cases.
  sqlite.exec(`
    DELETE FROM record_rules;
    DELETE FROM access_rights;
    DELETE FROM user_groups;
    DELETE FROM groups;
    DELETE FROM todos;
    DELETE FROM users;
    DELETE FROM sqlite_sequence;
  `);
});

const userCtx = (id: number, name = "u") => ({
  user: { id, name } as any,
  session: null,
  batch: new Map(),
});

async function run(query: string, contextValue: any) {
  return graphql({ schema, source: query, contextValue });
}

// ---------------------------------------------------------------------------
// Domain parser unit tests
// ---------------------------------------------------------------------------

describe("rbac — domain parser", () => {
  it("parses a single leaf as the root", () => {
    const node = parseDomain([["state", "=", "draft"]]);
    assert.deepEqual(node, { kind: "leaf", field: "state", op: "=", value: "draft" });
  });

  it("implicit AND across top-level leaves", () => {
    const node = parseDomain([
      ["a", "=", 1],
      ["b", "=", 2],
    ]);
    assert.equal(node.kind, "and");
  });

  it("'|' takes the next two sub-expressions in prefix order", () => {
    const node = parseDomain([
      "|",
      ["a", "=", 1],
      ["b", "=", 2],
    ]);
    assert.equal(node.kind, "or");
  });

  it("'!' negates a single sub-expression", () => {
    const node = parseDomain(["!", ["a", "=", 1]]);
    assert.equal(node.kind, "not");
  });

  it("rejects truncated operator", () => {
    assert.throws(() => parseDomain(["&", ["a", "=", 1]]), /truncated/);
  });

  it("substitutes current_user.id placeholder via domainToSql", () => {
    const node = parseDomain([["owner_id", "=", "current_user.id"]]);
    const cols = { owner_id: todos.ownerId } as unknown as ColumnMap;
    const sql = domainToSql(node, cols, { id: 42 } as any);
    // We can't easily inspect the SQL params without a query; assert it built.
    assert.ok(sql);
  });
});

// ---------------------------------------------------------------------------
// Engine end-to-end via the built GraphQL schema
// ---------------------------------------------------------------------------

async function seed() {
  // Two users, one in a "Reader" group with read-only access on todos
  // restricted to their own rows; the other in an "Admin" bypass group.
  const [u1] = await db.insert(users).values({ name: "Alice" }).returning();
  const [u2] = await db.insert(users).values({ name: "Bob" }).returning();
  const [u3] = await db.insert(users).values({ name: "Carol" }).returning();

  const [reader] = await db
    .insert(groups)
    .values({ name: "Reader" })
    .returning();
  const [admin] = await db
    .insert(groups)
    .values({ name: "Admin", isAdmin: true })
    .returning();

  await db.insert(userGroups).values([
    { userId: u1.id, groupId: reader.id },
    { userId: u2.id, groupId: admin.id },
    // u3 has no groups — total denial.
  ]);

  await db.insert(accessRights).values({
    groupId: reader.id,
    resource: "todos",
    canRead: true,
  });

  await db.insert(recordRules).values({
    groupId: reader.id,
    resource: "todos",
    permType: "read",
    domain: JSON.stringify([["ownerId", "=", "current_user.id"]]),
  });

  await db.insert(todos).values([
    { title: "alice-1", ownerId: u1.id },
    { title: "alice-2", ownerId: u1.id },
    { title: "bob-1", ownerId: u2.id },
    { title: "carol-1", ownerId: u3.id },
  ]);

  return { u1, u2, u3, reader, admin };
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

  it("denies users with no groups", async () => {
    const { u3 } = await seed();
    const r = await run(`{ todos { id } }`, userCtx(u3.id));
    assert.match(r.errors?.[0]?.message ?? "", /Access denied/);
  });

  it("admin group bypasses ACL and record rules — sees every todo", async () => {
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
    const { u1, reader } = await seed();
    await db.insert(accessRights).values({
      groupId: reader.id,
      resource: "todos",
      canUpdate: true,
    });
    await db.insert(recordRules).values({
      groupId: reader.id,
      resource: "todos",
      permType: "update",
      domain: JSON.stringify([["ownerId", "=", "current_user.id"]]),
    });
    // Alice attempts to rename Bob's todo. ACL allows update, but the record
    // rule narrows the WHERE to ownerId = Alice — so zero rows are affected.
    const r = await run(
      `mutation { updateTodos(set: { title: "stolen" }, where: { title: { eq: "bob-1" } }) { id title } }`,
      userCtx(u1.id),
    );
    assert.equal(r.errors, undefined);
    assert.deepEqual((r.data as any).updateTodos, []);
    const [bob] = await db
      .select()
      .from(todos)
      .where(eq(todos.title, "bob-1"));
    assert.equal(bob.title, "bob-1");
  });

  it("inherits access through parentGroupId", async () => {
    const [u] = await db.insert(users).values({ name: "Inh" }).returning();
    const [parent] = await db
      .insert(groups)
      .values({ name: "ParentReader" })
      .returning();
    const [child] = await db
      .insert(groups)
      .values({ name: "ChildReader", parentGroupId: parent.id })
      .returning();
    await db
      .insert(accessRights)
      .values({ groupId: parent.id, resource: "todos", canRead: true });
    await db.insert(userGroups).values({ userId: u.id, groupId: child.id });
    await db.insert(todos).values({ title: "anyone" });

    const r = await run(`{ todos { title } }`, userCtx(u.id));
    assert.equal(r.errors, undefined);
    const titles = (r.data as any).todos.map((t: any) => t.title);
    assert.deepEqual(titles, ["anyone"]);
  });

  it("survives a parent-group cycle without looping forever", async () => {
    const [u] = await db.insert(users).values({ name: "Cyc" }).returning();
    // Insert two groups then patch parent_group_id to form A→B→A.
    const [a] = await db.insert(groups).values({ name: "A" }).returning();
    const [b] = await db.insert(groups).values({ name: "B", parentGroupId: a.id }).returning();
    sqlite.prepare(`UPDATE groups SET parent_group_id = ? WHERE id = ?`).run(b.id, a.id);
    await db.insert(userGroups).values({ userId: u.id, groupId: a.id });
    // No grants → resolution must terminate, then deny.
    const r = await run(`{ todos { id } }`, userCtx(u.id));
    assert.match(r.errors?.[0]?.message ?? "", /Access denied/);
  });
});
