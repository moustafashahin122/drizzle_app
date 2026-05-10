/**
 * Idempotent table bootstrap for `todo.db`.
 *
 * Creates the framework-owned tables (`users`, `sessions`, `roles`,
 * `access_rights`, `record_rules`, `user_roles`) plus the demo `todos`
 * table. The RBAC config tables (`roles` / `access_rights` / `record_rules`)
 * are populated at server start by `syncRbacFromCode` — this script just
 * sets the schema up so the sync routine has somewhere to write.
 *
 * Use as a one-shot replacement for `drizzle-kit push` when drizzle-kit's
 * CJS loader can't resolve the workspace's TypeScript-only package entry.
 */
import Database from "better-sqlite3";

const sqlite = new Database("todo.db");
sqlite.pragma("foreign_keys = ON");

// Migration: previous schema had user_roles(role_key TEXT). Drop it so the
// new `role_id INTEGER REFERENCES roles(id)` definition can replace it.
const cols = sqlite
  .prepare("PRAGMA table_info(user_roles)")
  .all() as { name: string }[];
if (cols.some((c) => c.name === "role_key")) {
  sqlite.exec("DROP TABLE user_roles;");
  console.log("Dropped legacy user_roles(role_key); will recreate with role_id.");
}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    xid TEXT NOT NULL UNIQUE,
    key TEXT NOT NULL UNIQUE,
    is_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS access_rights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    xid TEXT NOT NULL UNIQUE,
    role_id INTEGER NOT NULL REFERENCES roles(id),
    resource TEXT NOT NULL,
    can_create INTEGER NOT NULL DEFAULT 0,
    can_read INTEGER NOT NULL DEFAULT 0,
    can_update INTEGER NOT NULL DEFAULT 0,
    can_delete INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ar_role_resource_uniq
    ON access_rights(role_id, resource);
  CREATE TABLE IF NOT EXISTS record_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    xid TEXT NOT NULL UNIQUE,
    role_id INTEGER NOT NULL REFERENCES roles(id),
    resource TEXT NOT NULL,
    action TEXT NOT NULL,
    domain TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS rr_role_res_act_uniq
    ON record_rules(role_id, resource, action);
  CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role_id INTEGER NOT NULL REFERENCES roles(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ur_user_role_uniq
    ON user_roles(user_id, role_id);
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assignee_id INTEGER REFERENCES users(id)
  );
`);
sqlite.close();
console.log("todo.db ready (users, sessions, roles, access_rights, record_rules, user_roles, todos).");
