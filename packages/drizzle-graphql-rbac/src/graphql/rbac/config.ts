/**
 * @module graphql/rbac/config
 *
 * Code-defined RBAC: roles, access rights, and record rules are declared in
 * three small TypeScript files in the host app. Everything is in-memory —
 * the engine builds its snapshot directly from these declarations at startup.
 *
 * Three identity helpers mirror the three concepts:
 *
 * - {@link defineRoles} — declare role keys with an optional `isAdmin`
 *   short-circuit. There is no inheritance — flatten your grants.
 * - {@link defineAccessRights} — per-role CRUD booleans on each resource.
 * - {@link defineRecordRules} — per-role row-level domains keyed by
 *   `(resource, action)`.
 *
 * {@link buildRbacConfig} validates and normalizes the bundle into flat lists
 * ready for the engine.
 */

export type Action = "create" | "read" | "update" | "delete";

/**
 * Subset of {@link Action} valid for record rules. `create` is intentionally
 * excluded — row-level filtering at insert time is not currently modeled
 * (will be re-added when post-insert verification lands).
 */
export type RecordRuleAction = "read" | "update" | "delete";

/** A single role's declarative metadata. The map key is the role key. */
export interface RoleDef {
  /** When `true`, members of this role bypass every RBAC check. */
  isAdmin?: boolean;
}

/** `{ roleKey: RoleDef }`. */
export type RolesConfig = Record<string, RoleDef>;

/** Per-resource CRUD grant entry. */
export interface ResourceAccessDef {
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
  domain: Domain;
}

/** `{ roleKey: { resource: { read?: RecordRuleDef, ... } } }`. */
export type RecordRulesConfig = Record<
  string,
  Record<string, Partial<Record<RecordRuleAction, RecordRuleDef>>>
>;

/** Bundle passed to the engine. */
export interface RbacConfig {
  roles: RolesConfig;
  accessRights: AccessRightsConfig;
  recordRules: RecordRulesConfig;
}

// ---------------------------------------------------------------------------
// Define helpers (identity functions that exist for IDE autocomplete).
// ---------------------------------------------------------------------------

/**
 * Declare role keys with optional `isAdmin` flag. Identity function whose
 * generic captures the literal keys for IDE autocomplete on access-rights
 * and record-rule lookups.
 *
 * @example
 * export const roles = defineRoles({
 *   manager: {},
 *   employee: {},
 * });
 */
export function defineRoles<TRoles extends RolesConfig>(roles: TRoles): TRoles {
  return roles;
}

/**
 * Declare per-role CRUD booleans on each resource. Identity function — its
 * generic captures the literal shape so the keys line up with `defineRoles`
 * output for IDE autocomplete.
 *
 * @example
 * export const accessRights = defineAccessRights({
 *   manager: {
 *     todos: { create: true, read: true, update: true, delete: true },
 *   },
 *   employee: {
 *     todos: { read: true, update: true },
 *   },
 * });
 */
export function defineAccessRights<TRights extends AccessRightsConfig>(rights: TRights): TRights {
  return rights;
}

/**
 * Declare per-`(role, resource, action)` row-level domains. Identity function
 * — preserves the literal shape so keys autocomplete against the roles config.
 *
 * @example
 * export const recordRules = defineRecordRules({
 *   employee: {
 *     todos: {
 *       read: { domain: [["assigneeId", "=", "current_user.id"]] },
 *       update: { domain: [["assigneeId", "=", "current_user.id"]] },
 *     },
 *   },
 * });
 */
export function defineRecordRules<TRules extends RecordRulesConfig>(rules: TRules): TRules {
  return rules;
}

const VALID_RECORD_RULE_ACTIONS: ReadonlySet<string> = new Set(["read", "update", "delete"]);

// ---------------------------------------------------------------------------
// Resolved (validated, flattened) shape.
// ---------------------------------------------------------------------------

export interface ResolvedRole {
  key: string;
  isAdmin: boolean;
}

export interface ResolvedAccessRight {
  roleKey: string;
  resource: string;
  canCreate: boolean;
  canRead: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface ResolvedRecordRule {
  roleKey: string;
  resource: string;
  action: RecordRuleAction;
  domain: Domain;
}

/** Flat, validated lists. */
export interface ResolvedRbacConfig {
  roles: ResolvedRole[];
  accessRights: ResolvedAccessRight[];
  recordRules: ResolvedRecordRule[];
}

/**
 * Validate the bundle and produce flat lists. Throws on:
 *
 * - empty roles config
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

  const seenRoleKeys = new Set<string>();
  const resolvedRoles: ResolvedRole[] = [];
  for (const key of roleKeys) {
    if (seenRoleKeys.has(key)) {
      throw new Error(`rbac: duplicate role key '${key}'.`);
    }
    seenRoleKeys.add(key);
    resolvedRoles.push({ key, isAdmin: !!roles[key]?.isAdmin });
  }

  const resolvedAR: ResolvedAccessRight[] = [];
  for (const [roleKey, byResource] of Object.entries(accessRights)) {
    if (!seenRoleKeys.has(roleKey)) {
      throw new Error(`rbac: accessRights references unknown role '${roleKey}'.`);
    }
    for (const [resource, def] of Object.entries(byResource)) {
      resolvedAR.push({
        roleKey,
        resource,
        canCreate: !!def.create,
        canRead: !!def.read,
        canUpdate: !!def.update,
        canDelete: !!def.delete,
      });
    }
  }

  const resolvedRR: ResolvedRecordRule[] = [];
  for (const [roleKey, byResource] of Object.entries(recordRules)) {
    if (!seenRoleKeys.has(roleKey)) {
      throw new Error(`rbac: recordRules references unknown role '${roleKey}'.`);
    }
    for (const [resource, perAction] of Object.entries(byResource)) {
      for (const [action, def] of Object.entries(perAction)) {
        if (action === "create") {
          throw new Error(
            `rbac: recordRules['${roleKey}']['${resource}'] uses action 'create', which is not currently supported — insert-time row filtering will be re-added later. Move the constraint to update/delete or remove it.`,
          );
        }
        if (!VALID_RECORD_RULE_ACTIONS.has(action)) {
          throw new Error(
            `rbac: recordRules['${roleKey}']['${resource}'] has unknown action '${action}'.`,
          );
        }
        if (!Array.isArray(def?.domain)) {
          throw new Error(
            `rbac: recordRules['${roleKey}']['${resource}']['${action}'].domain must be an array.`,
          );
        }
        resolvedRR.push({
          roleKey,
          resource,
          action: action as RecordRuleAction,
          domain: def!.domain,
        });
      }
    }
  }

  return { roles: resolvedRoles, accessRights: resolvedAR, recordRules: resolvedRR };
}
