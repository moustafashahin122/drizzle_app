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
} from "./graphql/rbac/config.js";

/**
 * Key of the framework-owned admin role. Apps must not redefine a role under
 * this key; see {@link mergeFrameworkRbac}. Exported so callers (admin tooling,
 * seed scripts, role-assignment endpoints) can avoid hard-coding the literal.
 */
export const ADMIN_ROLE = "admin" as const;

/**
 * The framework-owned roles. Currently just `admin` — `isAdmin: true` makes
 * it short-circuit every RBAC check, so it doesn't need any access-rights or
 * record-rule entries.
 */
export const FRAMEWORK_ROLES = {
  [ADMIN_ROLE]: { isAdmin: true },
} as const satisfies RolesConfig;

/**
 * Merge framework-owned RBAC entries into a user-supplied config. Throws if
 * the user has redefined a framework role key.
 */
export function mergeFrameworkRbac(user: RbacConfig): RbacConfig {
  for (const key of Object.keys(FRAMEWORK_ROLES)) {
    if (key in user.roles) {
      throw new Error(
        `rbac: role key '${key}' is reserved by the framework — it is assigned automatically and provides full-access bypass. Remove it from defineRoles({...}) in your app config.`,
      );
    }
  }
  return {
    roles: { ...FRAMEWORK_ROLES, ...user.roles },
    accessRights: { ...user.accessRights },
    recordRules: { ...user.recordRules },
  };
}
