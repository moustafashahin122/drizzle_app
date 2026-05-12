/**
 * Unit-level tests for the RBAC engine — every meaningful branch of
 * `enforce()` exercised without going through GraphQL. The GraphQL-layer
 * tests in `rbac.test.ts` cover the resolver wiring; this file covers:
 *
 *  - auth/role gating: unauthenticated, roleless, action-not-granted,
 *    resource-not-granted, admin bypass.
 *  - record-rule branches: no rule → unrestricted, null-SQL rule →
 *    unrestricted, real rule → SQL emitted, placeholder substitution.
 *  - cache: success memoize, deny memoize, (resource, action) cache key,
 *    per-user isolation, optional batch, post-evaluation stability.
 *
 * Roles are DB-backed (single role per user via `users.role_id`). Each
 * test uses `freshDb()` so writes are isolated.
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
import {
  assignRole,
  ctxFor,
  freshDb,
  todos,
  users,
  type Db,
} from "./__helpers__.js";
import type { ColumnMap } from "../builder/filters.js";

const todosCols = getTableColumns(todos) as ColumnMap;

/** Insert a user row in `targetDb` and return its id. */
async function insertUser(targetDb: Db, name = "u"): Promise<number> {
  const [u] = await targetDb.insert(users).values({ name }).returning();
  return u.id;
}

describe("rbac — engine unit", () => {
  describe("enforce", () => {
    it("admin via membership bypasses ACL even without grants", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ admin: { isAdmin: true } }),
        accessRights: {},
        recordRules: {},
      });
      const uid = await insertUser(db);
      await assignRole(rbac, uid, "admin", db);
      const out = await rbac.enforce(ctxFor(uid, db), "todos", "read", todosCols);
      assert.deepEqual(out, {});
    });

    it("granting role with no record rule → unrestricted ({ where: undefined })", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      const uid = await insertUser(db);
      await assignRole(rbac, uid, "reader", db);
      const out = await rbac.enforce(ctxFor(uid, db), "todos", "read", todosCols);
      assert.deepEqual(out, {});
    });

    it("rule whose domain compiles to null SQL is treated as unrestricted", async () => {
      // Leaf references a column that does NOT exist on the columns map →
      // domainToSql returns undefined → enforce returns `{}` (unrestricted).
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: defineRecordRules({
          reader: { todos: { read: { domain: [["nope", "=", 1]] } } },
        }),
      });
      const uid = await insertUser(db);
      await assignRole(rbac, uid, "reader", db);
      const out = await rbac.enforce(ctxFor(uid, db), "todos", "read", todosCols);
      assert.deepEqual(out, {});
    });

    it("denies action that the user's role does not permit", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      const uid = await insertUser(db);
      await assignRole(rbac, uid, "reader", db);
      await assert.rejects(
        () => rbac.enforce(ctxFor(uid, db), "todos", "delete", todosCols),
        /Access denied on 'todos' for 'delete'/,
      );
    });

    it("denies resource that the user's role does not cover", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      const uid = await insertUser(db);
      await assignRole(rbac, uid, "reader", db);
      await assert.rejects(
        () => rbac.enforce(ctxFor(uid, db), "users", "read", todosCols),
        /Access denied on 'users'/,
      );
    });

    it("returns the rule's SQL when the role has a record rule for this (resource, action)", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: defineRecordRules({
          reader: { todos: { read: { domain: [["ownerId", "=", "current_user.id"]] } } },
        }),
      });
      const uid = await insertUser(db);
      await assignRole(rbac, uid, "reader", db);
      const out = await rbac.enforce(ctxFor(uid, db), "todos", "read", todosCols);
      assert.ok(out.where, "rule must produce a where");
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

    it("denies authenticated user with no role", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      const uid = await insertUser(db);
      // No role assigned — ctxFor returns role: null.
      await assert.rejects(
        () => rbac.enforce(ctxFor(uid, db), "todos", "read", todosCols),
        /Access denied on 'todos'/,
      );
    });

    it("works without ctx.batch (cache is optional)", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      const uid = await insertUser(db);
      await assignRole(rbac, uid, "reader", db);
      // Build ctx without batch — cache should be skipped silently.
      const ctx = { user: { id: uid, name: "u" }, role: { name: "reader", isAdmin: false } } as any;
      const out = await rbac.enforce(ctx, "todos", "read", todosCols);
      assert.deepEqual(out, {});
    });

    it("memoizes successful results in ctx.batch so repeated calls reuse them", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      const uid = await insertUser(db);
      await assignRole(rbac, uid, "reader", db);
      const ctx = ctxFor(uid, db);
      const first  = await rbac.enforce(ctx, "todos", "read", todosCols);
      const second = await rbac.enforce(ctx, "todos", "read", todosCols);
      assert.equal(first, second, "second call must return the same memoized object");
      assert.equal(ctx.batch!.size, 1, "exactly one cache entry written");
    });

    it("cache key isolates (resource, action) pairs for the same user", async () => {
      const { db } = freshDb();
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
      const uid = await insertUser(db);
      await assignRole(rbac, uid, "rw", db);
      const ctx = ctxFor(uid, db);

      const todosRead   = await rbac.enforce(ctx, "todos", "read",   todosCols);
      const todosUpdate = await rbac.enforce(ctx, "todos", "update", todosCols);
      const usersRead   = await rbac.enforce(ctx, "users", "read",   todosCols);

      assert.ok(todosRead.where, "todos:read has a record rule → where defined");
      assert.equal(todosUpdate.where, undefined, "todos:update has no record rule → unrestricted");
      assert.equal(usersRead.where,   undefined, "users:read  has no record rule → unrestricted");
      assert.equal(ctx.batch!.size, 3, "three distinct cache entries — one per (resource, action) tuple");
      assert.ok(ctx.batch!.has(`__rbac_enforce:${uid}:todos:read`));
      assert.ok(ctx.batch!.has(`__rbac_enforce:${uid}:todos:update`));
      assert.ok(ctx.batch!.has(`__rbac_enforce:${uid}:users:read`));
    });

    it("cache is per-user — two callers do not poach each other's memos", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {}, denied: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      const aid = await insertUser(db, "A");
      const bid = await insertUser(db, "B");
      await assignRole(rbac, aid, "reader", db);
      await assignRole(rbac, bid, "denied", db);

      const ctxA = ctxFor(aid, db);
      const ctxB = ctxFor(bid, db);
      const a = await rbac.enforce(ctxA, "todos", "read", todosCols);
      assert.deepEqual(a, {}, "reader → unrestricted allow");
      await assert.rejects(
        () => rbac.enforce(ctxB, "todos", "read", todosCols),
        /Access denied on 'todos' for 'read'/,
        "denied user must not see reader's cached allow",
      );
    });

    it("placeholder current_user.id is bound to ctx.user.id in the produced SQL", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: defineRecordRules({
          reader: { todos: { read: { domain: [["ownerId", "=", "current_user.id"]] } } },
        }),
      });
      const meId    = await insertUser(db, "Me");
      const otherId = await insertUser(db, "Other");
      await db.insert(todos).values([
        { title: "mine",   ownerId: meId    },
        { title: "theirs", ownerId: otherId },
      ]);
      await assignRole(rbac, meId,    "reader", db);
      await assignRole(rbac, otherId, "reader", db);

      const mine   = await rbac.enforce(ctxFor(meId,    db), "todos", "read", todosCols);
      const theirs = await rbac.enforce(ctxFor(otherId, db), "todos", "read", todosCols);
      const myRows    = await db.select().from(todos).where(mine.where!);
      const theirRows = await db.select().from(todos).where(theirs.where!);
      assert.deepEqual(myRows.map((r) => r.title),    ["mine"]);
      assert.deepEqual(theirRows.map((r) => r.title), ["theirs"]);
    });

    it("memoizes forbidden results so repeated calls throw without re-evaluating", async () => {
      const { db } = freshDb();
      const rbac = buildRbac({
        roles: defineRoles({ reader: {} }),
        accessRights: defineAccessRights({ reader: { todos: { read: true } } }),
        recordRules: {},
      });
      const uid = await insertUser(db);
      await assignRole(rbac, uid, "reader", db);
      const ctx = ctxFor(uid, db);
      await assert.rejects(() => rbac.enforce(ctx, "todos", "delete", todosCols), /Access denied/);
      // Subsequent calls return the same cached forbidden result.
      await assert.rejects(
        () => rbac.enforce(ctx, "todos", "delete", todosCols),
        /Access denied on 'todos' for 'delete'/,
      );
      // Exactly one cache entry — the deny.
      assert.equal(ctx.batch!.size, 1);
    });
  });
});
