/**
 * @module graphql/rbac/config
 *
 * Code-defined RBAC: roles, access rights, and record rules are declared in
 * three small TypeScript files in the host app. The DB has matching tables
 * (`roles`, `access_rights`, `record_rules`) which are *synced* from these
 * code declarations on each app start — the code is the source of truth, and
 * each entry carries an explicit `xid` ("external id") that anchors its
 * identity across rebuilds. See `./sync.ts`.
 *
 * Three identity helpers mirror the three concepts:
 *
 * - {@link defineRoles} — declare role keys with an `xid` and optional
 *   `isAdmin` short-circuit. (Inheritance was removed — flatten your grants.)
 * - {@link defineAccessRights} — per-role CRUD booleans on each resource,
 *   each entry carrying its own `xid`.
 * - {@link defineRecordRules} — per-role row-level domains keyed by
 *   `(resource, action)`, each entry carrying its own `xid`.
 *
 * {@link buildRbacConfig} validates and normalizes the bundle into flat
 * lists ready for the sync routine and the runtime engine.
 *
 * @example
 * // src/roles.ts
 * import { defineRoles } from "drizzle-graphql-rbac";
 * export const roles = defineRoles({
 *   admin: { xid: "app.role.admin", isAdmin: true },
 *   demo:  { xid: "app.role.demo" },
 * });
 *
 * // src/accessRights.ts
 * import { defineAccessRights } from "drizzle-graphql-rbac";
 * export const accessRights = defineAccessRights({
 *   demo: {
 *     todos: { xid: "app.ar.demo.todos", read: true, create: true, update: true, delete: true },
 *   },
 * });
 *
 * // src/recordRules.ts
 * import { defineRecordRules } from "drizzle-graphql-rbac";
 * const own = [["assigneeId", "=", "current_user.id"]];
 * export const recordRules = defineRecordRules({
 *   demo: {
 *     todos: {
 *       read:   { xid: "app.rr.demo.todos.read",   domain: own },
 *       update: { xid: "app.rr.demo.todos.update", domain: own },
 *       delete: { xid: "app.rr.demo.todos.delete", domain: own },
 *     },
 *   },
 * });
 */

export type Action = "create" | "read" | "update" | "delete";

/** A single role's declarative metadata. The map key is the role key. */
export interface RoleDef {
  /** External id — stable identity across rebuilds. Required. */
  xid: string;
  /** When `true`, members of this role bypass every RBAC check. */
  isAdmin?: boolean;
}

/** `{ roleKey: RoleDef }`. */
export type RolesConfig = Record<string, RoleDef>;

/** Per-resource CRUD grant entry. */
export interface ResourceAccessDef {
  xid: string;
  create?: boolean;
  read?: boolean;
  update?: boolean;
  delete?: boolean;
}

/** `{ roleKey: { resource: ResourceAccessDef } }`. */
export type AccessRightsConfig = Record<string, Record<string, ResourceAccessDef>>;

/** A domain is the same Odoo-style polish-prefix array consumed elsewhere. */
export type Domain = unknown[];

/** Per-(resource, action) record-rule entry. */
export interface RecordRuleDef {
  xid: string;
  domain: Domain;
}

/** `{ roleKey: { resource: { read?: RecordRuleDef, ... } } }`. */
export type RecordRulesConfig = Record<
  string,
  Record<string, Partial<Record<Action, RecordRuleDef>>>
>;

/** Bundle passed to the sync routine and the engine. */
export interface RbacConfig {
  roles: RolesConfig;
  accessRights: AccessRightsConfig;
  recordRules: RecordRulesConfig;
}

// ---------------------------------------------------------------------------
// Define helpers (identity functions that exist for IDE autocomplete).
// ---------------------------------------------------------------------------

export function defineRoles<T extends RolesConfig>(roles: T): T {
  return roles;
}

export function defineAccessRights<T extends AccessRightsConfig>(rights: T): T {
  return rights;
}

export function defineRecordRules<T extends RecordRulesConfig>(rules: T): T {
  return rules;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set(["create", "read", "update", "delete"]);

// ---------------------------------------------------------------------------
// Resolved (validated, flattened) shape.
// ---------------------------------------------------------------------------

export interface ResolvedRole {
  xid: string;
  key: string;
  isAdmin: boolean;
}

export interface ResolvedAccessRight {
  xid: string;
  roleKey: string;
  resource: string;
  canCreate: boolean;
  canRead: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface ResolvedRecordRule {
  xid: string;
  roleKey: string;
  resource: string;
  action: Action;
  domain: Domain;
}

/**
 * Flat, validated lists ready for the sync routine. Order is preserved from
 * the input map iteration order (insertion order in modern JS).
 */
export interface ResolvedRbacConfig {
  roles: ResolvedRole[];
  accessRights: ResolvedAccessRight[];
  recordRules: ResolvedRecordRule[];
}

/**
 * Validate the bundle and produce flat lists. Throws on:
 *
 * - empty roles config
 * - missing `xid` anywhere
 * - duplicate xids (across roles, AR, RR — each set must be globally unique)
 * - duplicate role keys
 * - rights/rules referencing an unknown role
 * - unknown action keys in record rules
 * - non-array domains
 */
export function buildRbacConfig(cfg: RbacConfig): ResolvedRbacConfig {
  const { roles, accessRights, recordRules } = cfg;

  const roleKeys = Object.keys(roles);
  if (!roleKeys.length) {
    throw new Error("rbac: roles config is empty — define at least one role.");
  }

  const seenRoleXids = new Set<string>();
  const seenRoleKeys = new Set<string>();
  const resolvedRoles: ResolvedRole[] = [];
  for (const key of roleKeys) {
    const def = roles[key];
    if (!def?.xid || typeof def.xid !== "string") {
      throw new Error(`rbac: role '${key}' is missing a string 'xid'.`);
    }
    if (seenRoleXids.has(def.xid)) {
      throw new Error(`rbac: duplicate role xid '${def.xid}'.`);
    }
    if (seenRoleKeys.has(key)) {
      throw new Error(`rbac: duplicate role key '${key}'.`);
    }
    seenRoleXids.add(def.xid);
    seenRoleKeys.add(key);
    resolvedRoles.push({ xid: def.xid, key, isAdmin: !!def.isAdmin });
  }

  const seenArXids = new Set<string>();
  const resolvedAR: ResolvedAccessRight[] = [];
  for (const [roleKey, byResource] of Object.entries(accessRights)) {
    if (!seenRoleKeys.has(roleKey)) {
      throw new Error(`rbac: accessRights references unknown role '${roleKey}'.`);
    }
    for (const [resource, def] of Object.entries(byResource)) {
      if (!def?.xid || typeof def.xid !== "string") {
        throw new Error(
          `rbac: accessRights['${roleKey}']['${resource}'] is missing a string 'xid'.`,
        );
      }
      if (seenArXids.has(def.xid)) {
        throw new Error(`rbac: duplicate accessRight xid '${def.xid}'.`);
      }
      seenArXids.add(def.xid);
      resolvedAR.push({
        xid: def.xid,
        roleKey,
        resource,
        canCreate: !!def.create,
        canRead: !!def.read,
        canUpdate: !!def.update,
        canDelete: !!def.delete,
      });
    }
  }

  const seenRrXids = new Set<string>();
  const resolvedRR: ResolvedRecordRule[] = [];
  for (const [roleKey, byResource] of Object.entries(recordRules)) {
    if (!seenRoleKeys.has(roleKey)) {
      throw new Error(`rbac: recordRules references unknown role '${roleKey}'.`);
    }
    for (const [resource, perAction] of Object.entries(byResource)) {
      for (const [action, def] of Object.entries(perAction)) {
        if (!VALID_ACTIONS.has(action)) {
          throw new Error(
            `rbac: recordRules['${roleKey}']['${resource}'] has unknown action '${action}'.`,
          );
        }
        if (!def?.xid || typeof def.xid !== "string") {
          throw new Error(
            `rbac: recordRules['${roleKey}']['${resource}']['${action}'] is missing a string 'xid'.`,
          );
        }
        if (!Array.isArray(def.domain)) {
          throw new Error(
            `rbac: recordRules['${roleKey}']['${resource}']['${action}'].domain must be an array.`,
          );
        }
        if (seenRrXids.has(def.xid)) {
          throw new Error(`rbac: duplicate recordRule xid '${def.xid}'.`);
        }
        seenRrXids.add(def.xid);
        resolvedRR.push({
          xid: def.xid,
          roleKey,
          resource,
          action: action as Action,
          domain: def.domain,
        });
      }
    }
  }

  return { roles: resolvedRoles, accessRights: resolvedAR, recordRules: resolvedRR };
}
