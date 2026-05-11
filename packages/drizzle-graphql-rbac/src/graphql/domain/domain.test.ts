import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

import { parseDomain, domainToSql } from "./domain.js";
import type { ColumnMap } from "../builder/filters.js";

const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  ownerId: integer("owner_id"),
});

describe("domain — parser", () => {
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
});

describe("domain — translator", () => {
  const cols = { ownerId: todos.ownerId } as unknown as ColumnMap;

  it("substitutes a placeholder value before building SQL (filters rows accordingly)", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, owner_id INTEGER);
      INSERT INTO todos (title, owner_id) VALUES ('a', 42), ('b', 7), ('c', 42);
    `);
    const db = drizzle(sqlite);
    const node = parseDomain([["ownerId", "=", "current_user.id"]]);

    // Placeholder=42: must keep the two ownerId=42 rows, drop the ownerId=7 row.
    const sqlFor42 = domainToSql(node, cols, { "current_user.id": 42 });
    assert.ok(sqlFor42, "non-null placeholder must yield SQL");
    const rows42 = await db.select().from(todos).where(sqlFor42!);
    assert.deepEqual(rows42.map((r) => r.title).sort(), ["a", "c"]);

    // Placeholder=999: yields a valid filter that matches zero rows.
    const sqlFor999 = domainToSql(node, cols, { "current_user.id": 999 });
    assert.ok(sqlFor999);
    const rows999 = await db.select().from(todos).where(sqlFor999!);
    assert.equal(rows999.length, 0);
  });

  it("drops `=` against null-resolved placeholders (safe default)", () => {
    const node = parseDomain([["ownerId", "=", "current_user.id"]]);
    const sql = domainToSql(node, cols, { "current_user.id": null });
    assert.equal(sql, undefined);
  });

  it("returns undefined for leaves on unknown columns", () => {
    const node = parseDomain([["nope", "=", 1]]);
    assert.equal(domainToSql(node, cols, {}), undefined);
  });

  it("throws on unsupported operators", () => {
    const node = parseDomain([["ownerId", "??", 1]]);
    assert.throws(() => domainToSql(node, cols, {}), /unsupported operator/);
  });
});
