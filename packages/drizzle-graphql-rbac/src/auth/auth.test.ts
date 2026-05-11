import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

import { buildAuthRoutes } from "./routes.js";
import {
  resolveSessionFromToken,
  parseSessionCookie,
  parseCookieValue,
  CSRF_COOKIE_NAME,
} from "./session.js";

/** Extract a cookie value by name from a list of Set-Cookie strings. */
function cookieFromList(list: string[], name: string): string | null {
  for (const raw of list) {
    const first = raw.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    if (first.slice(0, eq).trim() !== name) continue;
    const v = first.slice(eq + 1).trim();
    return v || null;
  }
  return null;
}

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
): Promise<{
  status: number;
  body: any;
  setCookie: string | null;
  setCookieList: string[];
  csrf: string | null;
}> {
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
  const setCookieList =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")!]
        : [];
  return {
    status: res.status,
    body: json,
    setCookie: res.headers.get("set-cookie"),
    setCookieList,
    csrf: cookieFromList(setCookieList, CSRF_COOKIE_NAME),
  };
}

/** Build Cookie + X-CSRF-Token headers for an authenticated request. */
function authedHeaders(token: string, csrf: string): Record<string, string> {
  return { cookie: `sid=${token}; csrf_token=${csrf}`, "x-csrf-token": csrf };
}

describe("auth REST — register / login / me / logout", () => {
  it("register issues a session cookie and returns the user without passwordHash", async () => {
    const r = await call("POST", "/register", {
      body: { name: "Alice", email: "alice@x.com", password: "secret123" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.email, "alice@x.com");
    assert.ok(!("passwordHash" in r.body.user), "leaked passwordHash");
    const token = cookieFromList(r.setCookieList, "sid");
    assert.ok(token && token.length >= 32, `expected session cookie, got ${r.setCookie}`);
    assert.ok(r.csrf && r.csrf.length >= 32, "expected csrf_token cookie");
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
    assert.ok(cookieFromList(ok.setCookieList, "sid"));
    assert.ok(ok.csrf);

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
    const token = cookieFromList(login.setCookieList, "sid")!;

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
    const token = cookieFromList(login.setCookieList, "sid")!;
    const csrf = login.csrf!;

    const before = await resolveSessionFromToken(db, { users, sessions }, token);
    assert.ok(before.user);

    const out = await call("POST", "/logout", { headers: authedHeaders(token, csrf) });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.match(out.setCookie ?? "", /Max-Age=0/);

    const after = await resolveSessionFromToken(db, { users, sessions }, token);
    assert.equal(after.user, null);
  });

  it("rejects mutating requests without a CSRF token (double-submit)", async () => {
    const login = await call("POST", "/login", {
      body: { email: "alice@x.com", password: "secret123" },
    });
    const token = cookieFromList(login.setCookieList, "sid")!;
    // Cookie present (so middleware enforces CSRF) but no header / no csrf cookie.
    const r = await call("POST", "/logout", { headers: { cookie: `sid=${token}` } });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /CSRF/);
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
