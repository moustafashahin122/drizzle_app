/**
 * RBAC enforcement at the GraphQL layer.
 *
 * Proves that `buildSchema(..., { rbac: { enforce } })` wires the rbac engine
 * into the generated resolvers — independently of the rdb proxy, which has
 * its own tests. Auth, ACL, record-rule narrowing, and admin bypass are all
 * exercised through real `graphql(...)` calls so the public contract is what
 * gets validated.
 *
 * Cast: Alice(reader), Bob(admin), Carol(no role). Per-test isolation via
 * `transactionCase` SAVEPOINT rollback — see `__helpers__.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { graphql } from "graphql";

import { buildSchema } from "../builder/builder.js";
import { buildRbac } from "./rbac.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./config.js";

import {
  allTables,
  assignRole,
  db,
  todos,
  users,
  anonCtx,
  ctxFor,
  freshDb,
  seedReaderAdmin,
  transactionCase,
} from "./__helpers__.js";

const ownRows = [["ownerId", "=", "current_user.id"]];
const baseConfig = {
  roles: defineRoles({
    reader: {},
    admin: { isAdmin: true },
  }),
  accessRights: defineAccessRights({
    reader: { todos: { read: true } },
  }),
  recordRules: defineRecordRules({
    reader: { todos: { read: { domain: ownRows } } },
  }),
};

const tc = transactionCase(async () => {
  const rbac = buildRbac(baseConfig);
  const schema = buildSchema(db, allTables, { rbac: { enforce: rbac.enforce } }).schema;
  const cast = await seedReaderAdmin(rbac);
  const run = (source: string, contextValue: any, variableValues?: Record<string, unknown>) =>
    graphql({ schema, source, contextValue, variableValues });
  return { db, rbac, schema, run, cast };
});

/**
 * Self-contained alt-config harness for tests that need a different rbac
 * config than the shared baseline (e.g. reader+update). Lives outside the
 * shared transactionCase because the config itself is part of the contract
 * under test.
 */
function makeIsolated(cfg: Parameters<typeof buildRbac>[0]) {
  const { db: d } = freshDb();
  const r = buildRbac(cfg);
  const sch = buildSchema(d, allTables, { rbac: { enforce: r.enforce } }).schema;
  const run = (source: string, contextValue: any, variableValues?: Record<string, unknown>) =>
    graphql({ schema: sch, source, contextValue, variableValues });
  return { db: d, rbac: r, schema: sch, run };
}

describe("rbac — enforcement (GraphQL layer)", () => {
  describe("deny paths", () => {
    const cases: Array<{ label: string; getCtx: () => any; error: RegExp }> = [
      {
        label: "unauthenticated caller (user=null)",
        getCtx: () => anonCtx(),
        error: /Not authenticated/,
      },
      {
        label: "authenticated user with no role memberships",
        getCtx: () => ctxFor(tc.cast.carol.id),
        error: /Access denied/,
      },
    ];

    for (const c of cases) {
      it(c.label, async () => {
        const r = await tc.run(`{ todos { id title } }`, c.getCtx());
        assert.equal(r.data?.todos ?? null, null, "data.todos should be null on deny");
        assert.equal(r.errors?.length, 1);
        assert.match(r.errors![0].message, c.error);
      });
    }
  });

  it("admin bypasses ACL and record rules — sees every todo verbatim", async () => {
    const { run, cast: { alice, bob, carol } } = tc;
    // ownerId is promoted to a relation on the output type, so traverse it.
    const r = await run(
      `{ todos { id title ownerId { id name } } }`,
      ctxFor(bob.id),
    );
    assert.equal(r.errors, undefined);
    type Row = { id: number; title: string; ownerId: { id: number; name: string } };
    const rows = (r.data as any).todos as Row[];
    assert.equal(rows.length, 4, "admin must see all four rows, unfiltered");
    const byTitle = Object.fromEntries(rows.map((t) => [t.title, t]));
    assert.deepEqual(Object.keys(byTitle).sort(), [
      "alice-1", "alice-2", "bob-1", "carol-1",
    ]);
    // Relation primary keys come back as GraphQL ID (string); coerce when comparing.
    const ownerNum = (r: Row) => Number(r.ownerId.id);
    assert.equal(ownerNum(byTitle["alice-1"]), alice.id);
    assert.equal(byTitle["alice-1"].ownerId.name, "Alice");
    assert.equal(ownerNum(byTitle["alice-2"]), alice.id);
    assert.equal(ownerNum(byTitle["bob-1"]),   bob.id);
    assert.equal(byTitle["bob-1"].ownerId.name, "Bob");
    assert.equal(ownerNum(byTitle["carol-1"]), carol.id);
    assert.equal(byTitle["carol-1"].ownerId.name, "Carol");
  });

  it("reader sees only own rows; record rule filters out other owners", async () => {
    const { run, cast: { alice } } = tc;
    // Reader has read on `todos` only — so the output query does NOT traverse
    // the `ownerId` relation (that would require a read ACL on `users`, which
    // relation traversal correctly enforces). Ownership is asserted on the
    // input side via a `where` filter on the scalar FK column.
    const r = await run(`{ todos { id title } }`, ctxFor(alice.id));
    assert.equal(r.errors, undefined);
    const rows = (r.data as any).todos as Array<{ id: number; title: string }>;
    assert.equal(rows.length, 2, "reader must see exactly their two todos");
    assert.deepEqual(rows.map((t) => t.title).sort(), ["alice-1", "alice-2"]);

    // The scalar `ownerId` remains usable on the input side — the same
    // record-rule scope expressed via `where` yields the same set.
    const r2 = await run(
      `query ($w: JSON) { todos(where: $w) { id } }`,
      ctxFor(alice.id),
      { w: [["ownerId", "=", alice.id]] },
    );
    assert.equal(r2.errors, undefined);
    assert.equal(((r2.data as any).todos as any[]).length, 2);
  });

  it("relation traversal enforces read ACL on the referenced table (no users grant → denied, localized to the relation field)", async () => {
    const { run, cast: { alice } } = tc;
    // Reader has no read ACL on `users`; traversing the `ownerId` relation
    // must fail with FORBIDDEN rather than silently returning rows (which is
    // what the pre-fix builder did). The deny must also be localized: the
    // parent `todos` list still resolves (the reader IS allowed to read
    // todos), only the nested `ownerId` field nulls out with an error per
    // row — proving the new guard fires per-relation, not at the query root.
    const r = await run(`{ todos { id title ownerId { id } } }`, ctxFor(alice.id));
    const rows = (r.data as any)?.todos as Array<{ id: number; title: string; ownerId: any }> | null;

    // Errors: one per attempted traversal (one per reader-visible todo row).
    assert.ok(r.errors && r.errors.length >= 1, "expected at least one deny error");
    for (const err of r.errors!) {
      assert.match(err.message, /Access denied|forbidden/i);
      // The error path must end at `ownerId` — proves the guard fired on the
      // relation field, not at the root `todos` resolver.
      assert.equal(err.path?.[err.path.length - 1], "ownerId");
    }
    assert.equal(r.errors!.length, 2, "one deny per reader-visible todo row");

    // Data localization: parent rows still come back (root `todos` is
    // allowed), with `ownerId` nulled out everywhere.
    assert.ok(Array.isArray(rows), "todos list must still resolve");
    assert.equal(rows!.length, 2, "reader sees their own 2 todos");
    assert.deepEqual(rows!.map((t) => t.title).sort(), ["alice-1", "alice-2"]);
    assert.ok(rows!.every((t) => t.ownerId === null), "every ownerId must be null on the denied path");
  });

  it("reader cannot create todos and the table remains unchanged (no canCreate)", async () => {
    const { db, run, cast: { alice } } = tc;
    const before = await db.select().from(todos);
    assert.equal(before.length, 4);

    const r = await run(
      `mutation { insertIntoTodos(values: [{ title: "x", ownerId: ${alice.id} }]) { id } }`,
      ctxFor(alice.id),
    );
    assert.equal(r.errors?.length, 1);
    assert.match(r.errors![0].message, /Access denied/);

    // Isolation: no row was inserted by the denied mutation.
    const after = await db.select().from(todos);
    assert.equal(after.length, 4);
    assert.ok(after.every((t) => t.title !== "x"));
  });

  it("update record rule narrows mutation scope to the reader's own rows", async () => {
    // Reader needs `update` here — build an alt-config schema rather than
    // mutating the shared baseline. Self-contained: its own DB + rbac.
    const own = [["ownerId", "=", "current_user.id"]];
    const iso = makeIsolated({
      roles: defineRoles({ reader: {} }),
      accessRights: defineAccessRights({
        reader: { todos: { read: true, update: true } },
      }),
      recordRules: defineRecordRules({
        reader: {
          todos: {
            read:   { domain: own },
            update: { domain: own },
          },
        },
      }),
    });

    const [u1] = await iso.db.insert(users).values({ name: "Alice" }).returning();
    const [u2] = await iso.db.insert(users).values({ name: "Bob" }).returning();
    await assignRole(iso.rbac, u1.id, "reader", iso.db);
    await iso.db.insert(todos).values([
      { title: "alice-1", ownerId: u1.id },
      { title: "bob-1",   ownerId: u2.id },
    ]);

    const r = await iso.run(
      `mutation ($w: JSON) { updateTodos(set: { title: "stolen" }, where: $w) { id title } }`,
      ctxFor(u1.id),
      { w: [["title", "=", "bob-1"]] },
    );
    assert.equal(r.errors, undefined);
    assert.deepEqual((r.data as any).updateTodos, [], "no rows returned for cross-owner update");

    // Isolation: bob's row untouched, AND alice's own row (not targeted) also untouched.
    const [bob] = await iso.db.select().from(todos).where(eq(todos.title, "bob-1"));
    assert.equal(bob.title, "bob-1");
    assert.equal(bob.ownerId, u2.id);
    const [alice] = await iso.db.select().from(todos).where(eq(todos.ownerId, u1.id));
    assert.equal(alice.title, "alice-1");
  });

  describe("config validation (unit)", () => {
    it("rejects unknown role on assignRole", async () => {
      await assert.rejects(() => assignRole(tc.rbac, 1, "ghost"), /unknown role/);
    });

    it("rejects empty roles config at build time", () => {
      assert.throws(
        () => buildRbac({ roles: {}, accessRights: {}, recordRules: {} }),
        /roles config is empty/,
      );
    });
  });
});
