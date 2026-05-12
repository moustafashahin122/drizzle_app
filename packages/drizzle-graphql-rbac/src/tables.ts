/**
 * @module drizzle-graphql-rbac/tables
 *
 * Drizzle table definitions the framework owns:
 *
 * - **Identity** — `users`, `sessions`.
 * - **RBAC** — `roles`. Each user holds at most one role via `users.role_id`.
 *
 * Roles are declared in code (the host app's `defineRoles({...})` config)
 * and reconciled into this table at startup by `syncRoles` — names missing
 * from code are deleted (and any referencing `users.role_id` nulled out),
 * names new in code are inserted, and `is_admin` is refreshed from code on
 * every surviving row. The DB row is the persisted state RBAC consults at
 * request time; the code config is the source of truth for what should
 * exist and what its `is_admin` value should be.
 */
import { sql } from "drizzle-orm";
import { sqliteTable, integer, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
});
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  // ON DELETE SET NULL: when a role row is removed by syncRoles, every user
  // pointing at it is silently demoted to roleless (which RBAC denies) instead
  // of cascading deletes through the user table.
  roleId: integer("role_id").references((): AnySQLiteColumn => roles.id, {
    onDelete: "set null",
  }),
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

/** The full set of framework-owned tables, ready to spread into a schema namespace. */
export const frameworkTables = {
  roles,
  users,
  sessions,
};
