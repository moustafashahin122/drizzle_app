/**
 * @module graphql/rbac
 *
 * In-memory RBAC engine. Roles, access rights, record rules, and user→role
 * assignments all live in the engine closure (not persisted). `assignRole`
 * and `revokeRole` are synchronous and only thread-safe under Node's
 * single-threaded event loop — do not share an engine across worker threads.
 * On process restart, memberships are lost; the app is responsible for
 * reseeding well-known accounts. The framework's `admin` role is merged in
 * automatically via `mergeFrameworkRbac`; apps must not redefine it.
 *
 * Roles are declared via {@link defineRoles} (no inheritance). Access rights
 * (per-role CRUD on a resource) and record rules (per-role row-level Odoo
 * domains for `(resource, action)`) compose by union; deny-by-default. The
 * engine injects `{ "current_user.id": ctx.user?.id ?? null }` into domains.
 */
import { or, type SQL } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { User } from "../../tables.js";
import type { ColumnMap } from "../builder/filters.js";
import { parseDomain, domainToSql } from "../domain/domain.js";
import type { Action, RecordRuleAction, RbacConfig } from "./config.js";
import { buildRbacConfig } from "./config.js";

export type { Action, RecordRuleAction } from "./config.js";

export interface RbacContext {
  user: User | null;
  /** Per-request cache shared with the relation loader. */
  batch?: Map<string, unknown>;
}

const forbidden = (msg: string) =>
  new GraphQLError(msg, { extensions: { code: "FORBIDDEN" } });

/**
 * Hook passed to {@link buildSchema} as `options.rbac.enforce`. Throws
 * `FORBIDDEN` if the action is denied; otherwise returns an optional SQL
 * fragment to AND into the resolver's where (the OR of matching record
 * rules' domains).
 *
 * Admins bypass entirely — they get `{ where: undefined }` and never throw.
 */
export interface RbacEnforce {
  (
    ctx: RbacContext,
    resource: string,
    action: Action,
    columns: ColumnMap,
  ): Promise<{ where?: SQL }>;
}

/**
 * Result of {@link buildRbac}. Membership lives in the engine — the admin
 * sub-app calls these methods to add and remove roles at runtime.
 */
export interface BuiltRbac {
  /** The `enforce` hook to pass to `buildSchema` and `buildRbacDb`. */
  enforce: RbacEnforce;
  /** Every role key known to the engine, sorted. */
  listRoleKeys(): string[];
  /** Roles the user currently holds, sorted by key. Returns `[]` for unknown users. */
  listUserRoles(userId: number): string[];
  /** Add a user to a role. Throws if `roleKey` isn't defined in the config. Returns true if the assignment is new. */
  assignRole(userId: number, roleKey: string): boolean;
  /** Remove a user from a role. Returns true if a row was removed. */
  revokeRole(userId: number, roleKey: string): boolean;
  /** True iff the engine knows about `roleKey`. */
  hasRole(roleKey: string): boolean;
  /** True iff the user currently holds any role whose `isAdmin` flag is set. */
  isAdmin(userId: number): boolean;
  /** Drop every in-memory user→role assignment. Intended for test resets. */
  clearAllMemberships(): void;
}

interface RoleEntry {
  id: number;
  key: string;
  isAdmin: boolean;
}

/**
 * Build the {@link RbacEnforce} hook and membership API from the resolved
 * code config. Everything is in-memory; there is no DB-side state.
 */
export function buildRbac(config: RbacConfig): BuiltRbac {
  const resolved = buildRbacConfig(config);

  // ---- Snapshot built once, synchronously ---------------------------------

  const rolesByKey = new Map<string, RoleEntry>();
  const roleById = new Map<number, RoleEntry>();
  resolved.roles.forEach((r, i) => {
    const entry: RoleEntry = { id: i + 1, key: r.key, isAdmin: r.isAdmin };
    rolesByKey.set(r.key, entry);
    roleById.set(entry.id, entry);
  });

  const accessByRoleId = new Map<number, Map<string, Set<Action>>>();
  for (const a of resolved.accessRights) {
    const role = rolesByKey.get(a.roleKey);
    if (!role) continue;
    let perResource = accessByRoleId.get(role.id);
    if (!perResource) accessByRoleId.set(role.id, (perResource = new Map()));
    let actions = perResource.get(a.resource);
    if (!actions) perResource.set(a.resource, (actions = new Set()));
    if (a.canCreate) actions.add("create");
    if (a.canRead) actions.add("read");
    if (a.canUpdate) actions.add("update");
    if (a.canDelete) actions.add("delete");
  }

  const rulesByRoleId = new Map<number, Map<string, Map<RecordRuleAction, unknown[]>>>();
  for (const r of resolved.recordRules) {
    const role = rolesByKey.get(r.roleKey);
    if (!role) continue;
    let perResource = rulesByRoleId.get(role.id);
    if (!perResource) rulesByRoleId.set(role.id, (perResource = new Map()));
    let perAction = perResource.get(r.resource);
    if (!perAction) perResource.set(r.resource, (perAction = new Map()));
    perAction.set(r.action, r.domain);
  }

  // ---- Membership (in-memory, mutated at runtime) -------------------------

  const userRoles = new Map<number, Set<number>>();

  const rolesForUser = (userId: number): { roleIds: number[]; isAdmin: boolean } => {
    const ids = userRoles.get(userId);
    if (!ids?.size) return { roleIds: [], isAdmin: false };
    const roleIds = Array.from(ids);
    const isAdmin = roleIds.some((id) => roleById.get(id)?.isAdmin === true);
    return { roleIds, isAdmin };
  };

  // ---- enforce ------------------------------------------------------------

  const enforce: RbacEnforce = async (ctx, resource, action, columns) => {
    if (!ctx.user) throw forbidden("Not authenticated");
    const userId = ctx.user.id;

    const requestKey = `__rbac_enforce:${userId}:${resource}:${action}`;
    const cached = ctx.batch?.get(requestKey) as
      | { where?: SQL }
      | { __forbidden: string }
      | undefined;
    if (cached) {
      if ("__forbidden" in cached) throw forbidden(cached.__forbidden);
      return cached;
    }

    const memo = (out: { where?: SQL }) => {
      ctx.batch?.set(requestKey, out);
      return out;
    };
    const denyAndThrow = (msg: string): never => {
      ctx.batch?.set(requestKey, { __forbidden: msg });
      throw forbidden(msg);
    };

    const { roleIds, isAdmin } = rolesForUser(userId);
    if (isAdmin) return memo({});
    if (!roleIds.length) denyAndThrow(`Access denied on '${resource}'`);

    const grantingRoleIds: number[] = [];
    for (const id of roleIds) {
      if (accessByRoleId.get(id)?.get(resource)?.has(action)) grantingRoleIds.push(id);
    }
    if (!grantingRoleIds.length) {
      denyAndThrow(`Access denied on '${resource}' for '${action}'`);
    }

    // Record rules currently cover read/update/delete only — `create` has no
    // row-level filter. Short-circuit here so the lookup map can be typed
    // against the narrower `RecordRuleAction`.
    if (action === "create") return memo({});

    const placeholders = { "current_user.id": userId };
    const perRole: SQL[] = [];
    for (const id of grantingRoleIds) {
      const domain = rulesByRoleId.get(id)?.get(resource)?.get(action);
      // No domain for this (role, resource, action) → unrestricted allow.
      if (!domain) return memo({});
      const sql = domainToSql(parseDomain(domain), columns, placeholders);
      // Empty/trivial domain compiles to no SQL — also unrestricted.
      if (!sql) return memo({});
      perRole.push(sql);
    }
    const combined = perRole.length === 1 ? perRole[0] : or(...perRole)!;
    return memo({ where: combined });
  };

  // ---- Membership API -----------------------------------------------------

  return {
    enforce,
    listRoleKeys: () =>
      Array.from(rolesByKey.keys()).sort(),
    listUserRoles: (userId: number) => {
      const ids = userRoles.get(userId);
      if (!ids?.size) return [];
      const keys: string[] = [];
      for (const id of ids) {
        const role = roleById.get(id);
        if (role) keys.push(role.key);
      }
      return keys.sort();
    },
    assignRole: (userId: number, roleKey: string) => {
      const role = rolesByKey.get(roleKey);
      if (!role) throw new Error(`rbac: unknown role '${roleKey}'`);
      let set = userRoles.get(userId);
      if (!set) userRoles.set(userId, (set = new Set()));
      if (set.has(role.id)) return false;
      set.add(role.id);
      return true;
    },
    revokeRole: (userId: number, roleKey: string) => {
      const role = rolesByKey.get(roleKey);
      if (!role) throw new Error(`rbac: unknown role '${roleKey}'`);
      const set = userRoles.get(userId);
      if (!set?.has(role.id)) return false;
      set.delete(role.id);
      if (!set.size) userRoles.delete(userId);
      return true;
    },
    hasRole: (roleKey: string) => rolesByKey.has(roleKey),
    isAdmin: (userId: number) => rolesForUser(userId).isAdmin,
    clearAllMemberships: () => userRoles.clear(),
  };
}
