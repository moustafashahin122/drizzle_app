/**
 * Unit-level tests for the RBAC engine — every public path of `buildRbac`
 * exercised without going through GraphQL. The GraphQL-layer tests in
 * `rbac.test.ts` cover the resolver wiring; this file fills the remaining
 * branches:
 *
 *  - enforce: cache hits (success + forbidden), missing ctx.batch,
 *    unrestricted-rule fallthroughs, multi-role OR-combine, single-rule
 *    short-circuit, action-not-granted deny.
 *  - membership API: listRoleKeys, listUserRoles, assignRole duplicate /
 *    unknown, revokeRole success / not-assigned / unknown / cleanup,
 *    hasRole, isAdmin.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";

import { buildRbac } from "./rbac.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./config.js";
import { freshDb, todos, users } from "./__helpers__.js";
import type { ColumnMap } from "../builder/filters.js";

const todosCols = getTableColumns(todos) as ColumnMap;

const userCtx = (id: number) => ({
  user: { id, name: `u${id}` } as any,
  batch: new Map<string, unknown>(),
});

describe("rbac — engine unit", () => {
  describe("enforce", () => {
    it("admin via membership bypasses ACL even without grants", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ admin: { isAdmin: true } }),
        accessRights: {},
        recordRules: {},
      });
      rbac.assignRole(7, "admin");
      const out = await rbac.enforce(userCtx(7), "todos", "read", todosCols);
      assert.deepEqual(out, {});
    });

    it("granting role with no record rule → unrestricted ({ where: undefined })", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      rbac.assignRole(1, "reader");
      const out = await rbac.enforce(userCtx(1), "todos", "read", todosCols);
      assert.deepEqual(out, {});
    });

    it("rule whose domain compiles to null SQL is treated as unrestricted", async () => {
      // Leaf references a column that does NOT exist on the columns map →
      // domainToSql returns undefined → enforce sets anyUnrestricted = true
      // and returns `{}`.
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: defineRecordRules({
          reader: { todos: { read: { domain: [["nope", "=", 1]] } } },
        }),
      });
      rbac.assignRole(1, "reader");
      const out = await rbac.enforce(userCtx(1), "todos", "read", todosCols);
      assert.deepEqual(out, {});
    });

    it("denies action that no granting role permits", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      rbac.assignRole(1, "reader");
      await assert.rejects(
        () => rbac.enforce(userCtx(1), "todos", "delete", todosCols),
        /Access denied on 'todos' for 'delete'/,
      );
    });

    it("denies resource that no granting role covers", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      rbac.assignRole(1, "reader");
      await assert.rejects(
        () => rbac.enforce(userCtx(1), "users", "read", todosCols),
        /Access denied on 'users'/,
      );
    });

    it("returns a single rule's SQL verbatim when only one granting role has a rule", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: defineRecordRules({
          reader: { todos: { read: { domain: [["ownerId", "=", "current_user.id"]] } } },
        }),
      });
      rbac.assignRole(42, "reader");
      const out = await rbac.enforce(userCtx(42), "todos", "read", todosCols);
      assert.ok(out.where, "single rule must produce a where");
    });

    it("OR-combines record rules across multiple granting roles", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ owner: {}, titler: {} }),
        accessRights: defineAccessRights({
          owner:  { todos: { read: true } },
          titler: { todos: { read: true } },
        }),
        recordRules: defineRecordRules({
          owner:  { todos: { read: { domain: [["ownerId", "=", "current_user.id"]] } } },
          titler: { todos: { read: { domain: [["title", "=", "x"]] } } },
        }),
      });
      rbac.assignRole(9, "owner");
      rbac.assignRole(9, "titler");
      const out = await rbac.enforce(userCtx(9), "todos", "read", todosCols);
      assert.ok(out.where, "two rules → combined where");
    });

    it("a granting role without a rule unlocks the whole query (unrestricted wins over the OR)", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ ruled: {}, unruled: {} }),
        accessRights: defineAccessRights({
          ruled:   { todos: { read: true } },
          unruled: { todos: { read: true } },
        }),
        recordRules: defineRecordRules({
          ruled: { todos: { read: { domain: [["ownerId", "=", "current_user.id"]] } } },
        }),
      });
      rbac.assignRole(3, "ruled");
      rbac.assignRole(3, "unruled");
      const out = await rbac.enforce(userCtx(3), "todos", "read", todosCols);
      assert.deepEqual(out, {});
    });

    it("rejects unauthenticated callers", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      await assert.rejects(
        () => rbac.enforce({ user: null, batch: new Map() } as any, "todos", "read", todosCols),
        /Not authenticated/,
      );
    });

    it("denies authenticated user with no role memberships", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      await assert.rejects(
        () => rbac.enforce(userCtx(123), "todos", "read", todosCols),
        /Access denied on 'todos'/,
      );
    });

    it("works without ctx.batch (cache is optional)", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      rbac.assignRole(1, "reader");
      const ctx = { user: { id: 1, name: "u" } } as any;
      const out = await rbac.enforce(ctx, "todos", "read", todosCols);
      assert.deepEqual(out, {});
    });

    it("memoizes successful results in ctx.batch so repeated calls reuse them", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      rbac.assignRole(1, "reader");
      const ctx = userCtx(1);
      const first  = await rbac.enforce(ctx, "todos", "read", todosCols);
      const second = await rbac.enforce(ctx, "todos", "read", todosCols);
      assert.equal(first, second, "second call must return the same memoized object");
      assert.equal(ctx.batch.size, 1, "exactly one cache entry written");
    });

    it("cache key isolates (resource, action) pairs for the same user", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ rw: {} }),
        accessRights: defineAccessRights({
          rw: { todos: { read: true, update: true }, users: { read: true } },
        }),
        recordRules: defineRecordRules({
          rw: {
            todos: { read: { domain: [["ownerId", "=", "current_user.id"]] } },
          },
        }),
      });
      rbac.assignRole(1, "rw");
      const ctx = userCtx(1);

      const todosRead   = await rbac.enforce(ctx, "todos", "read",   todosCols);
      const todosUpdate = await rbac.enforce(ctx, "todos", "update", todosCols);
      const usersRead   = await rbac.enforce(ctx, "users", "read",   todosCols);

      assert.ok(todosRead.where, "todos:read has a record rule → where defined");
      assert.equal(todosUpdate.where, undefined, "todos:update has no record rule → unrestricted");
      assert.equal(usersRead.where,   undefined, "users:read  has no record rule → unrestricted");
      assert.equal(ctx.batch.size, 3, "three distinct cache entries — one per (resource, action) tuple");
      assert.ok(ctx.batch.has("__rbac_enforce:1:todos:read"));
      assert.ok(ctx.batch.has("__rbac_enforce:1:todos:update"));
      assert.ok(ctx.batch.has("__rbac_enforce:1:users:read"));
    });

    it("cache is per-user — two callers do not poach each other's memos", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {}, denied: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      rbac.assignRole(1, "reader");
      rbac.assignRole(2, "denied");

      const ctxA = userCtx(1);
      const ctxB = userCtx(2);
      const a = await rbac.enforce(ctxA, "todos", "read", todosCols);
      assert.deepEqual(a, {}, "user 1 (reader) → unrestricted allow");
      await assert.rejects(
        () => rbac.enforce(ctxB, "todos", "read", todosCols),
        /Access denied on 'todos' for 'read'/,
        "user 2 (no grant) must not see user 1's cached allow",
      );
    });

    it("successful cache survives later revocation (stale-but-cached)", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      rbac.assignRole(1, "reader");
      const ctx = userCtx(1);
      const first = await rbac.enforce(ctx, "todos", "read", todosCols);
      rbac.revokeRole(1, "reader");
      // A fresh evaluation would now deny — but the cache short-circuits.
      const second = await rbac.enforce(ctx, "todos", "read", todosCols);
      assert.equal(second, first, "cache returns the original memo unchanged");
    });

    it("admin role wins when mixed with non-admin roles (no record-rule narrowing applied)", async () => {
      const rbac = buildRbac({
        roles: defineRoles({
          reader: {},
          root:   { isAdmin: true },
        }),
        accessRights: defineAccessRights({
          reader: { todos: { read: true } },
        }),
        recordRules: defineRecordRules({
          reader: { todos: { read: { domain: [["ownerId", "=", "current_user.id"]] } } },
        }),
      });
      rbac.assignRole(1, "reader");
      rbac.assignRole(1, "root");
      const out = await rbac.enforce(userCtx(1), "todos", "read", todosCols);
      assert.deepEqual(out, {}, "admin bypass fires before per-role rule evaluation");
    });

    it("only granting roles contribute their record rules to the OR-combine", async () => {
      // `other` has a rule on todos:read but no read grant — its rule must be
      // ignored, leaving only `reader`'s rule. If the engine wrongly OR-ed
      // `other`'s rule in, the where would broaden to also match title='x'.
      const rbac = buildRbac({
        roles: defineRoles({ reader: {}, other: {} }),
        accessRights: defineAccessRights({
          reader: { todos: { read: true } },
          // `other` only has update on todos — read must not pull its rule in.
          other:  { todos: { update: true } },
        }),
        recordRules: defineRecordRules({
          reader: { todos: { read: { domain: [["ownerId", "=", "current_user.id"]] } } },
          other:  { todos: { read: { domain: [["title",   "=", "x"]] } } },
        }),
      });
      rbac.assignRole(1, "reader");
      rbac.assignRole(1, "other");

      // Wire enforce through a real DB so we can prove the produced SQL is
      // *only* the reader's ownerId filter — not OR-ed with title='x'.
      const { db } = freshDb();
      const [me]    = await db.insert(users).values({ name: "Me"    }).returning();
      const [other] = await db.insert(users).values({ name: "Other" }).returning();
      await db.insert(todos).values([
        { title: "mine",  ownerId: me.id    },  // matches reader rule
        { title: "x",     ownerId: other.id }, // would match if other's rule leaked in
        { title: "noise", ownerId: other.id },
      ]);

      const { where } = await rbac.enforce(userCtx(me.id), "todos", "read", todosCols);
      assert.ok(where, "reader rule must produce a where");
      const rows = await db.select().from(todos).where(where!);
      assert.deepEqual(rows.map((r) => r.title), ["mine"]);
    });

    it("multiple granting roles all unruled → unrestricted via the missing-domain branch", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ a: {}, b: {} }),
        accessRights: defineAccessRights({
          a: { todos: { read: true } },
          b: { todos: { read: true } },
        }),
        recordRules: {},
      });
      rbac.assignRole(1, "a");
      rbac.assignRole(1, "b");
      const out = await rbac.enforce(userCtx(1), "todos", "read", todosCols);
      assert.deepEqual(out, {}, "no rules anywhere → anyUnrestricted=true → {}");
    });

    it("placeholder current_user.id is bound to ctx.user.id in the produced SQL", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: defineRecordRules({
          reader: { todos: { read: { domain: [["ownerId", "=", "current_user.id"]] } } },
        }),
      });
      const { db } = freshDb();
      const [me]    = await db.insert(users).values({ name: "Me"    }).returning();
      const [other] = await db.insert(users).values({ name: "Other" }).returning();
      await db.insert(todos).values([
        { title: "mine",   ownerId: me.id    },
        { title: "theirs", ownerId: other.id },
      ]);
      rbac.assignRole(me.id, "reader");
      rbac.assignRole(other.id, "reader");

      const mine   = await rbac.enforce(userCtx(me.id),    "todos", "read", todosCols);
      const theirs = await rbac.enforce(userCtx(other.id), "todos", "read", todosCols);
      const myRows    = await db.select().from(todos).where(mine.where!);
      const theirRows = await db.select().from(todos).where(theirs.where!);
      assert.deepEqual(myRows.map((r) => r.title),    ["mine"]);
      assert.deepEqual(theirRows.map((r) => r.title), ["theirs"]);
    });

    it("memoizes forbidden results so repeated calls throw without re-evaluating", async () => {
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      rbac.assignRole(1, "reader");
      const ctx = userCtx(1);
      await assert.rejects(() => rbac.enforce(ctx, "todos", "delete", todosCols), /Access denied/);

      // Sabotage the engine after the first call: revoke the role so a fresh
      // evaluation would now take the "no memberships" branch with a different
      // message. The cached deny must still surface with the original message.
      rbac.revokeRole(1, "reader");
      await assert.rejects(
        () => rbac.enforce(ctx, "todos", "delete", todosCols),
        /Access denied on 'todos' for 'delete'/,
      );
    });
  });

  describe("membership API", () => {
    const make = () =>
      buildRbac({
        roles: defineRoles({
          reader: {},
          writer: {},
          root:   { isAdmin: true },
        }),
        accessRights: {},
        recordRules: {},
      });

    it("listRoleKeys returns every defined role key, sorted", () => {
      const rbac = make();
      assert.deepEqual(rbac.listRoleKeys(), ["reader", "root", "writer"]);
    });

    it("listUserRoles is empty for an unknown user", () => {
      const rbac = make();
      assert.deepEqual(rbac.listUserRoles(999), []);
    });

    it("listUserRoles returns assigned roles sorted; survives revocation back to empty", () => {
      const rbac = make();
      rbac.assignRole(1, "writer");
      rbac.assignRole(1, "reader");
      assert.deepEqual(rbac.listUserRoles(1), ["reader", "writer"]);
      assert.equal(rbac.revokeRole(1, "reader"), true);
      assert.deepEqual(rbac.listUserRoles(1), ["writer"]);
      assert.equal(rbac.revokeRole(1, "writer"), true);
      assert.deepEqual(rbac.listUserRoles(1), [], "fully revoked user reads back empty");
    });

    it("assignRole returns true once, false on duplicate", () => {
      const rbac = make();
      assert.equal(rbac.assignRole(1, "reader"), true);
      assert.equal(rbac.assignRole(1, "reader"), false);
    });

    it("assignRole throws on unknown role key", () => {
      const rbac = make();
      assert.throws(() => rbac.assignRole(1, "ghost"), /unknown role 'ghost'/);
    });

    it("revokeRole returns false when the user does not hold the role", () => {
      const rbac = make();
      assert.equal(rbac.revokeRole(1, "reader"), false, "never assigned");
      rbac.assignRole(2, "reader");
      assert.equal(rbac.revokeRole(1, "reader"), false, "wrong user");
    });

    it("revokeRole throws on unknown role key", () => {
      const rbac = make();
      assert.throws(() => rbac.revokeRole(1, "ghost"), /unknown role 'ghost'/);
    });

    it("hasRole reports membership in the engine's role registry, not user memberships", () => {
      const rbac = make();
      assert.equal(rbac.hasRole("reader"), true);
      assert.equal(rbac.hasRole("ghost"),  false);
    });

    it("isAdmin is true only while a user holds an admin-flagged role", () => {
      const rbac = make();
      assert.equal(rbac.isAdmin(1), false, "no memberships");
      rbac.assignRole(1, "reader");
      assert.equal(rbac.isAdmin(1), false, "non-admin role does not flip the bit");
      rbac.assignRole(1, "root");
      assert.equal(rbac.isAdmin(1), true);
      rbac.revokeRole(1, "root");
      assert.equal(rbac.isAdmin(1), false, "revoking the admin role drops the bit");
    });
  });
});
