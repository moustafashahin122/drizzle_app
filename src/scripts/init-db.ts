/**
 * Idempotent table bootstrap for `todo.db`.
 *
 * Creates the framework-owned tables (`users`, `sessions`) plus the demo
 * `todos` table. RBAC (roles, access rights, record rules, user→role
 * assignments) is in-memory in this build — there are no RBAC tables.
 */
import Database from "better-sqlite3";

const sqlite = new Database("todo.db");
sqlite.pragma("foreign_keys = ON");

// Migration: prior schema versions had RBAC tables. Drop them if present so
// the on-disk file matches the current in-memory model.
for (const t of ["user_roles", "access_rights", "record_rules", "roles"]) {
  sqlite.exec(`DROP TABLE IF EXISTS ${t};`);
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
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assignee_id INTEGER REFERENCES users(id)
  );
`);
sqlite.close();
console.log("todo.db ready (users, sessions, todos).");
