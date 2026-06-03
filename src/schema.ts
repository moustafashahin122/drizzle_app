/**
 * @module app/schema
 *
 * Dialect-dispatching re-export. Picks `./schema.pg.js` when
 * `DATABASE_URL` looks like Postgres, otherwise `./schema.sqlite.js`.
 *
 * Both flavors expose the exact same JS keys (`users`, `sessions`, `roles`,
 * `projects`, `todos`, `frameworkTables`), so callers don't care which is
 * active. Types are exported from the sqlite flavor; the column-level
 * `$inferSelect` / `$inferInsert` shapes are structurally compatible.
 *
 * drizzle-kit reads this file via `drizzle.config.ts` — that config branches
 * on `DATABASE_URL` too, so migrations get the right dialect.
 */
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";

const url = process.env.DATABASE_URL ?? "";
const isPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");

const activeSchema: typeof sqliteSchema = (isPostgres ? pgSchema : sqliteSchema) as unknown as typeof sqliteSchema;

export const roles = activeSchema.roles;
export const users = activeSchema.users;
export const sessions = activeSchema.sessions;
export const projects = activeSchema.projects;
export const todos = activeSchema.todos;

export const frameworkTables = { roles, users, sessions };

export type { Role, NewRole, User, NewUser, Session, Project, NewProject, Todo, NewTodo } from "./schema.sqlite.js";
