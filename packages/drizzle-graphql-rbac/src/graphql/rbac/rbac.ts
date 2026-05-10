/**
 * @module graphql/rbac
 *
 * RBAC engine. Reads from a code-defined config that has been *synced* to
 * matching DB tables (`roles`, `access_rights`, `record_rules`); the engine
 * itself consults an in-memory snapshot of those tables, refreshed when
 * the sync routine completes.
 *
 * - **Roles** declared via {@link defineRoles}. Each role carries an `xid`
 *   and an optional `isAdmin` flag. There is no inheritance: each role's
 *   grants stand alone.
 * - **Access rights** declared via {@link defineAccessRights}: per-role CRUD
 *   booleans on a resource (the table's JS schema key, e.g. `"todos"`).
 *   The user's effective grant set is the union across every role they hold.
 *   Deny-by-default if no role grants the action.
 * - **Record rules** declared via {@link defineRecordRules}: per-role
 *   row-level filters keyed by `(resource, action)`, expressed as
 *   Odoo-style polish-prefix domains. Domains from roles granting the
 *   action are OR-combined and AND-ed into the resolver's `where`.
 *
 * Only the user → role mapping (`userRoles` table) is written at runtime.
 * The admin dashboard manages assignments; everything else is a code change
 * + restart (the sync routine reconciles the DB to the code on next start).
 *
 * Placeholders: the engine injects `{ "current_user.id": ctx.user?.id ?? null }`
 * when evaluating each rule. Unauthenticated callers get `null`, which makes
 * `=`/`!=` against the placeholder produce no row matches — the safe default.
 */
import { eq, or, type SQL } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type {
  roles as rolesTable,
  accessRights as accessRightsTable,
  recordRules as recordRulesTable,
  userRoles as userRolesTable,
  User,
} from "../../tables.js";
import type { ColumnMap } from "../builder/filters.js";
import { parseDomain, domainToSql } from "../domain/domain.js";
import {
  RbacCache,
  type CachedRoles,
  type RbacCacheOptions,
} from "./cache.js";
import type { Action, RbacConfig } from "./config.js";
import { buildRbacConfig } from "./config.js";
import {
  emptySnapshot,
  loadRbacSnapshot,
  syncRbacFromCode,
  type RbacSnapshot,
  type SyncResult,
} from "./sync.js";

export type { Action } from "./config.js";

/**
 * Tables the engine reads. Apps re-export these from their schema module via
 * `frameworkTables`.
 */
export interface RbacSchema {
  roles: typeof rolesTable;
  accessRights: typeof accessRightsTable;
  recordRules: typeof recordRulesTable;
  userRoles: typeof userRolesTable;
}

export interface RbacDb {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
}

export interface RbacContext {
  user: User | null;
  /** Per-request cache shared with the relation loader. */
  batch?: Map<string, unknown>;
}

const forbidden = (msg: string) =>
  new GraphQLError(msg, { extensions: { code: "FORBIDDEN" } });

export type BuildRbacOptions = RbacCacheOptions;

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
 * Result of {@link buildRbac}.
 */
export interface BuiltRbac {
  /** The `enforce` hook to pass to `buildSchema` and `buildRbacDb`. */
  enforce: RbacEnforce;
  /** Drop a single user's cached entries. */
  invalidateUser: (userId: number) => void;
  /** Drop every cached entry. */
  clearCache: () => void;
  /**
   * Run a sync against the DB, then refresh the engine's in-memory snapshot
   * and clear the cache. Call after creation if you need to be sure the
   * engine is in sync before serving traffic; otherwise let `createApp`
   * fire it for you in the background.
   */
  sync: () => Promise<SyncResult>;
  /** Re-read the snapshot from the DB (without running sync). */
  refreshSnapshot: () => Promise<void>;
  /** The current snapshot — exposed for tests / debugging. */
  getSnapshot: () => RbacSnapshot;
}

/**
 * Build the {@link RbacEnforce} hook bound to a Drizzle DB and the framework
 * tables. The engine starts with an empty snapshot (deny-all); call
 * {@link BuiltRbac.sync} (or let `createApp`'s background sync do it) to
 * reconcile the DB with the code config and load the snapshot.
 */
export function buildRbac(
  db: RbacDb,
  schema: RbacSchema,
  config: RbacConfig,
  options: BuildRbacOptions = {},
): BuiltRbac {
  const resolved = buildRbacConfig(config);
  const cache = new RbacCache<SQL>(options);
  let snapshot: RbacSnapshot = emptySnapshot();

  const userRolesTab = schema.userRoles;

  /**
   * Resolve the caller's effective role-id set straight from `user_roles`.
   * Roles whose row no longer exists in the snapshot are dropped (the FK
   * prevents stale ids in practice, but the snapshot may briefly lag).
   */
  const resolveRoles = async (userId: number): Promise<CachedRoles> => {
    const rows: { roleId: number }[] = await db
      .select({ roleId: userRolesTab.roleId })
      .from(userRolesTab)
      .where(eq(userRolesTab.userId, userId));
    const roleIds: number[] = [];
    let isAdmin = false;
    for (const { roleId } of rows) {
      const meta = snapshot.rolesById.get(roleId);
      if (!meta) continue;
      roleIds.push(roleId);
      if (meta.isAdmin) isAdmin = true;
    }
    return { roleIds, isAdmin };
  };

  const getRoles = async (ctx: RbacContext): Promise<CachedRoles> => {
    if (!ctx.user) return { roleIds: [], isAdmin: false };
    const userId = ctx.user.id;
    const requestKey = `__rbac_roles:${userId}`;
    const cachedReq = ctx.batch?.get(requestKey) as CachedRoles | undefined;
    if (cachedReq) return cachedReq;
    const cachedGlobal = cache.getRoles(userId);
    if (cachedGlobal) {
      ctx.batch?.set(requestKey, cachedGlobal);
      return cachedGlobal;
    }
    const out = await resolveRoles(userId);
    ctx.batch?.set(requestKey, out);
    cache.setRoles(userId, out);
    return out;
  };

  const enforce: RbacEnforce = async (ctx, resource, action, columns) => {
    if (!ctx.user) throw forbidden("Not authenticated");
    const userId = ctx.user.id;

    const requestKey = `__rbac_enforce:${userId}:${resource}:${action}`;
    const cachedReq = ctx.batch?.get(requestKey) as
      | { where?: SQL }
      | { __forbidden: string }
      | undefined;
    if (cachedReq) {
      if ("__forbidden" in cachedReq) throw forbidden(cachedReq.__forbidden);
      return cachedReq;
    }
    const cachedGlobal = cache.getEnforce(userId, resource, action);
    if (cachedGlobal) {
      ctx.batch?.set(requestKey, cachedGlobal);
      if ("__forbidden" in cachedGlobal) throw forbidden(cachedGlobal.__forbidden);
      return cachedGlobal;
    }

    const memo = (out: { where?: SQL }) => {
      ctx.batch?.set(requestKey, out);
      cache.setEnforce(userId, resource, action, out);
      return out;
    };
    const denyAndThrow = (msg: string): never => {
      const entry = { __forbidden: msg };
      ctx.batch?.set(requestKey, entry);
      cache.setEnforce(userId, resource, action, entry);
      throw forbidden(msg);
    };

    const { roleIds, isAdmin } = await getRoles(ctx);
    if (isAdmin) return memo({});
    if (!roleIds.length) denyAndThrow(`Access denied on '${resource}'`);

    // Roles whose access-rights row grants this (resource, action).
    const grantingRoleIds: number[] = [];
    for (const id of roleIds) {
      const perResource = snapshot.accessByRole.get(id);
      if (perResource?.get(resource)?.has(action)) grantingRoleIds.push(id);
    }
    if (!grantingRoleIds.length) {
      denyAndThrow(`Access denied on '${resource}' for '${action}'`);
    }

    // Record rules: only those owned by roles that *also* grant the action
    // contribute. A granting role with no rule means unrestricted access on
    // that role's grant; if any granting role is unrestricted, the effective
    // filter collapses to none.
    const placeholders = { "current_user.id": ctx.user?.id ?? null };
    const perRole: SQL[] = [];
    let anyUnrestricted = false;
    for (const id of grantingRoleIds) {
      const domain = snapshot.rulesByRole.get(id)?.get(resource)?.get(action);
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

  return {
    enforce,
    invalidateUser: (userId: number) => cache.invalidateUser(userId),
    clearCache: () => cache.clear(),
    sync: async () => {
      const result = await syncRbacFromCode(db, schema, resolved);
      snapshot = await loadRbacSnapshot(db, schema);
      cache.clear();
      return result;
    },
    refreshSnapshot: async () => {
      snapshot = await loadRbacSnapshot(db, schema);
      cache.clear();
    },
    getSnapshot: () => snapshot,
  };
}

