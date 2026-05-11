import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

import { buildAuthRoutes, __resetRateLimitForTests } from "./routes.js";
import {
  resolveSessionFromToken,
  parseSessionCookie,
  parseCookieValue,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
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

describe("auth REST — login rate limiting", () => {
  // The implementation's per-(IP+email) limit is 10 and per-IP limit is 30.
  const PER_IP_EMAIL = 10;
  const PER_IP = 30;
  const RL_EMAIL = "ratelimit@x.com";
  const RL_PASSWORD = "rl-secret-123";

  before(async () => {
    // Register a known user we can drive successful logins against.
    __resetRateLimitForTests();
    await call("POST", "/register", {
      body: { name: "RL", email: RL_EMAIL, password: RL_PASSWORD },
      headers: { "x-forwarded-for": "10.0.0.99" },
    });
  });

  it("locks out after 10 failures for the same (IP, email)", async () => {
    __resetRateLimitForTests();
    const ip = "10.0.1.1";
    for (let i = 0; i < PER_IP_EMAIL; i++) {
      const r = await call("POST", "/login", {
        body: { email: RL_EMAIL, password: "WRONG" },
        headers: { "x-forwarded-for": ip },
      });
      assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
    }
    const over = await call("POST", "/login", {
      body: { email: RL_EMAIL, password: "WRONG" },
      headers: { "x-forwarded-for": ip },
    });
    assert.equal(over.status, 429);
    // Pin the exact documented envelope so a future refactor can't silently
    // change the body shape while keeping the 429 status.
    assert.deepEqual(over.body, { error: "Too many attempts, try again in a minute" });

    // Same email from a DIFFERENT IP within the same window must NOT be
    // locked out — proves the bucket is keyed on (IP, email), not email alone.
    const otherIp = await call("POST", "/login", {
      body: { email: RL_EMAIL, password: "WRONG" },
      headers: { "x-forwarded-for": "10.0.1.99" },
    });
    assert.equal(otherIp.status, 401);
  });

  it("successful login resets the per-(IP, email) bucket", async () => {
    __resetRateLimitForTests();
    const ip = "10.0.1.2";
    // 9 failures (one shy of the limit).
    for (let i = 0; i < PER_IP_EMAIL - 1; i++) {
      const r = await call("POST", "/login", {
        body: { email: RL_EMAIL, password: "WRONG" },
        headers: { "x-forwarded-for": ip },
      });
      assert.equal(r.status, 401);
    }
    // Successful login clears the bucket.
    const ok = await call("POST", "/login", {
      body: { email: RL_EMAIL, password: RL_PASSWORD },
      headers: { "x-forwarded-for": ip },
    });
    assert.equal(ok.status, 200);
    // 10 more failures should all be 401 (proves bucket was reset to 0, not 1).
    for (let i = 0; i < PER_IP_EMAIL; i++) {
      const r = await call("POST", "/login", {
        body: { email: RL_EMAIL, password: "WRONG" },
        headers: { "x-forwarded-for": ip },
      });
      assert.equal(r.status, 401, `post-reset attempt ${i + 1} should be 401`);
    }
    // And the 11th post-reset attempt should now trip the limiter — pins the
    // reset boundary precisely (reset → 0, not → 1 and not "permanently off").
    const reLock = await call("POST", "/login", {
      body: { email: RL_EMAIL, password: "WRONG" },
      headers: { "x-forwarded-for": ip },
    });
    assert.equal(reLock.status, 429);
  });

  it("per-(IP, email) bucket isolates different emails on the same IP", async () => {
    __resetRateLimitForTests();
    const ip = "10.0.1.3";
    const emailA = RL_EMAIL;
    const emailB = "ratelimit-b@x.com";
    // Limit-minus-one failures on email A.
    for (let i = 0; i < PER_IP_EMAIL - 1; i++) {
      const r = await call("POST", "/login", {
        body: { email: emailA, password: "WRONG" },
        headers: { "x-forwarded-for": ip },
      });
      assert.equal(r.status, 401);
    }
    // A single failure on email B (unknown email) — bucket is independent, expect 401.
    const b = await call("POST", "/login", {
      body: { email: emailB, password: "WRONG" },
      headers: { "x-forwarded-for": ip },
    });
    assert.equal(b.status, 401);
  });

  it("per-IP bucket trips after 30 failures across many emails from one IP", async () => {
    __resetRateLimitForTests();
    const ip = "10.0.1.4";
    // Use 30 distinct emails so the per-(IP, email) bucket never hits its own limit.
    for (let i = 0; i < PER_IP; i++) {
      const r = await call("POST", "/login", {
        body: { email: `noone-${i}@x.com`, password: "WRONG" },
        headers: { "x-forwarded-for": ip },
      });
      assert.equal(r.status, 401, `IP-axis attempt ${i + 1} should be 401`);
    }
    // A brand-new email from the same IP should now be rate-limited by the per-IP bucket.
    const over = await call("POST", "/login", {
      body: { email: "fresh-email@x.com", password: "WRONG" },
      headers: { "x-forwarded-for": ip },
    });
    assert.equal(over.status, 429);
    assert.deepEqual(over.body, { error: "Too many attempts, try again in a minute" });

    // A brand-new email + correct password from a DIFFERENT IP must still
    // succeed in the same window — proves the per-IP lockout is per-IP-scoped,
    // not a global kill-switch.
    const otherIp = await call("POST", "/login", {
      body: { email: RL_EMAIL, password: RL_PASSWORD },
      headers: { "x-forwarded-for": "10.0.1.49" },
    });
    assert.equal(otherIp.status, 200);
  });
});

describe("auth cookies — Secure flag is env-gated", () => {
  const SECURE_EMAIL = "secure-test@x.com";
  const SECURE_PASSWORD = "sec-secret-123";
  let prevEnv: string | undefined;

  before(async () => {
    __resetRateLimitForTests();
    prevEnv = process.env.NODE_ENV;
    // Register the user in dev mode so its cookies don't interfere; we re-login per test.
    process.env.NODE_ENV = "test";
    await call("POST", "/register", {
      body: { name: "Sec", email: SECURE_EMAIL, password: SECURE_PASSWORD },
      headers: { "x-forwarded-for": "10.0.2.99" },
    });
    process.env.NODE_ENV = prevEnv;
  });

  // Match `; Secure` as a complete cookie attribute (preceded by `; `, ended by
  // `;` or end-of-string) so a stray substring like `Secured` can't false-pass.
  const SECURE_ATTR = /; Secure(?:;|$)/;

  it("Set-Cookie `; Secure` flag tracks NODE_ENV across login + logout", async (t) => {
    const cases = [
      { nodeEnv: "production", flow: "login", ip: "10.0.2.1", expectSecure: true },
      { nodeEnv: "production", flow: "logout", ip: "10.0.2.3", expectSecure: true },
      { nodeEnv: "development", flow: "login", ip: "10.0.2.2", expectSecure: false },
    ] as const;

    for (const c of cases) {
      await t.test(`NODE_ENV=${c.nodeEnv} flow=${c.flow}`, async () => {
        const orig = process.env.NODE_ENV;
        process.env.NODE_ENV = c.nodeEnv;
        try {
          __resetRateLimitForTests();
          const login = await call("POST", "/login", {
            body: { email: SECURE_EMAIL, password: SECURE_PASSWORD },
            headers: { "x-forwarded-for": c.ip },
          });
          assert.equal(login.status, 200);

          // Pick the cookies under inspection based on the flow. For "login"
          // it's the freshly-issued sid/csrf cookies; for "logout" it's the
          // clearing (Max-Age=0) cookies that the /logout response writes.
          let sidCookie: string | undefined;
          let csrfCookie: string | undefined;
          if (c.flow === "login") {
            sidCookie = login.setCookieList.find((s) =>
              s.startsWith(`${SESSION_COOKIE_NAME}=`),
            );
            csrfCookie = login.setCookieList.find((s) =>
              s.startsWith(`${CSRF_COOKIE_NAME}=`),
            );
          } else {
            const token = cookieFromList(login.setCookieList, SESSION_COOKIE_NAME)!;
            const csrf = login.csrf!;
            const out = await call("POST", "/logout", {
              headers: {
                cookie: `${SESSION_COOKIE_NAME}=${token}; ${CSRF_COOKIE_NAME}=${csrf}`,
                "x-csrf-token": csrf,
                "x-forwarded-for": c.ip,
              },
            });
            assert.equal(out.status, 200);
            sidCookie = out.setCookieList.find(
              (s) => s.startsWith(`${SESSION_COOKIE_NAME}=`) && /Max-Age=0/.test(s),
            );
            csrfCookie = out.setCookieList.find(
              (s) => s.startsWith(`${CSRF_COOKIE_NAME}=`) && /Max-Age=0/.test(s),
            );
          }
          assert.ok(sidCookie, `expected ${c.flow} sid Set-Cookie`);
          assert.ok(csrfCookie, `expected ${c.flow} csrf Set-Cookie`);

          // Both cookies must flip together — login-set and logout-clear stay
          // symmetric, because a browser will not clear a `Secure` cookie via
          // a non-`Secure` clear instruction.
          if (c.expectSecure) {
            assert.match(sidCookie!, SECURE_ATTR);
            assert.match(csrfCookie!, SECURE_ATTR);
          } else {
            assert.equal(SECURE_ATTR.test(sidCookie!), false, `sid: ${sidCookie}`);
            assert.equal(SECURE_ATTR.test(csrfCookie!), false, `csrf: ${csrfCookie}`);
          }
        } finally {
          process.env.NODE_ENV = orig;
        }
      });
    }
  });
});
