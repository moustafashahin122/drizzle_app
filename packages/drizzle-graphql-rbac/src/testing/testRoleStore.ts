/**
 * @module testing/testRoleStore
 *
 * Test-only role assignment store. The runtime RBAC engine no longer
 * holds membership in memory — roles are persisted in the `roles` table and
 * a user's role is loaded from `users.role_id` per request. To keep test
 * bodies terse, we provide an out-of-band store keyed by the `BuiltRbac`
 * instance: `assignRoleForTests` records `(userId → role)`, `ctxForTest`
 * builds a request-shaped ctx that reads from it, and
 * `clearAllRbacMemberships` (re-exported from `transactionCase`) wipes the
 * map at the suite boundary.
 *
 * Nothing here is consulted by production code. The store exists purely so
 * tests do not have to insert a `users` row + a `roles` row + an FK update
 * just to verify that an enforce path branches correctly.
 */
import type { BuiltRbac, ResolvedUserRole, RbacContext } from "../graphql/rbac/rbac.js";

const ROLE_STORE = new WeakMap<BuiltRbac, Map<number, ResolvedUserRole>>();
let nextSyntheticRoleId = 1_000;

function storeFor(rbac: BuiltRbac): Map<number, ResolvedUserRole> {
  let s = ROLE_STORE.get(rbac);
  if (!s) ROLE_STORE.set(rbac, (s = new Map()));
  return s;
}

/** Record an in-memory role assignment used by `ctxForTest` when building a ctx. */
export function assignRoleForTests(rbac: BuiltRbac, userId: number, roleName: string): void {
  const role = rbac.findRole(roleName);
  if (!role) throw new Error(`rbac: unknown role '${roleName}'`);
  storeFor(rbac).set(userId, {
    id: nextSyntheticRoleId++,
    name: role.key,
    isAdmin: role.isAdmin,
  });
}

/** Remove the recorded role assignment for a user. */
export function revokeRoleForTests(rbac: BuiltRbac, userId: number): void {
  storeFor(rbac).delete(userId);
}

/** The role name currently assigned in the test store, or `null`. */
export function userRoleNameForTests(rbac: BuiltRbac, userId: number): string | null {
  return storeFor(rbac).get(userId)?.name ?? null;
}

/** Drop every recorded test role assignment for this rbac instance. */
export function clearTestRoleAssignments(rbac: BuiltRbac): void {
  storeFor(rbac).clear();
}

/**
 * Build an authenticated test ctx whose `role` is looked up from the store
 * for the given `rbac`. Returns `null` role when the user has no recorded
 * assignment — matching production behaviour for users with no `role_id`.
 */
export function ctxForTest(rbac: BuiltRbac, userId: number, userName = "u"): RbacContext {
  return {
    user: { id: userId, name: userName } as any,
    role: storeFor(rbac).get(userId) ?? null,
    batch: new Map<string, unknown>(),
  };
}
