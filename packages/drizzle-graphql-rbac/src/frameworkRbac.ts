/**
 * @module drizzle-graphql-rbac/frameworkRbac
 *
 * Built-in RBAC bits the framework owns. Today that's just the `admin` role:
 * every app needs a way to bootstrap a god-mode user, and that shouldn't be
 * the app developer's job to remember.
 *
 * `createApp` merges these into the user's `RbacConfig` automatically. If
 * you're using `buildRbac` directly (lower level), you're on the hook for
 * the merge — call {@link mergeFrameworkRbac} or include the constants
 * yourself.
 *
 * App authors should NOT define a role with key `"admin"` — `mergeFrameworkRbac`
 * throws on collision.
 */
import type {
  RbacConfig,
  RolesConfig,
  AccessRightsConfig,
  RecordRulesConfig,
} from "./graphql/rbac/config.js";

/**
 * The framework-owned roles. Currently just `admin` — `isAdmin: true` makes
 * it short-circuit every RBAC check, so it doesn't need any access-rights or
 * record-rule entries.
 */
export const FRAMEWORK_ROLES: RolesConfig = {
  admin: { isAdmin: true },
};

export const FRAMEWORK_ACCESS_RIGHTS: AccessRightsConfig = {};
export const FRAMEWORK_RECORD_RULES: RecordRulesConfig = {};

/**
 * Merge framework-owned RBAC entries into a user-supplied config. Throws if
 * the user has redefined a framework role key.
 */
export function mergeFrameworkRbac(user: RbacConfig): RbacConfig {
  for (const key of Object.keys(FRAMEWORK_ROLES)) {
    if (key in user.roles) {
      throw new Error(
        `rbac: role key '${key}' is reserved by the framework — drop it from your defineRoles({...}).`,
      );
    }
  }
  return {
    roles: { ...FRAMEWORK_ROLES, ...user.roles },
    accessRights: { ...FRAMEWORK_ACCESS_RIGHTS, ...user.accessRights },
    recordRules: { ...FRAMEWORK_RECORD_RULES, ...user.recordRules },
  };
}
