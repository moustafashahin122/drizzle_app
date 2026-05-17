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
const usePg = url.startsWith("postgres://") || url.startsWith("postgresql://");

const active: typeof sqliteSchema = (usePg ? pgSchema : sqliteSchema) as unknown as typeof sqliteSchema;

export const roles = active.roles;
export const users = active.users;
export const sessions = active.sessions;
export const projects = active.projects;
export const todos = active.todos;

export const frameworkTables = { roles, users, sessions };

export type { Role, NewRole, User, NewUser, Session, Project, NewProject, Todo, NewTodo } from "./schema.sqlite.js";
