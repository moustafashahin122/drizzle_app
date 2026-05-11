import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

  it("substitutes a placeholder value before building SQL", () => {
    const node = parseDomain([["ownerId", "=", "current_user.id"]]);
    const sql = domainToSql(node, cols, { "current_user.id": 42 });
    assert.ok(sql);
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
