/**
 * Record-rule (row-level) matrix.
 *
 * Both `user` and `manager` hold full CRUD ACL (so deny is never the ACL
 * layer's doing). The `user` role then has a record rule scoping every
 * read/update/delete to `ownerId = current_user.id`. The `manager` role
 * has no record rule and therefore sees and mutates every row.
 *
 * Contracts proved here:
 *   - users see and mutate only their own rows
 *   - cross-owner mutations by a user are silent no-ops (return []) and
 *     leave both the target row and the user's own rows untouched
 *   - manager bypasses row scoping entirely
 *   - record rules are intersected with the user-supplied `where` (AND, not OR)
 *
 * Cast comes from `__helpers__.ts`: Alice + Bob are `user`, Carol is `manager`.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { buildRbac, type BuiltRbac } from "./rbac.js";
import { buildRbacDb } from "./rbacDb.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./config.js";

import {
  allTables,
  todos,
  ctxFor,
  clearAllMemberships,
  freshDb,
  seedUserManager,
  type Db,
} from "./__helpers__.js";

const own = [["ownerId", "=", "current_user.id"]];

const rrConfig = {
  roles: defineRoles({
    user: {},
    manager: {},
  }),
  accessRights: defineAccessRights({
    // Full CRUD for both roles — row scoping must come from record rules alone.
    user:    { todos: { read: true, create: true, update: true, delete: true } },
    manager: { todos: { read: true, create: true, update: true, delete: true } },
  }),
  recordRules: defineRecordRules({
    // user is scoped to their own rows for read/update/delete.
    // create has no rule — at create time the row does not yet exist.
    user: {
      todos: {
        read:   { domain: own },
        update: { domain: own },
        delete: { domain: own },
      },
    },
    // manager: no rule → no narrowing.
  }),
};

let sqlite: ReturnType<typeof freshDb>["sqlite"];
let db: Db;
let rbac: BuiltRbac;
let rdbFor: ReturnType<typeof buildRbacDb>;

before(() => {
  const f = freshDb();
  sqlite = f.sqlite;
  db = f.db;
  rbac = buildRbac(rrConfig);
  rdbFor = buildRbacDb({ db, schema: allTables, enforce: rbac.enforce });
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM todos; DELETE FROM users;`);
  clearAllMemberships(rbac);
});

describe("record rules — row-level scoping with full ACL grants", () => {
  describe("user role — scoped to own rows on read/update/delete", () => {
    it("reads only own rows; rows owned by Bob and Carol are excluded", async () => {
      const { alice, bob, carol } = await seedUserManager(db, rbac);
      const rdb = rdbFor(ctxFor(alice.id));
      const rows = await rdb.select().from(todos);

      assert.equal(rows.length, 2, "alice owns exactly two seeded rows");
      assert.deepEqual(rows.map((r: any) => r.title).sort(), ["alice-1", "alice-2"]);
      assert.ok(rows.every((r: any) => r.ownerId === alice.id));
      assert.ok(rows.every((r: any) => r.ownerId !== bob.id && r.ownerId !== carol.id));
    });

    it("user-supplied where AND-s with the scope rule (no escape via where)", async () => {
      const { alice } = await seedUserManager(db, rbac);
      const rdb = rdbFor(ctxFor(alice.id));

      // Targeting Bob's row with an explicit where still yields [] — the
      // scope predicate AND-s in and excludes it.
      const hostile = await rdb
        .select()
        .from(todos)
        .where(eq(todos.title, "bob-1"));
      assert.deepEqual(hostile, []);

      // Sanity: the same caller still sees their own rows.
      const own = await rdb.select().from(todos);
      assert.equal(own.length, 2);
      assert.ok(own.every((r: any) => r.ownerId === alice.id));
    });

    it("can update an own row; readback confirms persistence and FK preservation", async () => {
      const { alice } = await seedUserManager(db, rbac);
      const rdb = rdbFor(ctxFor(alice.id));
      const updated = await rdb
        .update(todos)
        .set({ title: "alice-1-renamed" })
        .where(eq(todos.title, "alice-1"))
        .returning();

      assert.equal(updated.length, 1);
      assert.equal(updated[0].title, "alice-1-renamed");
      assert.equal(updated[0].ownerId, alice.id);

      const [hit] = await db.select().from(todos).where(eq(todos.id, updated[0].id));
      assert.equal(hit.title, "alice-1-renamed");
      assert.equal(hit.ownerId, alice.id);

      // Sibling untouched.
      const [aliceTwo] = await db.select().from(todos).where(eq(todos.title, "alice-2"));
      assert.equal(aliceTwo.ownerId, alice.id);
    });

    it("cross-owner update returns []; target row and own rows untouched", async () => {
      const { alice, bob } = await seedUserManager(db, rbac);
      const rdb = rdbFor(ctxFor(alice.id));
      const updated = await rdb
        .update(todos)
        .set({ title: "stolen" })
        .where(eq(todos.title, "bob-1"))
        .returning();

      assert.deepEqual(updated, [], "scope rule must silently narrow cross-owner updates to []");

      // Target row intact.
      const [bobRow] = await db.select().from(todos).where(eq(todos.title, "bob-1"));
      assert.equal(bobRow.title, "bob-1");
      assert.equal(bobRow.ownerId, bob.id);

      // Alice's own rows also unmodified — the narrowing did not accidentally
      // touch any row that *was* in scope.
      const aliceRows = await db.select().from(todos).where(eq(todos.ownerId, alice.id));
      assert.equal(aliceRows.length, 2);
      assert.deepEqual(aliceRows.map((r) => r.title).sort(), ["alice-1", "alice-2"]);
    });

    it("can delete an own row; total count drops by exactly one", async () => {
      const { alice } = await seedUserManager(db, rbac);
      const rdb = rdbFor(ctxFor(alice.id));
      const deleted = await rdb
        .delete(todos)
        .where(eq(todos.title, "alice-1"))
        .returning();

      assert.equal(deleted.length, 1);
      assert.equal(deleted[0].ownerId, alice.id);

      const all = await db.select().from(todos);
      assert.equal(all.length, 3);
      assert.ok(all.every((r) => r.title !== "alice-1"));

      // Alice's other row still present.
      const [aliceTwo] = await db.select().from(todos).where(eq(todos.title, "alice-2"));
      assert.equal(aliceTwo.title, "alice-2");
      assert.equal(aliceTwo.ownerId, alice.id);
    });

    it("cross-owner delete returns []; target row and total count unchanged", async () => {
      const { alice, bob } = await seedUserManager(db, rbac);
      const rdb = rdbFor(ctxFor(alice.id));
      const deleted = await rdb
        .delete(todos)
        .where(eq(todos.title, "bob-1"))
        .returning();

      assert.deepEqual(deleted, []);

      const all = await db.select().from(todos);
      assert.equal(all.length, 4, "row count unchanged after denied cross-owner delete");

      const [bobRow] = await db.select().from(todos).where(eq(todos.title, "bob-1"));
      assert.equal(bobRow.title, "bob-1");
      assert.equal(bobRow.ownerId, bob.id);
    });

    it("can create a new own row (no record rule constrains create)", async () => {
      const { alice } = await seedUserManager(db, rbac);
      const rdb = rdbFor(ctxFor(alice.id));
      const out = await rdb
        .insert(todos)
        .values({ title: "alice-3", ownerId: alice.id })
        .returning();

      assert.equal(out.length, 1);
      assert.equal(out[0].title, "alice-3");
      assert.equal(out[0].ownerId, alice.id);

      // Newly inserted row is visible to its owner through the read rule.
      const ownRows = await rdb.select().from(todos);
      assert.equal(ownRows.length, 3);
      assert.ok(ownRows.some((r: any) => r.id === out[0].id && r.title === "alice-3"));
    });
  });

  describe("manager role — no record rule, unrestricted row access", () => {
    it("reads every row, all three owners represented", async () => {
      const { alice, bob, carol } = await seedUserManager(db, rbac);
      const rdb = rdbFor(ctxFor(carol.id));
      const rows = await rdb.select().from(todos);

      assert.equal(rows.length, 4);
      const byTitle = Object.fromEntries(rows.map((r: any) => [r.title, r]));
      assert.deepEqual(Object.keys(byTitle).sort(), [
        "alice-1", "alice-2", "bob-1", "carol-1",
      ]);
      assert.equal(byTitle["alice-1"].ownerId, alice.id);
      assert.equal(byTitle["bob-1"].ownerId,   bob.id);
      assert.equal(byTitle["carol-1"].ownerId, carol.id);
    });

    it("can update a user's row; the user's read view reflects the change", async () => {
      const { alice, carol } = await seedUserManager(db, rbac);

      const carolRdb = rdbFor(ctxFor(carol.id));
      const updated = await carolRdb
        .update(todos)
        .set({ title: "alice-1-by-manager" })
        .where(eq(todos.title, "alice-1"))
        .returning();
      assert.equal(updated.length, 1);
      assert.equal(updated[0].ownerId, alice.id, "ownerId preserved by title-only set");

      // The owning user — still scoped to own rows — now sees the new title.
      const aliceRdb = rdbFor(ctxFor(alice.id));
      const aliceView = await aliceRdb.select().from(todos);
      const titles = aliceView.map((r: any) => r.title).sort();
      assert.deepEqual(titles, ["alice-1-by-manager", "alice-2"]);
    });

    it("can delete a user's row; only that row disappears", async () => {
      const { bob, carol } = await seedUserManager(db, rbac);
      const rdb = rdbFor(ctxFor(carol.id));
      const deleted = await rdb
        .delete(todos)
        .where(eq(todos.title, "bob-1"))
        .returning();
      assert.equal(deleted.length, 1);
      assert.equal(deleted[0].ownerId, bob.id);

      const all = await db.select().from(todos);
      assert.equal(all.length, 3);
      assert.deepEqual(
        all.map((r) => r.title).sort(),
        ["alice-1", "alice-2", "carol-1"],
      );
    });

    it("can create their own row", async () => {
      const { carol } = await seedUserManager(db, rbac);
      const rdb = rdbFor(ctxFor(carol.id));
      const out = await rdb
        .insert(todos)
        .values({ title: "carol-2", ownerId: carol.id })
        .returning();
      assert.equal(out.length, 1);
      assert.equal(out[0].ownerId, carol.id);

      const all = await db.select().from(todos);
      assert.equal(all.length, 5);
    });
  });

  describe("cross-actor isolation", () => {
    it("a manager edit to Bob's row is invisible to Alice's read view", async () => {
      const { alice, carol } = await seedUserManager(db, rbac);

      // Manager renames Bob's row.
      const carolRdb = rdbFor(ctxFor(carol.id));
      await carolRdb
        .update(todos)
        .set({ title: "bob-1-renamed-by-manager" })
        .where(eq(todos.title, "bob-1"));

      // Alice's scoped view still contains only her two rows; Bob's renamed
      // row is not pulled in by the manager's mutation.
      const aliceRdb = rdbFor(ctxFor(alice.id));
      const rows = await aliceRdb.select().from(todos);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r: any) => r.title).sort(), ["alice-1", "alice-2"]);
      assert.ok(rows.every((r: any) => r.ownerId === alice.id));
    });

    it("Alice and Bob (same role) see disjoint row sets", async () => {
      const { alice, bob } = await seedUserManager(db, rbac);

      const aliceRows = await rdbFor(ctxFor(alice.id)).select().from(todos);
      const bobRows   = await rdbFor(ctxFor(bob.id)).select().from(todos);

      assert.deepEqual(aliceRows.map((r: any) => r.title).sort(), ["alice-1", "alice-2"]);
      assert.deepEqual(bobRows.map((r: any) => r.title).sort(), ["bob-1"]);

      // No id overlap between the two views.
      const aliceIds = new Set(aliceRows.map((r: any) => r.id));
      assert.ok(bobRows.every((r: any) => !aliceIds.has(r.id)));
    });
  });
});
