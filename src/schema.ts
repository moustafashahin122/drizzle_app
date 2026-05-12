/**
 * @module app/schema
 *
 * Pure Drizzle table declarations for the demo app. No DB connection is
 * opened here — `src/db.ts` owns the file-backed handle for production and
 * `src/testing/appTestCase.ts` opens its own handle against the shared
 * in-memory sqlite. Both import from this module so the schema is defined
 * exactly once.
 *
 * Drizzle Kit's config (`drizzle.config.ts`) also points at this file so
 * migration generation never triggers a file-DB open.
 */
import { sql } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { users } from "drizzle-graphql-rbac/tables";

export { roles, users, sessions, frameworkTables } from "drizzle-graphql-rbac/tables";
export type { Role, NewRole, User, NewUser, Session } from "drizzle-graphql-rbac/tables";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  assigneeId: integer("assignee_id").references(() => users.id),
  projectId: integer("project_id").references(() => projects.id),
});
export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
