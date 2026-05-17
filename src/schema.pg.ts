/**
 * @module app/schema.pg
 *
 * Postgres-flavored mirror of `./schema.sqlite.ts`. Same JS keys, same
 * column names, same `assignee_id` FK to `users.id` — only the dialect
 * column constructors differ.
 */
import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, boolean } from "drizzle-orm/pg-core";
import { users } from "drizzle-graphql-rbac/tables/pg";

export { roles, users, sessions, frameworkTables } from "drizzle-graphql-rbac/tables/pg";

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

export const todos = pgTable("todos", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  completed: boolean("completed").notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  assigneeId: integer("assignee_id").references(() => users.id),
  projectId: integer("project_id").references(() => projects.id),
});
