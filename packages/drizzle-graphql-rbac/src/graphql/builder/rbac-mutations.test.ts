import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { graphql } from "graphql";

import { buildSchema } from "./builder.js";

// Mutation-side guard: UPDATE/DELETE must refuse to run with a fully empty
// combined WHERE. Insert-time row filtering (create record-rule) is not
// currently modeled — those tests will return once post-insert verification
// lands.

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
