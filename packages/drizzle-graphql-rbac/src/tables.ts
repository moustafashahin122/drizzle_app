/**
 * @module drizzle-graphql-rbac/tables
 *
 * The Drizzle table definitions the framework owns: identity (users +
 * sessions) and RBAC (groups, userGroups, accessRights, recordRules). Apps
 * built on this framework re-export these from their own schema module so a
 * single Drizzle `db` instance sees both framework and app tables.
 *
 * @example
 * // app/src/db.ts
 * import * as fw from "drizzle-graphql-rbac/tables";
 * export const { users, sessions, groups, userGroups, accessRights, recordRules } = fw;
 * export const todos = sqliteTable("todos", { ... });
 *
 * import Database from "better-sqlite3";
 * import { drizzle } from "drizzle-orm/better-sqlite3";
 * const sqlite = new Database("app.db");
 * sqlite.pragma("foreign_keys = ON");
 * export const db = drizzle(sqlite, {
 *   schema: { ...fw, todos },
 * });
 */
import { sql } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

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

export const groups = sqliteTable("groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  parentGroupId: integer("parent_group_id"),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
});
export type Group = typeof groups.$inferSelect;

export const userGroups = sqliteTable("user_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  groupId: integer("group_id").notNull().references(() => groups.id),
});
export type UserGroup = typeof userGroups.$inferSelect;

export const accessRights = sqliteTable("access_rights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: integer("group_id").notNull().references(() => groups.id),
  resource: text("resource").notNull(),
  canCreate: integer("can_create", { mode: "boolean" }).notNull().default(false),
  canRead: integer("can_read", { mode: "boolean" }).notNull().default(false),
  canUpdate: integer("can_update", { mode: "boolean" }).notNull().default(false),
  canDelete: integer("can_delete", { mode: "boolean" }).notNull().default(false),
});
export type AccessRight = typeof accessRights.$inferSelect;

export const recordRules = sqliteTable("record_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: integer("group_id").notNull().references(() => groups.id),
  resource: text("resource").notNull(),
  permType: text("perm_type").notNull(),
  domain: text("domain").notNull(),
});
export type RecordRule = typeof recordRules.$inferSelect;

/** The full set of framework-owned tables, ready to spread into a schema namespace. */
export const frameworkTables = {
  users,
  sessions,
  groups,
  userGroups,
  accessRights,
  recordRules,
};
