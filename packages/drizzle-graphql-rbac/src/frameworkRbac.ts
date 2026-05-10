/**
 * @module drizzle-graphql-rbac/frameworkRbac
 *
 * Built-in RBAC bits the framework owns. Today that's just the `admin`
 * role: every app needs a way to bootstrap a god-mode user, and that
 * shouldn't be the app developer's job to remember.
 *
 * `createApp` merges these into the user's `RbacConfig` automatically. If
 * you're using `buildRbac` directly (lower level), you're on the hook for
 * the merge — call {@link mergeFrameworkRbac} or include the constants
 * yourself.
 *
 * App authors should NOT define a role with key `"admin"` or with a xid
 * starting with `"dgr.role."` / `"dgr.ar."` / `"dgr.rr."` — `createApp`
 * throws on collision.
 */
import type {
  RbacConfig,
  RolesConfig,
  AccessRightsConfig,
  RecordRulesConfig,
} from "./graphql/rbac/config.js";

/** xid prefix reserved for framework-owned RBAC entries. */
export const FRAMEWORK_XID_PREFIX = "dgr.";

/**
 * The framework-owned roles. Currently just `admin` — `isAdmin: true` makes
 * it short-circuit every RBAC check, so it doesn't need any access-rights
 * or record-rule entries.
 */
export const FRAMEWORK_ROLES: RolesConfig = {
  admin: { xid: "dgr.role.admin", isAdmin: true },
};

export const FRAMEWORK_ACCESS_RIGHTS: AccessRightsConfig = {};
export const FRAMEWORK_RECORD_RULES: RecordRulesConfig = {};

/**
 * Merge framework-owned RBAC entries into a user-supplied config. Throws
 * if the user has redefined a framework role key or reused a framework xid.
 */
export function mergeFrameworkRbac(user: RbacConfig): RbacConfig {
  // Role key collision.
  for (const key of Object.keys(FRAMEWORK_ROLES)) {
    if (key in user.roles) {
      throw new Error(
        `rbac: role key '${key}' is reserved by the framework — drop it from your defineRoles({...}).`,
      );
    }
  }

  // xid collision (any framework prefix).
  const collide = (xid: string, where: string) => {
    if (xid.startsWith(FRAMEWORK_XID_PREFIX)) {
      throw new Error(
        `rbac: xid '${xid}' uses the reserved '${FRAMEWORK_XID_PREFIX}' prefix (in ${where}).`,
      );
    }
  };
  for (const [key, def] of Object.entries(user.roles)) collide(def.xid, `roles.${key}`);
  for (const [role, byRes] of Object.entries(user.accessRights)) {
    for (const [res, def] of Object.entries(byRes)) collide(def.xid, `accessRights.${role}.${res}`);
  }
  for (const [role, byRes] of Object.entries(user.recordRules)) {
    for (const [res, perAct] of Object.entries(byRes)) {
      for (const [act, def] of Object.entries(perAct)) {
        collide(def!.xid, `recordRules.${role}.${res}.${act}`);
      }
    }
  }

  return {
    roles: { ...FRAMEWORK_ROLES, ...user.roles },
    accessRights: { ...FRAMEWORK_ACCESS_RIGHTS, ...user.accessRights },
    recordRules: { ...FRAMEWORK_RECORD_RULES, ...user.recordRules },
  };
}
