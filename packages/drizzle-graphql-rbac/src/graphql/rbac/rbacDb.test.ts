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
 *   - the `.raw` escape hatch
 *
 * Cast comes from `__helpers__.ts`: Alice(reader), Bob(admin), Carol(no role).
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
  seedReaderAdmin,
  type Db,
} from "./__helpers__.js";

const own = [["ownerId", "=", "current_user.id"]];
const rbacConfig = {
  roles: defineRoles({
    reader: {},
    admin: { isAdmin: true },
  }),
  accessRights: defineAccessRights({
    reader: { todos: { read: true } },
  }),
  recordRules: defineRecordRules({
    reader: { todos: { read: { domain: own } } },
  }),
};

let sqlite: ReturnType<typeof freshDb>["sqlite"];
let db: Db;
let rdbFor: ReturnType<typeof buildRbacDb>;
let rbac: BuiltRbac;

before(() => {
  const f = freshDb();
  sqlite = f.sqlite;
  db = f.db;
  rbac = buildRbac(rbacConfig);
  rdbFor = buildRbacDb({ db, schema: allTables, enforce: rbac.enforce });
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM todos; DELETE FROM users;`);
  clearAllMemberships(rbac);
});

describe("rbacDb — proxy-specific contracts", () => {
  it("admin role short-circuits enforcement at the rdb layer (sees every row)", async () => {
    const { alice, bob, carol } = await seedReaderAdmin(db, rbac);
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
    const { bob } = await seedReaderAdmin(db, rbac);
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
    const { alice, bob, carol } = await seedReaderAdmin(db, rbac);
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

  it("rdb.raw is the unwrapped db — reads and writes skip enforcement", async () => {
    const { alice, carol } = await seedReaderAdmin(db, rbac);
    const rdb = rdbFor(ctxFor(carol.id)); // Carol has no role; raw must still work

    // Read through .raw bypasses enforcement.
    const rows = await rdb.raw.select().from(todos);
    assert.equal(rows.length, 4);

    // Write through .raw must be visible on the underlying db — proves
    // `.raw` is the same instance, not a copy.
    await rdb.raw.insert(todos).values({ title: "raw-write", ownerId: alice.id });
    const [hit] = await db.select().from(todos).where(eq(todos.title, "raw-write"));
    assert.equal(hit.title, "raw-write");
    assert.equal(hit.ownerId, alice.id);
  });
});
