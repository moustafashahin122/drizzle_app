import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";

import { buildRbac } from "./rbac.js";
import { buildRbacDb } from "./rbacDb.js";

// Self-contained schema (no dependency on src/db.ts), intentionally minimal.
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

const allTables = { users, todos, groups, userGroups, accessRights, recordRules };

let db: ReturnType<typeof drizzle>;
let sqlite: Database.Database;
let rdbFor: ReturnType<typeof buildRbacDb>;

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
  const rbac = buildRbac(db, { groups, userGroups, accessRights, recordRules });
  rdbFor = buildRbacDb({ db, schema: allTables, enforce: rbac.enforce });
});

beforeEach(() => {
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

const ctxFor = (id: number, name = "u") => ({
  user: { id, name } as any,
  session: null,
  batch: new Map<string, unknown>(),
});

async function seed() {
  const [u1] = await db.insert(users).values({ name: "Alice" }).returning();
  const [u2] = await db.insert(users).values({ name: "Bob" }).returning();
  const [u3] = await db.insert(users).values({ name: "Carol" }).returning();

  const [reader] = await db.insert(groups).values({ name: "Reader" }).returning();
  const [admin] = await db.insert(groups).values({ name: "Admin", isAdmin: true }).returning();

  await db.insert(userGroups).values([
    { userId: u1.id, groupId: reader.id },
    { userId: u2.id, groupId: admin.id },
  ]);

  await db.insert(accessRights).values([
    { groupId: reader.id, resource: "todos", canRead: true, canUpdate: true, canDelete: true },
  ]);
  await db.insert(recordRules).values([
    {
      groupId: reader.id,
      resource: "todos",
      permType: "read",
      domain: JSON.stringify([["ownerId", "=", "current_user.id"]]),
    },
    {
      groupId: reader.id,
      resource: "todos",
      permType: "update",
      domain: JSON.stringify([["ownerId", "=", "current_user.id"]]),
    },
    {
      groupId: reader.id,
      resource: "todos",
      permType: "delete",
      domain: JSON.stringify([["ownerId", "=", "current_user.id"]]),
    },
  ]);

  await db.insert(todos).values([
    { title: "alice-1", ownerId: u1.id },
    { title: "alice-2", ownerId: u1.id },
    { title: "bob-1", ownerId: u2.id },
    { title: "carol-1", ownerId: u3.id },
  ]);

  return { u1, u2, u3, reader, admin };
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
    // Try to read Bob's row by title — record rule must keep it hidden.
    const rows = await rdb.select().from(todos).where(eq(todos.title, "bob-1"));
    assert.deepEqual(rows, []);
  });

  it("denies users with no groups", async () => {
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
    // Try to rename Bob's todo — record rule must keep where = ownerId = u1.
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

  it("ACL gate — canCreate allows", async () => {
    const { u1, reader } = await seed();
    await db.insert(accessRights).values({
      groupId: reader.id,
      resource: "todos",
      canCreate: true,
    });
    const rdb = rdbFor(ctxFor(u1.id));
    const out = await rdb
      .insert(todos)
      .values({ title: "fresh", ownerId: u1.id })
      .returning();
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "fresh");
  });
});

describe("rbacDb — bypass and escape hatch", () => {
  it("bypassResources passes through to raw db", async () => {
    const { u3 } = await seed();
    const rbac = buildRbac(db, { groups, userGroups, accessRights, recordRules });
    const bypassRdbFor = buildRbacDb({
      db,
      schema: allTables,
      enforce: rbac.enforce,
      bypassResources: new Set(["todos"]),
    });
    const rdb = bypassRdbFor(ctxFor(u3.id)); // u3 has no groups
    const rows = await rdb.select().from(todos);
    assert.equal(rows.length, 4);
  });

  it("rdb.raw is the unwrapped db", async () => {
    const { u3 } = await seed();
    const rdb = rdbFor(ctxFor(u3.id));
    // u3 has no groups — raw must still work.
    const rows = await rdb.raw.select().from(todos);
    assert.equal(rows.length, 4);
  });
});
