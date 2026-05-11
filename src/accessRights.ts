/**
 * Per-role CRUD grants.
 *
 * Resources are the JS keys of Drizzle tables (e.g. `todos`, `users`); a
 * role with `read: true` on a resource may run any GraphQL `<resource>` /
 * `<resource>Single` query, plus any helper that calls `rbacDb.select()` on
 * that table. Mutations gate on `create` / `update` / `delete`.
 *
 * Roles that don't appear here grant nothing; admins (see `roles.ts`)
 * bypass this file entirely.
 */
import { defineAccessRights } from "drizzle-graphql-rbac";

export const accessRights = defineAccessRights({
  demo: {
    todos: { create: true, read: true, update: true, delete: true },
    projects: { create: true, read: true, update: true, delete: true },
  },
  manager: {
    todos: { create: true, read: true, update: true, delete: true },
    projects: { create: true, read: true, update: true, delete: true },
  },
});
