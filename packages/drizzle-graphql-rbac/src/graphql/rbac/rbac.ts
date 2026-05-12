/**
 * @module graphql/rbac
 *
 * Pure RBAC engine. The role registry (names + `isAdmin`), access-rights
 * grants, and record-rule domains are built once from the in-code config at
 * startup; they are read-only thereafter.
 *
 * The engine itself does not consult the database — `enforce(ctx, ...)` reads
 * the request's pre-resolved role from `ctx.role`. Loading that role from
 * `users.role_id` is the framework plumbing's job (`sessionMiddleware` does it
 * once per request, via `getUserRole`). DB-side reconciliation of role rows
 * happens in {@link syncRoles} from `./persistence.ts`, called at server
 * startup.
 *
 * One role per user. No inheritance, no role unions: a user is granted the
 * union of their single role's access rights and record rules. Admin roles
 * (`isAdmin: true`) short-circuit every check.
 */
import { type SQL } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { User } from "../../tables.js";
import type { ColumnMap } from "../builder/filters.js";
import { parseDomain, domainToSql } from "../domain/domain.js";
import type { Action, RecordRuleAction, RbacConfig, ResolvedRole } from "./config.js";
import { buildRbacConfig } from "./config.js";

export type { Action, RecordRuleAction } from "./config.js";

/**
 * The pre-resolved role for the current request. The framework's
 * `sessionMiddleware` loads this once per request (`getUserRole(db, ...)`)
 * and stashes it on the GraphQL/HTTP context; the engine reads it directly.
 *
 * `null` means the user is roleless (or anonymous) — RBAC denies everything.
 */
export interface ResolvedUserRole {
  /** Role name (`roles.name`, matches the in-code `defineRoles` key). */
  name: string;
  isAdmin: boolean;
}

export interface RbacContext {
  user: User | null;
  /**
   * Pre-resolved role for `ctx.user`, or `null` when roleless. Optional in
   * the type signature for the convenience of test helpers (a missing role
   * is treated identically to an explicit `null` by the engine), but
   * production call sites should always pass an explicit value resolved by
   * `sessionMiddleware`.
   */
  role?: ResolvedUserRole | null;
  /** Per-request cache shared with the relation loader. */
  batch?: Map<string, unknown>;
}

const forbidden = (msg: string) =>
  new GraphQLError(msg, { extensions: { code: "FORBIDDEN" } });

/**
 * Get the value at `key`, or insert and return a freshly-built one. Lets
 * the index-building loops below stay one-line per level without the
 * `let v = m.get(k); if (!v) m.set(k, v = ...)` ceremony.
 */
function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) map.set(key, v = make());
  return v;
}

/**
 * Hook passed to {@link buildSchema} as `options.rbac.enforce`. Throws
 * `FORBIDDEN` if the action is denied; otherwise returns an optional SQL
 * fragment to AND into the resolver's where (the matching record rule's
 * domain, if any).
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
 * Result of {@link buildRbac}. The engine is now read-only — runtime
 * membership mutations are DB writes performed through `setUserRole` from
 * `./persistence.ts`, not engine calls.
 */
export interface BuiltRbac {
  /** The `enforce` hook to pass to `buildSchema` and `buildRbacDb`. */
  enforce: RbacEnforce;
  /** Every role declared in the in-code config (sorted by name). */
  roles(): ReadonlyArray<ResolvedRole>;
  /** Resolve a role by name from the in-code snapshot, or `null`. */
  findRole(name: string): ResolvedRole | null;
}

interface RoleEntry {
  key: string;
  isAdmin: boolean;
}

/**
 * Build the {@link RbacEnforce} hook from the in-code role config. Roles,
 * access rights, and record rules are indexed once; the result is read-only.
 */
export function buildRbac(config: RbacConfig): BuiltRbac {
  const resolved = buildRbacConfig(config);

  // ---- Indexed snapshot (read-only) ---------------------------------------

  const rolesByKey = new Map<string, RoleEntry>();
  for (const r of resolved.roles) {
    rolesByKey.set(r.key, { key: r.key, isAdmin: r.isAdmin });
  }

  const accessByRoleKey = new Map<string, Map<string, Set<Action>>>();
  for (const a of resolved.accessRights) {
    if (!rolesByKey.has(a.roleKey)) continue;
    const perResource = getOrCreate(accessByRoleKey, a.roleKey, () => new Map());
    const actions = getOrCreate(perResource, a.resource, () => new Set());
    if (a.canCreate) actions.add("create");
    if (a.canRead) actions.add("read");
    if (a.canUpdate) actions.add("update");
    if (a.canDelete) actions.add("delete");
  }

  const rulesByRoleKey = new Map<string, Map<string, Map<RecordRuleAction, unknown[]>>>();
  for (const r of resolved.recordRules) {
    if (!rolesByKey.has(r.roleKey)) continue;
    const perResource = getOrCreate(rulesByRoleKey, r.roleKey, () => new Map());
    const perAction = getOrCreate(perResource, r.resource, () => new Map());
    perAction.set(r.action, r.domain);
  }

  // ---- enforce ------------------------------------------------------------

  const enforce: RbacEnforce = async (ctx, resource, action, columns) => {
    if (!ctx.user) throw forbidden("Not authenticated");
    const userId = ctx.user.id;
    const role = ctx.role ?? null;

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
    // `function` declaration (not an arrow) so TS narrows on `: never`
    // returns at call sites — that's what lets the role/grants checks below
    // be expressed as a single `if`.
    function denyAndThrow(msg: string): never {
      ctx.batch?.set(requestKey, { __forbidden: msg });
      throw forbidden(msg);
    }

    if (!role) denyAndThrow(`Access denied on '${resource}'`);

    if (role.isAdmin) return memo({});

    const grants = accessByRoleKey.get(role.name)?.get(resource);
    if (!grants?.has(action)) {
      denyAndThrow(`Access denied on '${resource}' for '${action}'`);
    }

    // Record rules currently cover read/update/delete only — `create` has no
    // row-level filter.
    if (action === "create") return memo({});

    const domain = rulesByRoleKey.get(role.name)?.get(resource)?.get(action);
    // No domain for this (role, resource, action) → unrestricted allow.
    if (!domain) return memo({});
    const sql = domainToSql(parseDomain(domain), columns, {
      "current_user.id": userId,
    });
    // Empty/trivial domain compiles to no SQL — also unrestricted.
    if (!sql) return memo({});
    return memo({ where: sql });
  };

  // ---- Read-only registry API --------------------------------------------

  return {
    enforce,
    roles: () => resolved.roles,
    findRole: (name: string) => resolved.roles.find((r) => r.key === name) ?? null,
  };
}
