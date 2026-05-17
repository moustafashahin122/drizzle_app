/**
 * @module drizzle-graphql-rbac/tables.pg
 *
 * Postgres-flavored versions of the framework-owned tables (mirror of
 * `tables.sqlite.ts`). Column names, JS keys, and semantics are identical;
 * only the dialect-specific column constructors differ.
 */
import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, boolean, type AnyPgColumn } from "drizzle-orm/pg-core";

export const roles = pgTable("roles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  isAdmin: boolean("is_admin").notNull().default(false),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  active: boolean("active").notNull().default(true),
  roleId: integer("role_id").references((): AnyPgColumn => roles.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  userId: integer("user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
});

export const frameworkTables = { roles, users, sessions };
