import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

export const assignees = sqliteTable("assignees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
export type Assignee = typeof assignees.$inferSelect;
export type NewAssignee = typeof assignees.$inferInsert;

export const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  assigneeId: integer("assignee_id").references(() => assignees.id),
});
export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;

const sqlite = new Database("todo.db");
export const db = drizzle(sqlite, { schema: { assignees, todos } });
