import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

import { buildAuthRoutes } from "./routes.js";
import { resolveSessionFromToken, parseSessionCookie } from "./session.js";

// Mirror src/db.ts so tests are hermetic.
const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  userId: integer("user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
});

let db: ReturnType<typeof drizzle>;
let app: ReturnType<typeof buildAuthRoutes>;

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
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );
  `);
  db = drizzle(sqlite);
  app = buildAuthRoutes({ db, schema: { users, sessions } });
});

/** Helper: fire a request through the Hono sub-app. */
async function call(
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const headers = { ...(init.headers ?? {}) } as Record<string, string>;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await app.request(path, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return {
    status: res.status,
    body: json,
    setCookie: res.headers.get("set-cookie"),
  };
}

describe("auth REST — register / login / me / logout", () => {
  it("register issues a session cookie and returns the user without passwordHash", async () => {
    const r = await call("POST", "/register", {
      body: { name: "Alice", email: "alice@x.com", password: "secret123" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.email, "alice@x.com");
    assert.ok(!("passwordHash" in r.body.user), "leaked passwordHash");
    const token = parseSessionCookie(r.setCookie);
    assert.ok(token && token.length >= 32, `expected session cookie, got ${r.setCookie}`);
  });

  it("rejects missing fields", async () => {
    const r = await call("POST", "/register", { body: { email: "x@y" } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /required/);
  });

  it("duplicate registration returns 409", async () => {
    const r = await call("POST", "/register", {
      body: { name: "Alice2", email: "alice@x.com", password: "x" },
    });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already registered/i);
  });

  it("login with correct password sets cookie; wrong password 401", async () => {
    const ok = await call("POST", "/login", {
      body: { email: "alice@x.com", password: "secret123" },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.name, "Alice");
    assert.ok(parseSessionCookie(ok.setCookie));

    const bad = await call("POST", "/login", {
      body: { email: "alice@x.com", password: "WRONG" },
    });
    assert.equal(bad.status, 401);
    assert.match(bad.body.error, /Invalid credentials/);
  });

  it("me returns 401 without a session and the user with one", async () => {
    const guest = await call("GET", "/me");
    assert.equal(guest.status, 401);

    const login = await call("POST", "/login", {
      body: { email: "alice@x.com", password: "secret123" },
    });
    const token = parseSessionCookie(login.setCookie)!;

    const cookieMe = await call("GET", "/me", { headers: { cookie: `sid=${token}` } });
    assert.equal(cookieMe.status, 200);
    assert.equal(cookieMe.body.user.email, "alice@x.com");

    const bearerMe = await call("GET", "/me", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(bearerMe.status, 200);
    assert.equal(bearerMe.body.user.email, "alice@x.com");
  });

  it("logout invalidates the session and clears the cookie", async () => {
    const login = await call("POST", "/login", {
      body: { email: "alice@x.com", password: "secret123" },
    });
    const token = parseSessionCookie(login.setCookie)!;

    const before = await resolveSessionFromToken(db, { users, sessions }, token);
    assert.ok(before.user);

    const out = await call("POST", "/logout", { headers: { cookie: `sid=${token}` } });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.match(out.setCookie ?? "", /Max-Age=0/);

    const after = await resolveSessionFromToken(db, { users, sessions }, token);
    assert.equal(after.user, null);
  });
});

describe("session helpers", () => {
  it("resolveSessionFromToken returns nulls for missing / unknown tokens", async () => {
    assert.deepEqual(
      await resolveSessionFromToken(db, { users, sessions }, null),
      { user: null, session: null },
    );
    assert.deepEqual(
      await resolveSessionFromToken(db, { users, sessions }, "not-a-real-token"),
      { user: null, session: null },
    );
  });

  it("parseSessionCookie tolerates whitespace and other cookies", () => {
    assert.equal(parseSessionCookie("sid=abc"), "abc");
    assert.equal(parseSessionCookie(" foo=1; sid=abc; bar=2 "), "abc");
    assert.equal(parseSessionCookie(""), null);
    assert.equal(parseSessionCookie(null), null);
  });
});
