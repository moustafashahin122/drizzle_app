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
import { sqliteTable, integer } from "drizzle-orm/sqlite-core";

import { buildRbac } from "./rbac.js";
import { buildRbacDb } from "./rbacDb.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./config.js";

import {
  DOMAIN_OWN,
  DOMAIN_SELF,
  allTables,
  assignRole,
  byTitle,
  db,
  todos,
  users,
  ctxFor,
  seedReaderAdmin,
  transactionCase,
} from "./__helpers__.js";

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
      todos: { read: { domain: DOMAIN_OWN as any } },
      users: { read: { domain: DOMAIN_SELF as any } },
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
    const indexed = byTitle(rows as any[]);
    assert.deepEqual(Object.keys(indexed).sort(), [
      "alice-1", "alice-2", "bob-1", "carol-1",
    ]);
    assert.equal(indexed["alice-1"].ownerId, alice.id);
    assert.equal(indexed["bob-1"].ownerId,   bob.id);
    assert.equal(indexed["carol-1"].ownerId, carol.id);
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
    const indexed = byTitle(rows as any[]);
    assert.deepEqual(Object.keys(indexed).sort(), [
      "alice-1", "alice-2", "bob-1", "carol-1",
    ]);
    assert.equal(indexed["alice-1"].ownerId, alice.id);
    assert.equal(indexed["bob-1"].ownerId,   bob.id);
    assert.equal(indexed["carol-1"].ownerId, carol.id);
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
    await assignRole(localRbac, alice.id, "readerNoUsers");
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

describe("rbacDb — proxy plumbing", () => {
  it("select(table) on a table not in the schema namespace throws a clear message", () => {
    const { rdbFor, cast: { bob } } = tc;
    const rdb = rdbFor(ctxFor(bob.id));
    // A table object the factory never saw — must NOT silently bypass enforce
    // and must NOT crash with an opaque undefined-deref. The error names the
    // contract so callers can act on it.
    const stray = sqliteTable("stray", {
      id: integer("id").primaryKey({ autoIncrement: true }),
    });
    assert.throws(
      () => rdb.select().from(stray),
      /not registered in the schema namespace/,
      "unregistered tables must be rejected at .from()",
    );
  });

  it("select(projection) forwards the projected shape verbatim through the proxy", async () => {
    const { rdbFor, cast: { bob } } = tc; // admin → sees all rows
    const rdb = rdbFor(ctxFor(bob.id));
    const rows: any[] = await rdb.select({ id: todos.id }).from(todos);
    assert.equal(rows.length, 4);
    for (const r of rows) {
      assert.deepEqual(
        Object.keys(r),
        ["id"],
        "projection must constrain the returned columns — proxy must not widen the shape",
      );
      assert.equal(typeof r.id, "number");
    }
  });

  it("update with no caller .where() and an admin (no extra where) updates every row", async () => {
    // Exercises the makeWhereInjectingProxy branch where combineWhere returns
    // undefined and the proxy must NOT attach a `.where(...)` to the chain.
    // If a stray where slipped in, the row count would not match.
    const { db, rdbFor, cast: { bob } } = tc;
    const rdb = rdbFor(ctxFor(bob.id));
    const updated: any[] = await rdb.update(todos).set({ title: "all-updated" }).returning();
    assert.equal(updated.length, 4, "no where attached ⇒ every row updated");
    const all = await db.select().from(todos);
    assert.equal(all.length, 4);
    assert.ok(
      all.every((r) => r.title === "all-updated"),
      "every persisted row reflects the unrestricted update",
    );
  });

  it("query.<unknownJsKey> falls through to the raw db.query[prop]", () => {
    const { rdbFor, cast: { bob } } = tc;
    const rdb = rdbFor(ctxFor(bob.id));
    // `nonexistent` is not a table in `allTables`; drizzle's relational query
    // object also has no such key, so the proxy's fallthrough returns
    // `db.query?.[prop]` which is `undefined`. The contract is "don't throw,
    // let drizzle decide" — proven by the absence of an exception and the
    // undefined value.
    assert.equal(rdb.query.nonexistent, undefined);
  });
});

describe("rbacDb.bypassResources — opt-out passthrough for every mutating verb", () => {
  // The existing tests cover bypass for select() and query.findMany(). Update,
  // delete, and insert each have their own bypass branch inside RbacDb and
  // none of them are exercised elsewhere. Carol has no role in the seed —
  // without bypass every verb would throw FORBIDDEN, so a successful mutation
  // is itself proof that enforce was skipped.

  function buildBypassRdbFor() {
    const rbac = buildRbac(rbacConfig);
    return buildRbacDb({
      db,
      schema: allTables,
      enforce: rbac.enforce,
      bypassResources: new Set(["todos"]),
    });
  }

  it("update on a bypassed resource skips enforce — a role-less user can mutate", async () => {
    const { db, cast: { carol } } = tc;
    const rdb = buildBypassRdbFor()(ctxFor(carol.id));
    const updated: any[] = await rdb
      .update(todos)
      .set({ title: "bypass-updated" })
      .where(eq(todos.title, "alice-1"))
      .returning();
    assert.equal(updated.length, 1);
    assert.equal(updated[0].title, "bypass-updated");
    // Isolation: only the targeted row was touched.
    const all = await db.select().from(todos);
    assert.equal(all.length, 4);
    assert.equal(all.filter((r) => r.title === "bypass-updated").length, 1);
    assert.deepEqual(
      all.map((r) => r.title).sort(),
      ["alice-2", "bob-1", "bypass-updated", "carol-1"],
    );
  });

  it("delete on a bypassed resource skips enforce — a role-less user can delete", async () => {
    const { db, cast: { carol } } = tc;
    const rdb = buildBypassRdbFor()(ctxFor(carol.id));
    const deleted: any[] = await rdb
      .delete(todos)
      .where(eq(todos.title, "alice-1"))
      .returning();
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].title, "alice-1");
    // Isolation: only that row vanished; the rest are intact.
    const remaining = await db.select().from(todos);
    assert.equal(remaining.length, 3);
    assert.deepEqual(
      remaining.map((r) => r.title).sort(),
      ["alice-2", "bob-1", "carol-1"],
    );
  });

  it("insert on a bypassed resource skips enforce — a role-less user can create", async () => {
    const { db, cast: { carol } } = tc;
    const rdb = buildBypassRdbFor()(ctxFor(carol.id));
    const inserted: any[] = await rdb
      .insert(todos)
      .values({ title: "bypass-inserted", ownerId: carol.id })
      .returning();
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].title, "bypass-inserted");
    assert.equal(inserted[0].ownerId, carol.id);
    // The row actually landed in the DB, not just in the returning payload.
    const all = await db.select().from(todos);
    assert.equal(all.length, 5);
    const [hit] = await db.select().from(todos).where(eq(todos.title, "bypass-inserted"));
    assert.equal(hit.ownerId, carol.id);
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
