import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { gt, sql } from "drizzle-orm";

import {
  applyListArgs,
  buildOrderByInput,
  combineWhere,
  orderByToSql,
  type ColumnMap,
} from "./filters.js";

// A minimal table for translator tests. We avoid pulling in the app's real
// schema so these tests stay self-contained and don't depend on disk state.
const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  count: integer("count").notNull().default(0),
  status: text("status"),
});

const columns: ColumnMap = {
  id: items.id,
  title: items.title,
  count: items.count,
  status: items.status,
};

describe("orderByToSql", () => {
  it("returns [] for null/undefined input", () => {
    assert.deepEqual(orderByToSql(null, columns), []);
    assert.deepEqual(orderByToSql(undefined, columns), []);
  });

  it("emits one fragment per known column, ignoring unknown keys", () => {
    const out = orderByToSql(
      { id: "desc", bogus: "asc", title: "asc" } as any,
      columns,
    );
    assert.equal(out.length, 2);
  });
});

describe("buildOrderByInput", () => {
  it("registers a direction field per column on the orderBy input", () => {
    const orderBy = buildOrderByInput("Item", columns);
    const fields = orderBy.getFields();
    for (const k of Object.keys(columns)) {
      assert.ok(fields[k], `expected field ${k}`);
    }
  });
});

describe("combineWhere", () => {
  it("returns undefined when both inputs are undefined", () => {
    assert.equal(combineWhere(undefined, undefined), undefined);
  });

  it("returns the non-undefined fragment when only one is supplied", () => {
    const a = sql`a = 1`;
    assert.equal(combineWhere(a, undefined), a);
    assert.equal(combineWhere(undefined, a), a);
  });

  // The "both supplied → AND" path is exercised end-to-end by the
  // `applyListArgs AND-combines two where fragments via combineWhere` case
  // below, which asserts on actual filtered rows rather than truthiness.
});

describe("applyListArgs (integration with in-memory SQLite)", () => {
  // Behavior over a real DB: applyListArgs collapses the
  // where → orderBy → limit → offset chain. Verifying it end-to-end
  // catches mistakes that pure unit tests would miss (e.g. wrong arg order).
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      status TEXT
    );
    INSERT INTO items (title, count, status) VALUES
      ('a', 1, 'open'),
      ('b', 5, 'open'),
      ('c', 9, 'closed'),
      ('d', 2, NULL);
  `);
  const db = drizzle(sqlite);

  it("returns all rows when no args given", async () => {
    const rows = await applyListArgs(db.select().from(items), undefined, columns);
    assert.equal(rows.length, 4);
  });

  it("filters by a precomputed where clause", async () => {
    const rows = await applyListArgs(
      db.select().from(items),
      undefined,
      columns,
      gt(items.count, 2),
    );
    assert.deepEqual(rows.map((r: any) => r.title).sort(), ["b", "c"]);
  });

  it("orders, limits, and offsets together", async () => {
    const rows = await applyListArgs(
      db.select().from(items),
      { orderBy: { count: "desc" }, limit: 2, offset: 1 },
      columns,
    );
    assert.deepEqual(rows.map((r: any) => r.title), ["b", "d"]);
  });

  it("AND-combines two where fragments via combineWhere", async () => {
    const rows = await applyListArgs(
      db.select().from(items),
      undefined,
      columns,
      combineWhere(sql`status = 'open'`, gt(items.count, 0)),
    );
    assert.deepEqual(rows.map((r: any) => r.title).sort(), ["a", "b"]);
  });
});
