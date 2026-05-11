/**
 * `rbacDb` proxy-specific contracts.
 *
 * The cross-cutting RBAC matrix (ACL gating, record-rule narrowing,
 * cross-owner deny, allow-vs-deny pairs across CRUD verbs) is covered
 * comprehensively in `accessRights.test.ts` and `recordRules.test.ts`.
 *
 * This file covers only the contracts unique to the rdb proxy itself:
 *   - the `isAdmin: true` short-circuit at the rdb layer
 *   - drizzle's chained query methods (orderBy, limit) survive the proxy
 *   - the `bypassResources` opt-out
 *   - the `.sudo` escape hatch
 *
 * Cast: Alice(reader), Bob(admin), Carol(no role). Per-test isolation via
 * `transactionCase` SAVEPOINT rollback.
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
  db,
  todos,
  users,
  ctxFor,
  seedReaderAdmin,
  transactionCase,
} from "./__helpers__.js";

const own = [["ownerId", "=", "current_user.id"]];
const selfOnly = [["id", "=", "current_user.id"]];
const rbacConfig = {
  roles: defineRoles({
    reader: {},
    admin: { isAdmin: true },
  }),
  accessRights: defineAccessRights({
    reader: { todos: { read: true }, users: { read: true } },
  }),
  recordRules: defineRecordRules({
    reader: {
      todos: { read: { domain: own } },
      users: { read: { domain: selfOnly } },
    },
  }),
};

const tc = transactionCase(async () => {
  const rbac = buildRbac(rbacConfig);
  const rdbFor = buildRbacDb({ db, schema: allTables, enforce: rbac.enforce });
  const cast = await seedReaderAdmin(rbac);
  return { db, rbac, rdbFor, cast };
});

describe("rbacDb — proxy-specific contracts", () => {
  it("admin role short-circuits enforcement at the rdb layer (sees every row)", async () => {
    const { rdbFor, cast: { alice, bob, carol } } = tc;
    const rdb = rdbFor(ctxFor(bob.id));
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

  it("forwards orderBy and limit through the proxy, preserving order and length", async () => {
    const { rdbFor, cast: { bob } } = tc;
    const rdb = rdbFor(ctxFor(bob.id));
    const rows = await rdb.select().from(todos).orderBy(todos.id).limit(2);

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r: any) => r.title),
      ["alice-1", "alice-2"],
      "orderBy(id).limit(2) must yield the first two seeded rows in id order",
    );
  });

  it("bypassResources allows a role-less user to read all rows verbatim", async () => {
    const { db, rbac, cast: { alice, bob, carol } } = tc;
    const bypassRdbFor = buildRbacDb({
      db,
      schema: allTables,
      enforce: rbac.enforce,
      bypassResources: new Set(["todos"]),
    });
    const rdb = bypassRdbFor(ctxFor(carol.id)); // Carol has no role
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

  it("rdb.sudo is the unwrapped db — reads and writes skip enforcement", async () => {
    const { db, rdbFor, cast: { alice, carol } } = tc;
    const rdb = rdbFor(ctxFor(carol.id)); // Carol has no role; sudo must still work

    // Read through .sudo bypasses enforcement.
    const rows = await rdb.sudo.select().from(todos);
    assert.equal(rows.length, 4);

    // Write through .sudo must be visible on the underlying db — proves
    // `.sudo` is the same instance, not a copy.
    await rdb.sudo.insert(todos).values({ title: "sudo-write", ownerId: alice.id });
    const [hit] = await db.select().from(todos).where(eq(todos.title, "sudo-write"));
    assert.equal(hit.title, "sudo-write");
    assert.equal(hit.ownerId, alice.id);
  });
});

describe("rbacDb.query — relational query API", () => {
  it("findMany injects the record-rule where (reader sees only own todos)", async () => {
    const { rdbFor, cast: { alice } } = tc;
    const rdb = rdbFor(ctxFor(alice.id));
    const rows = await rdb.query.todos.findMany();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r: any) => r.title).sort(),
      ["alice-1", "alice-2"],
    );
  });

  it("findFirst injects the record-rule where (reader cannot see other actors' rows)", async () => {
    const { rdbFor, cast: { alice, bob } } = tc;
    const rdb = rdbFor(ctxFor(alice.id));
    // bob-1 exists but is owned by bob — must not be findFirst-able by alice.
    const row = await rdb.query.todos.findFirst({
      where: (t: any, { eq: e }: any) => e(t.title, "bob-1"),
    });
    assert.equal(row, undefined, "bob-1 must be filtered out by the reader record rule");
    void bob;
  });

  it("admin (isAdmin) sees every row through findMany — no record-rule injection", async () => {
    const { rdbFor, cast: { bob } } = tc;
    const rdb = rdbFor(ctxFor(bob.id));
    const rows = await rdb.query.todos.findMany();
    assert.equal(rows.length, 4);
  });

  it("with: walks one level and injects the related table's record rule", async () => {
    const { rdbFor, cast: { alice } } = tc;
    const rdb = rdbFor(ctxFor(alice.id));
    // alice can read users (rule: id = current_user.id → only her own row).
    // The "ownerId" relation on each todo resolves to a user row; the rule
    // hides every user except alice, so todos owned by alice carry the
    // related user row and others should carry null.
    const rows = await rdb.query.todos.findMany({ with: { ownerId: true } });
    // Reader sees only her own 2 todos due to the todos rule.
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.ok(r.ownerId !== null, "alice's own todo must have a populated owner relation");
      assert.equal((r as any).ownerId.id, alice.id);
    }
  });

  it("with: nested two levels — record rules apply at every level", async () => {
    const { rdbFor, cast: { alice } } = tc;
    const rdb = rdbFor(ctxFor(alice.id));
    // todos → ownerId (user) → todos (inverse "many" promoted from users.todos)
    const rows = await rdb.query.todos.findMany({
      with: { ownerId: { with: { todos: true } } },
    });
    assert.equal(rows.length, 2);
    for (const r of rows) {
      const owner = (r as any).ownerId;
      assert.ok(owner, "owner present");
      // The nested todos relation must also be record-rule scoped to alice's todos.
      assert.equal(owner.todos.length, 2);
      assert.deepEqual(
        owner.todos.map((t: any) => t.title).sort(),
        ["alice-1", "alice-2"],
      );
    }
  });

  it("query bypassResources falls through to raw db.query", async () => {
    const { db, rbac, cast: { carol } } = tc;
    const bypassRdbFor = buildRbacDb({
      db,
      schema: allTables,
      enforce: rbac.enforce,
      bypassResources: new Set(["todos"]),
    });
    const rdb = bypassRdbFor(ctxFor(carol.id)); // no role, but bypass on todos
    const rows = await rdb.query.todos.findMany();
    assert.equal(rows.length, 4);
  });

  it("query honors .sudo passthrough", async () => {
    const { rdbFor, cast: { carol } } = tc;
    const rdb = rdbFor(ctxFor(carol.id)); // no role; enforced query would throw
    const rows = await rdb.sudo.query.todos.findMany();
    assert.equal(rows.length, 4);
  });

  it("findMany throws FORBIDDEN when the caller lacks the read ACL", async () => {
    const { rdbFor, cast: { carol } } = tc;
    const rdb = rdbFor(ctxFor(carol.id)); // no role → no read on todos
    await assert.rejects(
      () => rdb.query.todos.findMany(),
      /FORBIDDEN|forbidden|denied/i,
      "expected enforce to throw when the user has no read ACL on todos",
    );
  });

  it("callback-form `where` AND-combines with the record-rule extra (not OR or override)", async () => {
    const { rdbFor, cast: { alice } } = tc;
    const rdb = rdbFor(ctxFor(alice.id));
    // The user's callback narrows to title="bob-1" (a row alice does NOT own).
    // Without record-rule injection findMany would return bob-1; with it, the
    // AND with `ownerId = alice.id` must filter it out — proving the combiner
    // intersects rather than replacing the user filter.
    const rows = await rdb.query.todos.findMany({
      where: (t: any, { eq: e }: any) => e(t.title, "bob-1"),
    });
    assert.equal(rows.length, 0, "rule must AND with user filter; bob-1 is not alice's");

    // Sanity: same callback against an owned title returns the row, proving
    // the callback was actually applied (not dropped on the floor).
    const own = await rdb.query.todos.findMany({
      where: (t: any, { eq: e }: any) => e(t.title, "alice-1"),
    });
    assert.equal(own.length, 1);
    assert.equal(own[0].title, "alice-1");
  });

  it("with: throws when the caller lacks read access on the related table", async () => {
    const { db, rbac, cast: { alice } } = tc;
    // Local config grants alice read on todos but NOT on users.
    const localConfig = {
      roles: defineRoles({ readerNoUsers: {} }),
      accessRights: defineAccessRights({
        readerNoUsers: { todos: { read: true } },
      }),
      recordRules: defineRecordRules({}),
    };
    const localRbac = buildRbac(localConfig);
    localRbac.assignRole(alice.id, "readerNoUsers");
    const localRdbFor = buildRbacDb({
      db,
      schema: allTables,
      enforce: localRbac.enforce,
    });
    const rdb = localRdbFor(ctxFor(alice.id));
    // `with: { ownerId: ... }` triggers enforce(users, "read") on the related
    // table; alice has no users grant, so the walker must surface the throw.
    await assert.rejects(
      () => rdb.query.todos.findMany({ with: { ownerId: true } }),
      /FORBIDDEN|forbidden|denied/i,
    );
  });

  it("with: passes through unknown relation keys unchanged (Drizzle surfaces the error)", async () => {
    const { rdbFor, cast: { bob } } = tc; // admin — bypasses enforce
    const rdb = rdbFor(ctxFor(bob.id));
    // Unknown relation key — our walker doesn't know it, so it passes through;
    // Drizzle is then the one that complains. We assert *something* throws, not
    // a specific message, because the wording is Drizzle's to own.
    await assert.rejects(
      () => rdb.query.todos.findMany({ with: { nonexistent: true } }),
    );
  });
});

describe("rbacDb.transaction — sync-dialect guard", () => {
  it("throws on better-sqlite3 (sync dialect) with a sudo-handoff hint", async () => {
    const { rdbFor, cast: { alice } } = tc;
    const rdb = rdbFor(ctxFor(alice.id));
    assert.throws(
      () => rdb.transaction(async () => undefined),
      /sync dialects.*rdb\.sudo\.transaction/i,
    );
  });

  it(".sudo.transaction is the documented escape and runs the sync callback", async () => {
    const { rdbFor, cast: { alice } } = tc;
    const rdb = rdbFor(ctxFor(alice.id));
    const out: any[] = rdb.sudo.transaction((tx: any) => {
      const inserted = tx
        .insert(todos)
        .values({ title: "tx-sudo", ownerId: alice.id })
        .returning()
        .all();
      return inserted;
    });
    assert.equal(out[0].title, "tx-sudo");
    // Use sudo to read it back (alice's read view also includes it since she owns it).
    const [hit] = await rdb.select().from(todos).where(eq(todos.title, "tx-sudo"));
    assert.equal(hit.title, "tx-sudo");
    void users;
  });
});
