import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { graphql, type GraphQLSchema } from "graphql";

import { buildSchema } from "./builder.js";
import { buildRbac, type BuiltRbac } from "../rbac/rbac.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "../rbac/config.js";

// Phase 2: mutation enforcement.
// - INSERT must validate inserted rows against the create-domain (record rule
//   on action="create") and roll the tx back on failure.
// - UPDATE/DELETE must refuse to run with a fully empty combined WHERE.
//
// Schema mirrors the rbac.test.ts setup (users + todos with owner FK).

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

// Reader can create todos only if ownerId = themselves.
const ownOnly = [["ownerId", "=", "current_user.id"]];
const config = {
  roles: defineRoles({
    reader: {},
    admin: { isAdmin: true },
  }),
  accessRights: defineAccessRights({
    reader: {
      todos: { read: true, create: true, update: true, delete: true },
    },
  }),
  recordRules: defineRecordRules({
    reader: {
      todos: {
        read: { domain: ownOnly },
        create: { domain: ownOnly },
        update: { domain: ownOnly },
        delete: { domain: ownOnly },
      },
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
  rbac = buildRbac(config);
  schema = buildSchema(db, allTables, { rbac: { enforce: rbac.enforce } }).schema;
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM todos; DELETE FROM users;`);
  for (let id = 1; id < 1000; id++) {
    for (const key of rbac.listUserRoles(id)) rbac.revokeRole(id, key);
  }
});

const ctxFor = (id: number) => ({
  user: { id, name: "u" + id } as any,
  session: null,
  batch: new Map(),
});

async function run(query: string, contextValue: any, variableValues?: Record<string, unknown>) {
  return graphql({ schema, source: query, contextValue, variableValues });
}

async function seedUsers() {
  const [u1] = await db.insert(users).values({ name: "Alice" }).returning();
  const [u2] = await db.insert(users).values({ name: "Bob" }).returning();
  const [u3] = await db.insert(users).values({ name: "Carol" }).returning();
  rbac.assignRole(u1.id, "reader");
  rbac.assignRole(u2.id, "admin");
  // u3 exists in users so FK passes but is not the reader — used to trigger
  // create-rule violations (ownerId is a real user, just not current_user.id).
  return { reader: u1, admin: u2, other: u3 };
}

describe("buildSchema — insert create-rule enforcement", () => {
  it("blocks insert that violates the create record-rule (single)", async () => {
    const { reader, other } = await seedUsers();
    const res = await run(
      `mutation ($v: [TodosInsert!]!) {
         insertIntoTodos(values: $v) { id title }
       }`,
      ctxFor(reader.id),
      { v: [{ title: "evil", ownerId: other.id }] },
    );
    assert.ok(res.errors?.length, "expected error");
    assert.match(res.errors![0].message, /rbac: insert blocked by record rule/);
    // tx rolled back — nothing persisted.
    const rows = await db.select().from(todos);
    assert.equal(rows.length, 0);
  });

  it("blocks batch insert when any row violates the rule", async () => {
    const { reader, other } = await seedUsers();
    const res = await run(
      `mutation ($v: [TodosInsert!]!) {
         insertIntoTodos(values: $v) { id }
       }`,
      ctxFor(reader.id),
      {
        v: [
          { title: "ok", ownerId: reader.id },
          { title: "bad", ownerId: other.id },
        ],
      },
    );
    assert.ok(res.errors?.length);
    assert.match(res.errors![0].message, /rbac: insert blocked by record rule/);
    const rows = await db.select().from(todos);
    assert.equal(rows.length, 0, "tx must roll back the whole batch");
  });

  it("allows insert matching the create record-rule", async () => {
    const { reader } = await seedUsers();
    const res = await run(
      `mutation ($v: [TodosInsert!]!) {
         insertIntoTodos(values: $v) { id title }
       }`,
      ctxFor(reader.id),
      { v: [{ title: "mine", ownerId: reader.id }] },
    );
    assert.equal(res.errors, undefined, JSON.stringify(res.errors));
    const data = res.data as any;
    assert.equal(data.insertIntoTodos.length, 1);
    const rows = await db.select().from(todos);
    assert.equal(rows[0].ownerId, reader.id);
  });

  it("admin bypasses the create record-rule", async () => {
    const { admin } = await seedUsers();
    // Admin owner_id doesn't have to exist in users (no FK constraint enforced here
    // for arbitrary ids), but use admin.id to be safe with the FK.
    const res = await run(
      `mutation ($v: [TodosInsert!]!) {
         insertIntoTodos(values: $v) { id title }
       }`,
      ctxFor(admin.id),
      { v: [{ title: "any", ownerId: admin.id }] },
    );
    assert.equal(res.errors, undefined, JSON.stringify(res.errors));
    const data = res.data as any;
    assert.equal(data.insertIntoTodos.length, 1);
  });

  it("no create-rule configured leaves insert behavior unchanged", async () => {
    // Fresh setup: reader has canCreate but no create record-rule.
    const sqlite2 = new Database(":memory:");
    sqlite2.exec(createTablesSql());
    const db2 = drizzle(sqlite2);
    const cfg = {
      roles: defineRoles({ reader: {}, admin: { isAdmin: true } }),
      accessRights: defineAccessRights({
        reader: { todos: { read: true, create: true } },
      }),
      recordRules: defineRecordRules({}),
    };
    const rbac2 = buildRbac(cfg);
    const schema2 = buildSchema(db2, allTables, { rbac: { enforce: rbac2.enforce } }).schema;
    const [u1] = await db2.insert(users).values({ name: "Alice" }).returning();
    rbac2.assignRole(u1.id, "reader");

    const res = await graphql({
      schema: schema2,
      source: `mutation ($v: [TodosInsert!]!) {
         insertIntoTodos(values: $v) { id title }
       }`,
      contextValue: ctxFor(u1.id),
      variableValues: { v: [{ title: "anything", ownerId: u1.id }] },
    });
    assert.equal(res.errors, undefined, JSON.stringify(res.errors));
    const data = res.data as any;
    assert.equal(data.insertIntoTodos.length, 1);
  });
});

describe("buildSchema — update/delete empty-WHERE assert", () => {
  it("update with no user where and no RBAC restriction throws", async () => {
    // Build a fresh schema with no rbac so combined where is undefined.
    const sqlite2 = new Database(":memory:");
    sqlite2.exec(createTablesSql());
    const db2 = drizzle(sqlite2);
    const schema2 = buildSchema(db2, allTables).schema;
    await db2.insert(users).values({ name: "X" }).returning();

    const res = await graphql({
      schema: schema2,
      source: `mutation { updateUsers(set: { name: "Y" }) { id } }`,
      contextValue: {},
    });
    assert.ok(res.errors?.length);
    assert.match(res.errors![0].message, /rbac: refusing UPDATE with empty WHERE/);
    // Row was not touched.
    const rows = await db2.select().from(users);
    assert.equal(rows[0].name, "X");
  });

  it("delete with no user where and no RBAC restriction throws", async () => {
    const sqlite2 = new Database(":memory:");
    sqlite2.exec(createTablesSql());
    const db2 = drizzle(sqlite2);
    const schema2 = buildSchema(db2, allTables).schema;
    await db2.insert(users).values({ name: "X" }).returning();

    const res = await graphql({
      schema: schema2,
      source: `mutation { deleteFromUsers { id } }`,
      contextValue: {},
    });
    assert.ok(res.errors?.length);
    assert.match(res.errors![0].message, /rbac: refusing DELETE with empty WHERE/);
    const rows = await db2.select().from(users);
    assert.equal(rows.length, 1);
  });
});
