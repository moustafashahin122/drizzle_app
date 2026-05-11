/**
 * @module drizzle-graphql-rbac/tables
 *
 * Drizzle table definitions the framework owns:
 *
 * - **Identity** — `users`, `sessions`.
 *
 * RBAC is fully in-memory in this build — roles, access rights, record rules,
 * and user→role assignments live in the engine snapshot built at startup from
 * the code config. No RBAC tables are persisted.
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

/** The full set of framework-owned tables, ready to spread into a schema namespace. */
export const frameworkTables = {
  users,
  sessions,
};
