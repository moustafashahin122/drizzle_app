import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

import { introspectSchema } from "./relations.js";

// Schemas are local to this test so the test doesn't depend on the app's
// real db.ts (and so we can construct different relation shapes per case).

describe("introspectSchema — table indexing", () => {
  const users = sqliteTable("users", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
  });
  const posts = sqliteTable("posts", {
    id: integer("id").primaryKey(),
    body: text("body").notNull(),
    authorId: integer("author_id").references(() => users.id),
  });

  const intro = introspectSchema({ users, posts });

  it("indexes tables by SQL name and JS key", () => {
    assert.equal(intro.tables.size, 2);
    assert.equal(intro.tablesByKey.size, 2);
    assert.ok(intro.tables.has("users"));
    assert.ok(intro.tables.has("posts"));
    assert.equal(intro.keyByTableName.get("posts"), "posts");
  });
});

describe("introspectSchema — auto FK detection", () => {
  const users = sqliteTable("users", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
  });
  const posts = sqliteTable("posts", {
    id: integer("id").primaryKey(),
    body: text("body").notNull(),
    authorId: integer("author_id").references(() => users.id),
  });

  const intro = introspectSchema({ users, posts });

  it("creates a forward 'one' relation named after the FK column's JS key", () => {
    const postsRels = intro.relations.get("posts") ?? [];
    const fwd = postsRels.find((r) => r.fieldName === "authorId");
    assert.ok(fwd, "expected a forward 'authorId' relation on posts");
    assert.equal(fwd!.kind, "one");
    assert.equal(fwd!.fields?.length, 1);
    assert.equal(fwd!.references?.length, 1);
  });

  it("creates an inverse 'many' relation on the referenced table", () => {
    const usersRels = intro.relations.get("users") ?? [];
    const inv = usersRels.find((r) => r.fieldName === "posts");
    assert.ok(inv, "expected an inverse 'posts' relation on users");
    assert.equal(inv!.kind, "many");
    assert.equal(inv!.fields?.length, 1);
    assert.equal(inv!.references?.length, 1);
  });

  it("does not invent relations for tables without FKs", () => {
    const standalone = sqliteTable("standalone", {
      id: integer("id").primaryKey(),
    });
    const intro = introspectSchema({ standalone });
    assert.equal((intro.relations.get("standalone") ?? []).length, 0);
  });
});

describe("introspectSchema — explicit relations() declarations", () => {
  const users = sqliteTable("users", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
  });
  const posts = sqliteTable("posts", {
    id: integer("id").primaryKey(),
    body: text("body").notNull(),
    authorId: integer("author_id").references(() => users.id),
  });

  const usersRelations = relations(users, ({ many }) => ({
    authoredPosts: many(posts),
  }));
  const postsRelations = relations(posts, ({ one }) => ({
    author: one(users, { fields: [posts.authorId], references: [users.id] }),
  }));

  const intro = introspectSchema({ users, posts, usersRelations, postsRelations });

  it("captures the explicit 'one' with fields/references", () => {
    const postsRels = intro.relations.get("posts") ?? [];
    const author = postsRels.find((r) => r.fieldName === "author");
    assert.ok(author, "expected author relation");
    assert.equal(author!.kind, "one");
    assert.equal(author!.fields?.length, 1);
    assert.equal(author!.references?.length, 1);
  });

  it("back-fills the paired 'many' side with mirrored fields/references", () => {
    const usersRels = intro.relations.get("users") ?? [];
    const authored = usersRels.find((r) => r.fieldName === "authoredPosts");
    assert.ok(authored, "expected authoredPosts relation");
    assert.equal(authored!.kind, "many");
    assert.ok(authored!.fields?.length, "many side should be back-filled");
    assert.ok(authored!.references?.length, "many side should be back-filled");
  });

  it("explicit relations take precedence over auto-FK same-named field", () => {
    // The FK column on posts is `authorId`; an auto-FK relation would also be
    // named `authorId`. The explicit relation is named `author` so both
    // exist — this test confirms the explicit name is registered alongside
    // the auto-FK without collision.
    const postsRels = intro.relations.get("posts") ?? [];
    const fieldNames = postsRels.map((r) => r.fieldName).sort();
    assert.deepEqual(fieldNames, ["author", "authorId"]);
  });
});
