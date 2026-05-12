/**
 * Well-known demo user emails and their intended roles.
 *
 * Run `npm run seed:demo` to upsert these users into the DB and bind them
 * to the right role via `users.role_id`. Roles themselves are persisted by
 * the framework's startup `syncRoles` pass; this map only assigns existing
 * roles to existing users.
 */
export const DEMO_ADMIN_EMAIL = "demo_admin@example.com";
export const DEMO_MANAGER_EMAIL = "demo_manager@example.com";
export const DEMO_USER_EMAIL = "demo_user@example.com";

export const DEMO_ROLES: Record<string, string> = {
  [DEMO_ADMIN_EMAIL]: "admin",
  [DEMO_MANAGER_EMAIL]: "manager",
  [DEMO_USER_EMAIL]: "demo",
};
