/**
 * @module graphql/rbac
 *
 * In-memory RBAC engine. Roles, access rights, record rules, **and**
 * user→role assignments all live in process memory — built synchronously
 * from the code config on startup, mutated at runtime via the engine's
 * membership API.
 *
 * - **Roles** declared via {@link defineRoles}. Each role may carry an
 *   optional `isAdmin` flag. There is no inheritance: each role's grants
 *   stand alone.
 * - **Access rights** declared via {@link defineAccessRights}: per-role CRUD
 *   booleans on a resource (the table's JS schema key, e.g. `"todos"`).
 *   The user's effective grant set is the union across every role they hold.
 *   Deny-by-default if no role grants the action.
 * - **Record rules** declared via {@link defineRecordRules}: per-role
 *   row-level filters keyed by `(resource, action)`, expressed as
 *   Odoo-style polish-prefix domains. Domains from roles granting the
 *   action are OR-combined and AND-ed into the resolver's `where`.
 *
 * Placeholders: the engine injects `{ "current_user.id": ctx.user?.id ?? null }`
 * when evaluating each rule. Unauthenticated callers get `null`, which makes
 * `=`/`!=` against the placeholder produce no row matches — the safe default.
 */
import { or, type SQL } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { User } from "../../tables.js";
import type { ColumnMap } from "../builder/filters.js";
import { parseDomain, domainToSql } from "../domain/domain.js";
import type { Action, RbacConfig } from "./config.js";
import { buildRbacConfig } from "./config.js";

export type { Action } from "./config.js";

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
  resolved.roles.forEach((r, i) => {
    rolesByKey.set(r.key, { id: i + 1, key: r.key, isAdmin: r.isAdmin });
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

  const rulesByRoleId = new Map<number, Map<string, Map<Action, unknown[]>>>();
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
    const roleIds: number[] = [];
    let isAdmin = false;
    for (const id of ids) {
      roleIds.push(id);
      // Look up by id — small N, linear scan is fine.
      for (const role of rolesByKey.values()) {
        if (role.id === id && role.isAdmin) {
          isAdmin = true;
          break;
        }
      }
    }
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

    const placeholders = { "current_user.id": ctx.user?.id ?? null };
    const perRole: SQL[] = [];
    let anyUnrestricted = false;
    for (const id of grantingRoleIds) {
      const domain = rulesByRoleId.get(id)?.get(resource)?.get(action);
      if (!domain) {
        anyUnrestricted = true;
        continue;
      }
      const parsed = parseDomain(domain);
      const sql = domainToSql(parsed, columns, placeholders);
      if (sql) perRole.push(sql);
      else anyUnrestricted = true;
    }
    if (anyUnrestricted) return memo({});
    if (!perRole.length) return memo({});
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
      for (const role of rolesByKey.values()) {
        if (ids.has(role.id)) keys.push(role.key);
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
  };
}
