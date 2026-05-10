/**
 * @module drizzle-graphql-rbac/tables
 *
 * The Drizzle table definitions the framework owns:
 *
 * - **Identity** — `users`, `sessions`.
 * - **RBAC config tables** — `roles`, `accessRights`, `recordRules`. These
 *   are *synced from code* on each app start (see `syncRbacFromCode`); the
 *   code is the source of truth, the DB rows are a materialized projection
 *   keyed by `xid` (external id, like Odoo's `xml_id`).
 * - **Role membership** — `userRoles` is the only RBAC table written at
 *   runtime; it links a user to a role row by `roleId`.
 *
 * @example
 * // app/src/db.ts
 * import * as fw from "drizzle-graphql-rbac/tables";
 * export const { users, sessions, roles, accessRights, recordRules, userRoles } = fw;
 *
 * import Database from "better-sqlite3";
 * import { drizzle } from "drizzle-orm/better-sqlite3";
 * const sqlite = new Database("app.db");
 * sqlite.pragma("foreign_keys = ON");
 * export const db = drizzle(sqlite, { schema: { ...fw } });
 */
import { sql } from "drizzle-orm";
import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  userId: integer("user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
});
export type Session = typeof sessions.$inferSelect;

/**
 * RBAC roles. `xid` is the external id declared in code (e.g.
 * `"app.role.admin"`); `key` is the human-friendly role name (e.g.
 * `"admin"`). The sync routine keeps rows in lockstep with code: rows whose
 * xid is no longer declared get cascade-deleted (their userRoles, accessRights
 * and recordRules go with them).
 */
export const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  xid: text("xid").notNull().unique(),
  key: text("key").notNull().unique(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
});
export type Role = typeof roles.$inferSelect;

/**
 * Per-role CRUD grants on a resource (a Drizzle schema key, e.g. `"todos"`).
 * Synced from code by `xid`; deny-by-default if no row grants an action.
 */
export const accessRights = sqliteTable(
  "access_rights",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    xid: text("xid").notNull().unique(),
    roleId: integer("role_id").notNull().references(() => roles.id),
    resource: text("resource").notNull(),
    canCreate: integer("can_create", { mode: "boolean" }).notNull().default(false),
    canRead: integer("can_read", { mode: "boolean" }).notNull().default(false),
    canUpdate: integer("can_update", { mode: "boolean" }).notNull().default(false),
    canDelete: integer("can_delete", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    uniqRoleResource: uniqueIndex("ar_role_resource_uniq").on(t.roleId, t.resource),
  }),
);
export type AccessRight = typeof accessRights.$inferSelect;

/**
 * Per-role row-level filters keyed by `(role, resource, action)`. `domain`
 * is the JSON-serialized Odoo polish-prefix domain. Synced from code by `xid`.
 */
export const recordRules = sqliteTable(
  "record_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    xid: text("xid").notNull().unique(),
    roleId: integer("role_id").notNull().references(() => roles.id),
    resource: text("resource").notNull(),
    action: text("action").notNull(), // "create" | "read" | "update" | "delete"
    domain: text("domain").notNull(), // JSON-encoded Domain
  },
  (t) => ({
    uniqRoleResAct: uniqueIndex("rr_role_res_act_uniq").on(t.roleId, t.resource, t.action),
  }),
);
export type RecordRule = typeof recordRules.$inferSelect;

/**
 * User → role assignment. Written by the admin dashboard at runtime. FK to
 * `roles.id`; the sync routine cascades deletes to this table when a role
 * disappears from code.
 */
export const userRoles = sqliteTable(
  "user_roles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id),
    roleId: integer("role_id").notNull().references(() => roles.id),
  },
  (t) => ({
    uniqUserRole: uniqueIndex("ur_user_role_uniq").on(t.userId, t.roleId),
  }),
);
export type UserRole = typeof userRoles.$inferSelect;

/** The full set of framework-owned tables, ready to spread into a schema namespace. */
export const frameworkTables = {
  users,
  sessions,
  roles,
  accessRights,
  recordRules,
  userRoles,
};
