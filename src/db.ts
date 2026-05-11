import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { frameworkTables, users } from "drizzle-graphql-rbac";

export { users, sessions } from "drizzle-graphql-rbac";
export type { User, NewUser, Session } from "drizzle-graphql-rbac";

export const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  assigneeId: integer("assignee_id").references(() => users.id),
});
export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;

const sqlite = new Database("todo.db");
sqlite.pragma("foreign_keys = ON");
export const db = drizzle(sqlite, {
  schema: { ...frameworkTables, todos },
  logger: true,
});
