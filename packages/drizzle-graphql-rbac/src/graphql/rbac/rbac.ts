/**
 * @module graphql/rbac
 *
 * Odoo-style RBAC engine. Three concepts:
 *
 * - **Groups** (roles), with optional `parentGroupId` inheritance. Membership is
 *   transitive: being in a child group implies being in every ancestor group.
 *   A group flagged `isAdmin` short-circuits all checks for its members.
 * - **Access rights**: per-group CRUD booleans on a resource (the table's JS
 *   schema key, e.g. `"todos"`). Union across the user's effective groups.
 *   Deny-by-default if no group grants the action.
 * - **Record rules**: per-group row-level filters on a `(resource, permType)`
 *   pair, expressed as Odoo polish-prefix domains. Domains from groups granting
 *   the action are OR-combined and AND-ed into the resolver's `where`. The
 *   domain syntax and translator live in `../domain` — this engine only
 *   orchestrates parsing, placeholder injection, and combination.
 *
 * Placeholders: the engine injects `{ "current_user.id": ctx.user?.id ?? null }`
 * when evaluating each rule. Unauthenticated callers get `null`, which makes
 * `=`/`!=` against the placeholder produce no row matches — the safe default.
 */
import {
  and,
  eq,
  inArray,
  or,
  type SQL,
} from "drizzle-orm";
import { GraphQLError } from "graphql";
import type {
  groups as groupsTable,
  userGroups as userGroupsTable,
  accessRights as accessRightsTable,
  recordRules as recordRulesTable,
  User,
} from "../../tables.js";
import type { ColumnMap } from "../builder/filters.js";
import { parseDomain, domainToSql } from "../domain/domain.js";
import {
  RbacCache,
  type CachedGroups,
  type RbacCacheOptions,
} from "./cache.js";

export interface RbacSchema {
  groups: typeof groupsTable;
  userGroups: typeof userGroupsTable;
  accessRights: typeof accessRightsTable;
  recordRules: typeof recordRulesTable;
}

export interface RbacDb {
  select: (...args: any[]) => any;
}

export type Action = "create" | "read" | "update" | "delete";

export interface RbacContext {
  user: User | null;
  /** Per-request cache shared with the relation loader. */
  batch?: Map<string, unknown>;
}

const forbidden = (msg: string) =>
  new GraphQLError(msg, { extensions: { code: "FORBIDDEN" } });

const ACTION_TO_PERM: Record<Action, "canCreate" | "canRead" | "canUpdate" | "canDelete"> = {
  create: "canCreate",
  read: "canRead",
  update: "canUpdate",
  delete: "canDelete",
};

/**
 * Tunables for {@link buildRbac}'s cross-request cache. Aliased from
 * {@link RbacCacheOptions} in `./cache.js`; re-exported here so the public
 * RBAC surface is one import.
 */
export type BuildRbacOptions = RbacCacheOptions;

/**
 * Resolve the user's effective group set: direct memberships plus every
 * ancestor reachable through `parentGroupId`. BFS with a visited set so a
 * cycle (parent_group_id pointing back at a descendant) terminates instead of
 * looping forever — the PRD calls this out as a required mitigation.
 */
async function resolveEffectiveGroups(
  db: RbacDb,
  schema: RbacSchema,
  userId: number,
): Promise<CachedGroups> {
  const direct: { groupId: number }[] = await db
    .select({ groupId: schema.userGroups.groupId })
    .from(schema.userGroups)
    .where(eq(schema.userGroups.userId, userId));
  if (!direct.length) return { ids: [], isAdmin: false };

  const visited = new Set<number>();
  let frontier = direct.map((r) => r.groupId);
  let isAdmin = false;
  while (frontier.length) {
    const fresh = frontier.filter((id) => !visited.has(id));
    for (const id of fresh) visited.add(id);
    if (!fresh.length) break;
    const rows: { id: number; parentGroupId: number | null; isAdmin: boolean }[] = await db
      .select({
        id: schema.groups.id,
        parentGroupId: schema.groups.parentGroupId,
        isAdmin: schema.groups.isAdmin,
      })
      .from(schema.groups)
      .where(inArray(schema.groups.id, fresh));
    if (rows.some((r) => r.isAdmin)) isAdmin = true;
    frontier = rows
      .map((r) => r.parentGroupId)
      .filter((id): id is number => id != null);
  }
  return { ids: Array.from(visited), isAdmin };
}

async function getEffectiveGroups(
  db: RbacDb,
  schema: RbacSchema,
  ctx: RbacContext,
  cache: RbacCache<SQL>,
): Promise<CachedGroups> {
  if (!ctx.user) return { ids: [], isAdmin: false };
  const userId = ctx.user.id;
  const requestKey = `__rbac_groups:${userId}`;
  // Layer 1: per-request memo — cheapest, always coherent within a request.
  const cachedReq = ctx.batch?.get(requestKey) as CachedGroups | undefined;
  if (cachedReq) return cachedReq;
  // Layer 2: cross-request TTL+LRU cache — survives between requests, bounded.
  const cachedGlobal = cache.getGroups(userId);
  if (cachedGlobal) {
    ctx.batch?.set(requestKey, cachedGlobal);
    return cachedGlobal;
  }
  const out = await resolveEffectiveGroups(db, schema, userId);
  ctx.batch?.set(requestKey, out);
  cache.setGroups(userId, out);
  return out;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Hook passed to {@link buildSchema} as `options.rbac.enforce`. Throws
 * `FORBIDDEN` if the action is denied; otherwise returns an optional SQL
 * fragment to AND into the resolver's where (the union of matching record
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
 * Build the {@link RbacEnforce} hook bound to a Drizzle DB and the four RBAC
 * tables (`groups`, `userGroups`, `accessRights`, `recordRules`).
 *
 * The returned `enforce` function is the value passed to {@link buildSchema}'s
 * `options.rbac.enforce`. It performs three steps per call:
 *
 * 1. Resolve the caller's effective group set (direct + transitive via
 *    `parentGroupId`); admins short-circuit with no filter.
 * 2. Look up granting `accessRights` rows for `(resource, action)` across those
 *    groups. No granting row → `FORBIDDEN`.
 * 3. Collect `recordRules` for granting groups, parse each Odoo-style domain
 *    to SQL ({@link parseDomain} + {@link domainToSql}), AND rules within a
 *    group, OR across groups. A granting group with no rule means
 *    unrestricted access (returns `{}`).
 *
 * @param db Drizzle handle (any dialect; only `select()` is used).
 * @param schema The four RBAC tables, typically a slice of the project schema.
 * @returns `{ enforce }` — pass `enforce` to `buildSchema({ rbac: { enforce } })`.
 */
export function buildRbac(
  db: RbacDb,
  schema: RbacSchema,
  options: BuildRbacOptions = {},
): { enforce: RbacEnforce; invalidateUser: (userId: number) => void; clearCache: () => void } {
  const cache = new RbacCache<SQL>(options);

  const enforce: RbacEnforce = async (ctx, resource, action, columns) => {
    if (!ctx.user) throw forbidden("Not authenticated");
    const userId = ctx.user.id;

    // Layered cache for the full enforce result — depends only on (user,
    // resource, action) and the RBAC tables, so safe to share across requests
    // up to TTL. Layer 1: per-request memo (cheapest, perfectly coherent).
    // Layer 2: cross-request TTL+LRU cache (bounded; staleness up to TTL).
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

    const { ids, isAdmin } = await getEffectiveGroups(db, schema, ctx, cache);
    if (isAdmin) return memo({});
    if (!ids.length) denyAndThrow(`Access denied on '${resource}'`);

    const permCol = ACTION_TO_PERM[action];
    const granting: { groupId: number }[] = await db
      .select({ groupId: schema.accessRights.groupId })
      .from(schema.accessRights)
      .where(
        and(
          eq(schema.accessRights.resource, resource),
          inArray(schema.accessRights.groupId, ids),
          eq(schema.accessRights[permCol], true),
        ),
      );
    if (!granting.length) {
      denyAndThrow(`Access denied on '${resource}' for '${action}'`);
    }

    // Record rules: only those owned by groups that *also* grant the action
    // contribute. A group with read=true and no rule grants unrestricted read;
    // a group with read=true and a rule grants read filtered by that rule.
    // Effective filter is the OR of those per-group filters.
    const grantingIds = granting.map((g) => g.groupId);
    const rules: { groupId: number; domain: string }[] = await db
      .select({
        groupId: schema.recordRules.groupId,
        domain: schema.recordRules.domain,
      })
      .from(schema.recordRules)
      .where(
        and(
          eq(schema.recordRules.resource, resource),
          eq(schema.recordRules.permType, action),
          inArray(schema.recordRules.groupId, grantingIds),
        ),
      );
    if (!rules.length) return memo({});

    const rulesByGroup = new Map<number, SQL[]>();
    for (const r of rules) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.domain);
      } catch {
        throw new Error(`rbac: invalid JSON in record_rules.id (group ${r.groupId})`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`rbac: record rule domain must be a JSON array`);
      }
      const sql = domainToSql(parseDomain(parsed), columns, {
        "current_user.id": ctx.user?.id ?? null,
      });
      if (!sql) continue;
      let arr = rulesByGroup.get(r.groupId);
      if (!arr) rulesByGroup.set(r.groupId, (arr = []));
      arr.push(sql);
    }

    // A group with rules: AND its rules together (rules are *additional*
    // restrictions on that group's grant). Across groups: OR — being in any
    // qualifying group is enough.
    const groupsWithRules = new Set(rulesByGroup.keys());
    const groupsWithoutRules = grantingIds.filter((id) => !groupsWithRules.has(id));

    // If any granting group has no rule, that group grants unrestricted access
    // → no row filter needed.
    if (groupsWithoutRules.length) return memo({});

    const perGroup: SQL[] = [];
    for (const arr of rulesByGroup.values()) {
      perGroup.push(arr.length === 1 ? arr[0] : and(...arr)!);
    }
    if (!perGroup.length) return memo({});
    const combined = perGroup.length === 1 ? perGroup[0] : or(...perGroup)!;
    return memo({ where: combined });
  };

  return {
    enforce,
    /**
     * Drop every cached entry for a user — call after mutations that change
     * group membership, access rights, or record rules for that user, and on
     * sign-out so a re-login picks up any out-of-band changes immediately.
     */
    invalidateUser: (userId: number) => cache.invalidateUser(userId),
    /** Drop every cached RBAC entry process-wide. */
    clearCache: () => cache.clear(),
  };
}
