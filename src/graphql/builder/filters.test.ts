import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

import {
  applyListArgs,
  buildOrderByInput,
  buildWhereInput,
  orderByToSql,
  whereToSql,
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

describe("whereToSql", () => {
  it("returns undefined for null/undefined/empty input", () => {
    assert.equal(whereToSql(null, columns), undefined);
    assert.equal(whereToSql(undefined, columns), undefined);
    assert.equal(whereToSql({}, columns), undefined);
  });

  it("ignores unknown column keys (clients can't synthesize columns)", () => {
    assert.equal(whereToSql({ bogus: { eq: 1 } }, columns), undefined);
  });

  it("translates eq into Drizzle SQL referencing the matching column", () => {
    const out = whereToSql({ id: { eq: 5 } }, columns);
    assert.ok(out, "expected SQL fragment");
    // Cheap structural check — we don't render SQL here, just confirm a
    // fragment came back. End-to-end behavior is covered in builder.test.ts.
  });

  it("AND-combines multiple operators on the same column", () => {
    const out = whereToSql({ count: { gt: 1, lt: 10 } }, columns);
    assert.ok(out);
  });

  it("supports AND/OR/NOT combinators with recursion", () => {
    const out = whereToSql(
      {
        AND: [{ id: { gt: 1 } }, { status: { isNull: false } }],
        OR: [{ title: { like: "%a%" } }, { count: { eq: 0 } }],
        NOT: { id: { eq: 999 } },
      },
      columns,
    );
    assert.ok(out);
  });
});

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

describe("buildWhereInput / buildOrderByInput", () => {
  it("registers per-column fields plus AND/OR/NOT on the where input", () => {
    const where = buildWhereInput("Item", columns);
    const fields = where.getFields();
    for (const k of ["id", "title", "count", "status", "AND", "OR", "NOT"]) {
      assert.ok(fields[k], `expected field ${k}`);
    }
  });

  it("registers a direction field per column on the orderBy input", () => {
    const orderBy = buildOrderByInput("Item", columns);
    const fields = orderBy.getFields();
    for (const k of Object.keys(columns)) {
      assert.ok(fields[k], `expected field ${k}`);
    }
  });
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

  it("filters by a where clause", async () => {
    const rows = await applyListArgs(
      db.select().from(items),
      { where: { count: { gt: 2 } } },
      columns,
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

  it("AND-combines extraWhere with the user where", async () => {
    const rows = await applyListArgs(
      db.select().from(items),
      { where: { count: { gt: 0 } } },
      columns,
      sql`status = 'open'`,
    );
    assert.deepEqual(rows.map((r: any) => r.title).sort(), ["a", "b"]);
  });
});
