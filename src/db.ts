import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
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

export const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  assigneeId: integer("assignee_id").references(() => users.id),
});
export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;

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
  permType: text("perm_type").notNull(), // "create" | "read" | "update" | "delete"
  domain: text("domain").notNull(), // JSON-encoded Odoo-style domain
});
export type RecordRule = typeof recordRules.$inferSelect;

const sqlite = new Database("todo.db");
sqlite.pragma("foreign_keys = ON");
export const db = drizzle(sqlite, {
  schema: { users, todos, sessions, groups, userGroups, accessRights, recordRules },
});
