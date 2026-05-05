import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { graphql, type GraphQLSchema } from "graphql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

import { buildSchema } from "./builder.js";
import { buildAuthExtensions, resolveSessionFromHeader, type AuthContext } from "./auth.js";

// Mirror src/db.ts so tests don't share the on-disk file.
const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  assigneeId: integer("assignee_id").references(() => users.id),
});
const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  userId: integer("user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
});

let schema: GraphQLSchema;
let db: ReturnType<typeof drizzle>;

before(() => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      assignee_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );
  `);
  db = drizzle(sqlite);
  const auth = buildAuthExtensions(db, { users, sessions });
  schema = buildSchema(db, { users, todos, sessions }, {
    hiddenOutputColumns: { users: ["passwordHash"] },
    extraQueryFields: auth.extraQueryFields,
    extraMutationFields: auth.extraMutationFields,
  }).schema;
});

const ctx = (overrides: Partial<AuthContext> = {}): AuthContext => ({
  user: null,
  session: null,
  batch: new Map(),
  ...overrides,
});

async function run(query: string, contextValue: AuthContext = ctx(), variables?: Record<string, unknown>) {
  const result = await graphql({ schema, source: query, contextValue, variableValues: variables });
  return result;
}

describe("auth — register / login / me / logout", () => {
  it("register issues a token and returns the new user without passwordHash", async () => {
    const r = await run(`
      mutation { register(name: "Alice", email: "alice@x.com", password: "secret123")
        { token user { id name email } }
      }
    `);
    assert.equal(r.errors, undefined);
    const data: any = r.data;
    assert.equal(data.register.user.name, "Alice");
    assert.equal(typeof data.register.token, "string");
    assert.ok(data.register.token.length >= 32);
  });

  it("User type does not expose passwordHash", async () => {
    const r = await run(`{ __type(name: "Users") { fields { name } } }`);
    const fieldNames: string[] = (r.data as any).__type.fields.map((f: any) => f.name);
    assert.ok(!fieldNames.includes("passwordHash"), `leaked passwordHash: ${fieldNames.join(",")}`);
    assert.ok(fieldNames.includes("email"));
  });

  it("login with correct password returns a token; wrong password fails", async () => {
    const ok = await run(`
      mutation { login(email: "alice@x.com", password: "secret123") { token user { name } } }
    `);
    assert.equal(ok.errors, undefined);
    assert.equal((ok.data as any).login.user.name, "Alice");

    const bad = await run(`
      mutation { login(email: "alice@x.com", password: "WRONG") { token } }
    `);
    assert.ok(bad.errors?.[0]?.message.includes("Invalid credentials"));
  });

  it("duplicate registration rejects with a clear message", async () => {
    const r = await run(`
      mutation { register(name: "Alice2", email: "alice@x.com", password: "x") { token } }
    `);
    assert.ok(r.errors?.[0]?.message.includes("already registered"));
  });

  it("me returns null without a session and the current user with one", async () => {
    const guest = await run(`{ me { id name } }`);
    assert.equal((guest.data as any).me, null);

    const login = await run(`
      mutation { login(email: "alice@x.com", password: "secret123") { token user { id name } } }
    `);
    const token: string = (login.data as any).login.token;
    const userIdStr: string = (login.data as any).login.user.id;

    const resolved = await resolveSessionFromHeader(db, { users, sessions }, `Bearer ${token}`);
    assert.equal(String(resolved.user?.id), userIdStr);

    const auth = await run(`{ me { id name } }`, ctx({ user: resolved.user, session: resolved.session }));
    assert.equal((auth.data as any).me.id, userIdStr);
  });

  it("logout invalidates the session", async () => {
    const login = await run(`
      mutation { login(email: "alice@x.com", password: "secret123") { token } }
    `);
    const token: string = (login.data as any).login.token;
    const before = await resolveSessionFromHeader(db, { users, sessions }, `Bearer ${token}`);
    assert.ok(before.user);

    const out = await run(
      `mutation { logout }`,
      ctx({ user: before.user, session: before.session }),
    );
    assert.equal((out.data as any).logout, true);

    const after = await resolveSessionFromHeader(db, { users, sessions }, `Bearer ${token}`);
    assert.equal(after.user, null);
    assert.equal(after.session, null);
  });
});

describe("resolveSessionFromHeader", () => {
  it("returns nulls for missing / malformed headers", async () => {
    assert.deepEqual(
      await resolveSessionFromHeader(db, { users, sessions }, null),
      { user: null, session: null },
    );
    assert.deepEqual(
      await resolveSessionFromHeader(db, { users, sessions }, "Basic abc"),
      { user: null, session: null },
    );
    assert.deepEqual(
      await resolveSessionFromHeader(db, { users, sessions }, "Bearer "),
      { user: null, session: null },
    );
  });

  it("returns nulls for unknown tokens", async () => {
    const r = await resolveSessionFromHeader(db, { users, sessions }, "Bearer not-a-real-token");
    assert.equal(r.user, null);
  });
});
