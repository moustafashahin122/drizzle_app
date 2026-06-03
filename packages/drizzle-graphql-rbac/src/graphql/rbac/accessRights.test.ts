/**
 * ACL-only RBAC matrix — no record rules anywhere.
 *
 * Verifies that access rights are a per-verb gate: a role with `read=true`
 * but no record rule sees every row; a role without a verb flag is denied
 * outright. Cross-row narrowing is intentionally absent from this file —
 * that contract lives in `recordRules.test.ts`.
 *
 * Cast (from `__helpers__.ts`): Alice + Bob hold role `user`, Carol holds
 * `manager`. Per-test isolation is provided by `transactionCase` SAVEPOINT
 * rollback, so per-test inserts (e.g. a role-less actor) vanish automatically.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { buildRbac } from "./rbac.js";
import { buildRbacDb } from "./rbacDb.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./config.js";

import {
  allTables,
  byTitle,
  db,
  todos,
  users,
  anonCtx,
  ctxFor,
  seedUserManager,
  transactionCase,
} from "./__helpers__.js";

const aclConfig = {
  roles: defineRoles({
    user: {},
    manager: {},
  }),
  accessRights: defineAccessRights({
    // `user` is deliberately missing `delete` — that is the in-role deny path.
    user:    { todos: { read: true, create: true, update: true } },
    manager: { todos: { read: true, create: true, update: true, delete: true } },
  }),
  recordRules: defineRecordRules({}), // intentionally empty
};

const tc = transactionCase(async () => {
  const rbac = buildRbac(aclConfig);
  const rbacDbFor = buildRbacDb({ db, schema: allTables, enforce: rbac.enforce });
  const cast = await seedUserManager(rbac);
  return { db, rbac, rbacDbFor, cast };
});

describe("access rights — verb-level gating with no record rules", () => {
  describe("user role — has read/create/update, lacks delete", () => {
    it("can read every row in the table (no record rule narrows)", async () => {
      const { rbacDbFor, cast: { alice, bob, carol } } = tc;
      const rbacDb = rbacDbFor(ctxFor(alice.id));
      const rows = await rbacDb.select().from(todos);

      assert.equal(rows.length, 4, "user with read+no-rule must see every row");
      const indexed = byTitle(rows as any[]);
      assert.deepEqual(Object.keys(indexed).sort(), [
        "alice-1", "alice-2", "bob-1", "carol-1",
      ]);
      assert.equal(indexed["alice-1"].ownerId, alice.id);
      assert.equal(indexed["bob-1"].ownerId,   bob.id);
      assert.equal(indexed["carol-1"].ownerId, carol.id);
    });

    it("can create a todo; row persists with the supplied FK", async () => {
      const { db, rbacDbFor, cast: { alice } } = tc;
      const rbacDb = rbacDbFor(ctxFor(alice.id));
      const out = await rbacDb
        .insert(todos)
        .values({ title: "alice-3", ownerId: alice.id })
        .returning();

      assert.equal(out.length, 1);
      assert.equal(out[0].title, "alice-3");
      assert.equal(out[0].ownerId, alice.id);

      const persisted = await db.select().from(todos).where(eq(todos.id, out[0].id));
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].title, "alice-3");
      assert.equal(persisted[0].ownerId, alice.id);

      const total = await db.select().from(todos);
      assert.equal(total.length, 5, "exactly one new row was added");
    });

    it("can update ANY row — without a record rule, ACL does not row-scope", async () => {
      const { db, rbacDbFor, cast: { alice, bob } } = tc;
      const rbacDb = rbacDbFor(ctxFor(alice.id));
      const updated = await rbacDb
        .update(todos)
        .set({ title: "edited-by-alice" })
        .where(eq(todos.title, "bob-1"))
        .returning();

      assert.equal(updated.length, 1);
      assert.equal(updated[0].title, "edited-by-alice");
      assert.equal(updated[0].ownerId, bob.id, "ownerId must not be mutated by a title-only set");

      const [hit] = await db.select().from(todos).where(eq(todos.id, updated[0].id));
      assert.equal(hit.title, "edited-by-alice");
      assert.equal(hit.ownerId, bob.id);

      // Isolation: Alice's own rows are untouched.
      const aliceRows = await db.select().from(todos).where(eq(todos.ownerId, alice.id));
      assert.equal(aliceRows.length, 2);
      assert.deepEqual(aliceRows.map((r) => r.title).sort(), ["alice-1", "alice-2"]);
    });

    it("cannot delete any row — verb flag missing → Access denied; DB untouched", async () => {
      const { db, rbacDbFor, cast: { alice } } = tc;
      const rbacDb = rbacDbFor(ctxFor(alice.id));

      // Try to delete own row — ACL denies before any row-scope check.
      await assert.rejects(
        () => rbacDb.delete(todos).where(eq(todos.title, "alice-1")).returning(),
        /Access denied/,
      );
      // And cross-owner — same deny, same reason (it's verb-level).
      await assert.rejects(
        () => rbacDb.delete(todos).where(eq(todos.title, "bob-1")).returning(),
        /Access denied/,
      );

      const all = await db.select().from(todos);
      assert.equal(all.length, 4, "no row was deleted by either denied call");
      assert.deepEqual(
        all.map((r) => r.title).sort(),
        ["alice-1", "alice-2", "bob-1", "carol-1"],
      );
    });
  });

  describe("manager role — full CRUD, every verb permitted", () => {
    it("can read every row", async () => {
      const { rbacDbFor, cast: { alice, bob, carol } } = tc;
      const rbacDb = rbacDbFor(ctxFor(carol.id));
      const rows = await rbacDb.select().from(todos);
      assert.equal(rows.length, 4);
      // Full tuples by title — a Set-based check would still pass if a row
      // were silently swapped or duplicated.
      const indexed = byTitle(rows as any[]);
      assert.deepEqual(Object.keys(indexed).sort(), [
        "alice-1", "alice-2", "bob-1", "carol-1",
      ]);
      assert.equal(indexed["alice-1"].ownerId, alice.id);
      assert.equal(indexed["alice-2"].ownerId, alice.id);
      assert.equal(indexed["bob-1"].ownerId,   bob.id);
      assert.equal(indexed["carol-1"].ownerId, carol.id);
    });

    it("can update a user's row (cross-owner allowed at ACL layer)", async () => {
      const { db, rbacDbFor, cast: { bob, carol } } = tc;
      const rbacDb = rbacDbFor(ctxFor(carol.id));
      const updated = await rbacDb
        .update(todos)
        .set({ title: "edited-by-manager" })
        .where(eq(todos.title, "bob-1"))
        .returning();
      assert.equal(updated.length, 1);
      assert.equal(updated[0].ownerId, bob.id, "FK preserved when set targets only title");

      const [hit] = await db.select().from(todos).where(eq(todos.id, updated[0].id));
      assert.equal(hit.title, "edited-by-manager");
    });

    it("can delete a user's row; only that row disappears", async () => {
      const { db, rbacDbFor, cast: { bob, carol } } = tc;
      const rbacDb = rbacDbFor(ctxFor(carol.id));
      const deleted = await rbacDb
        .delete(todos)
        .where(eq(todos.title, "bob-1"))
        .returning();
      assert.equal(deleted.length, 1);
      assert.equal(deleted[0].ownerId, bob.id);

      const remaining = await db.select().from(todos);
      assert.equal(remaining.length, 3);
      assert.ok(remaining.every((r) => r.title !== "bob-1"));
      assert.deepEqual(
        remaining.map((r) => r.title).sort(),
        ["alice-1", "alice-2", "carol-1"],
      );
    });

    it("can create a todo of their own", async () => {
      const { db, rbacDbFor, cast: { carol } } = tc;
      const rbacDb = rbacDbFor(ctxFor(carol.id));
      const out = await rbacDb
        .insert(todos)
        .values({ title: "carol-2", ownerId: carol.id })
        .returning();
      assert.equal(out.length, 1);
      assert.equal(out[0].ownerId, carol.id);

      const all = await db.select().from(todos);
      assert.equal(all.length, 5);
    });
  });

  describe("non-actor deny paths", () => {
    const VERBS = ["select", "insert", "update", "delete"] as const;

    function actFor(rbacDb: ReturnType<ReturnType<typeof buildRbacDb>>, verb: typeof VERBS[number], ownerId: number) {
      switch (verb) {
        case "select": return () => rbacDb.select().from(todos);
        case "insert": return () => rbacDb.insert(todos).values({ title: "x", ownerId }).returning();
        case "update": return () => rbacDb.update(todos).set({ title: "x" }).where(eq(todos.title, "alice-1")).returning();
        case "delete": return () => rbacDb.delete(todos).where(eq(todos.title, "alice-1")).returning();
      }
    }

    it("role-less authenticated user is denied on every verb; DB unchanged", async () => {
      const { db, rbacDbFor, cast: { alice } } = tc;
      // Insert a 4th user with no role assignment. The savepoint rolls
      // this row back after the test, so subsequent tests see the same
      // 3-actor cast.
      const [dave] = await db.insert(users).values({ name: "Dave" }).returning();
      const rbacDb = rbacDbFor(ctxFor(dave.id));

      for (const verb of VERBS) {
        await assert.rejects(actFor(rbacDb, verb, alice.id), /Access denied/, `verb=${verb}`);
      }

      const all = await db.select().from(todos);
      assert.equal(all.length, 4);
      assert.ok(all.every((r) => r.title !== "x"));
    });

    it("anonymous caller is rejected as Not authenticated on every verb", async () => {
      const { db, rbacDbFor, cast: { alice } } = tc;
      const rbacDb = rbacDbFor(anonCtx());

      for (const verb of VERBS) {
        await assert.rejects(actFor(rbacDb, verb, alice.id), /Not authenticated/, `verb=${verb}`);
      }

      const all = await db.select().from(todos);
      assert.equal(all.length, 4);
    });
  });
});
