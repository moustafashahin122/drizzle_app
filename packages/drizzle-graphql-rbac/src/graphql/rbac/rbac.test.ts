import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { graphql, type GraphQLSchema } from "graphql";

import { buildSchema } from "../builder/builder.js";
import { buildRbac, type BuiltRbac } from "./rbac.js";
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

const allTables = { users, todos };

function createTablesSql(): string {
  return `
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      owner_id INTEGER REFERENCES users(id)
    );
  `;
}

const ownRows = [["ownerId", "=", "current_user.id"]];
const baseConfig = {
  roles: defineRoles({
    reader: {},
    admin: { isAdmin: true },
  }),
  accessRights: defineAccessRights({
    reader: {
      todos: { read: true },
    },
  }),
  recordRules: defineRecordRules({
    reader: {
      todos: { read: { domain: ownRows } },
    },
  }),
};

let db: ReturnType<typeof drizzle>;
let sqlite: Database.Database;
let schema: GraphQLSchema;
let rbac: BuiltRbac;

before(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(createTablesSql());
  db = drizzle(sqlite);
  rbac = buildRbac(baseConfig);
  schema = buildSchema(db, allTables, { rbac: { enforce: rbac.enforce } }).schema;
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM todos;
    DELETE FROM users;
  `);
  // Reset memberships between tests.
  for (let id = 1; id < 1000; id++) {
    for (const key of rbac.listUserRoles(id)) rbac.revokeRole(id, key);
  }
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
  rbac.assignRole(u1.id, "reader");
  rbac.assignRole(u2.id, "admin");
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
      roles: defineRoles({ reader: {} }),
      accessRights: defineAccessRights({
        reader: {
          todos: { read: true, update: true },
        },
      }),
      recordRules: defineRecordRules({
        reader: {
          todos: {
            read:   { domain: own },
            update: { domain: own },
          },
        },
      }),
    };
    const rbac2 = buildRbac(cfg);
    const schema2 = buildSchema(db2, allTables, { rbac: { enforce: rbac2.enforce } }).schema;

    const [u1] = await db2.insert(users).values({ name: "Alice" }).returning();
    const [u2] = await db2.insert(users).values({ name: "Bob" }).returning();
    rbac2.assignRole(u1.id, "reader");
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

  it("rejects unknown role on assignRole", () => {
    assert.throws(() => rbac.assignRole(1, "ghost"), /unknown role/);
  });

  it("rejects empty roles config at build time", () => {
    assert.throws(
      () => buildRbac({ roles: {}, accessRights: {}, recordRules: {} }),
      /roles config is empty/,
    );
  });
});
