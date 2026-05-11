/**
 * RBAC enforcement at the GraphQL layer.
 *
 * Proves that `buildSchema(..., { rbac: { enforce } })` wires the rbac engine
 * into the generated resolvers — independently of the rdb proxy, which has
 * its own tests. Auth, ACL, record-rule narrowing, and admin bypass are all
 * exercised through real `graphql(...)` calls so the public contract is what
 * gets validated.
 *
 * Cast and tables come from `__helpers__.ts`. The cast used here is
 * Alice(reader) / Bob(admin) / Carol(no role).
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { graphql, type GraphQLSchema } from "graphql";

import { buildSchema } from "../builder/builder.js";
import { buildRbac, type BuiltRbac } from "./rbac.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./config.js";

import {
  allTables,
  todos,
  users,
  anonCtx,
  ctxFor,
  clearAllMemberships,
  freshDb,
  seedReaderAdmin,
  type Db,
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

/**
 * Builds an isolated DB + RBAC + GraphQL schema for tests that need a config
 * different from `baseConfig`. Each test that uses this owns its own DB so
 * it cannot leak state into the shared baseline.
 */
function makeIsolated(cfg: Parameters<typeof buildRbac>[0]) {
  const { db: d } = freshDb();
  const r = buildRbac(cfg);
  const sch = buildSchema(d, allTables, { rbac: { enforce: r.enforce } }).schema;
  const run = (source: string, contextValue: any, variableValues?: Record<string, unknown>) =>
    graphql({ schema: sch, source, contextValue, variableValues });
  return { db: d, rbac: r, schema: sch, run };
}

let sqlite: ReturnType<typeof freshDb>["sqlite"];
let db: Db;
let schema: GraphQLSchema;
let rbac: BuiltRbac;

before(() => {
  const f = freshDb();
  sqlite = f.sqlite;
  db = f.db;
  rbac = buildRbac(baseConfig);
  schema = buildSchema(db, allTables, { rbac: { enforce: rbac.enforce } }).schema;
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM todos; DELETE FROM users;`);
  clearAllMemberships(rbac);
});

async function run(query: string, contextValue: any, variableValues?: Record<string, unknown>) {
  return graphql({ schema, source: query, contextValue, variableValues });
}

describe("rbac — enforcement (GraphQL layer)", () => {
  describe("deny paths", () => {
    // Each case captures how to build a context FROM the seeded cast — that
    // avoids the autoincrement trap where DELETE doesn't reset SQLite's
    // primary-key counter, so hardcoded ids drift after the first test runs.
    const cases: Array<{
      label: string;
      ctx: (cast: { carol: { id: number } }) => any;
      error: RegExp;
    }> = [
      {
        label: "unauthenticated caller (user=null)",
        ctx: () => anonCtx(),
        error: /Not authenticated/,
      },
      {
        label: "authenticated user with no role memberships",
        ctx: (cast) => ctxFor(cast.carol.id),
        error: /Access denied/,
      },
    ];

    for (const c of cases) {
      it(c.label, async () => {
        const cast = await seedReaderAdmin(db, rbac);
        const r = await run(`{ todos { id title } }`, c.ctx(cast));
        assert.equal(r.data?.todos ?? null, null, "data.todos should be null on deny");
        assert.equal(r.errors?.length, 1);
        assert.match(r.errors![0].message, c.error);
      });
    }
  });

  it("admin bypasses ACL and record rules — sees every todo verbatim", async () => {
    const { alice, bob, carol } = await seedReaderAdmin(db, rbac);
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
    const { alice, bob, carol } = await seedReaderAdmin(db, rbac);
    const r = await run(
      `{ todos { id title ownerId { id } } }`,
      ctxFor(alice.id),
    );
    assert.equal(r.errors, undefined);
    type Row = { id: number; title: string; ownerId: { id: number } };
    const rows = (r.data as any).todos as Row[];
    assert.equal(rows.length, 2, "reader must see exactly their two todos");
    assert.deepEqual(rows.map((t) => t.title).sort(), ["alice-1", "alice-2"]);
    assert.ok(
      rows.every((t) => Number(t.ownerId.id) === alice.id),
      "every returned row must be scoped to the calling reader",
    );
    assert.ok(rows.every((t) => Number(t.ownerId.id) !== bob.id && Number(t.ownerId.id) !== carol.id));

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

  it("reader cannot create todos and the table remains unchanged (no canCreate)", async () => {
    const { alice } = await seedReaderAdmin(db, rbac);
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
    // Reader needs `update` here, so build an isolated config rather than
    // mutating baseConfig (which other tests rely on).
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
    iso.rbac.assignRole(u1.id, "reader");
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
    assert.deepEqual((r.data as any).updateTodos, [], "no rows must be returned for cross-owner update");

    // Isolation: bob's row untouched, AND alice's own row (not targeted) also untouched.
    const [bob] = await iso.db.select().from(todos).where(eq(todos.title, "bob-1"));
    assert.equal(bob.title, "bob-1");
    assert.equal(bob.ownerId, u2.id);
    const [alice] = await iso.db.select().from(todos).where(eq(todos.ownerId, u1.id));
    assert.equal(alice.title, "alice-1");
  });

  describe("config validation (unit)", () => {
    it("rejects unknown role on assignRole", () => {
      assert.throws(() => rbac.assignRole(1, "ghost"), /unknown role/);
    });

    it("rejects empty roles config at build time", () => {
      assert.throws(
        () => buildRbac({ roles: {}, accessRights: {}, recordRules: {} }),
        /roles config is empty/,
      );
    });
  });
});
