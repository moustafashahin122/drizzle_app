import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { roles, users, sessions } from "../tables.js";
import { buildAuthRoutes } from "./routes.js";
import {
  resolveSessionFromToken,
  parseSessionCookie,
  SESSION_COOKIE_NAME,
} from "./session.js";
import { cookieValue, jsonFetch } from "../testing/httpTestUtils.js";
import {
  buildAuthOnly,
  freshFrameworkDb,
  type FrameworkDb,
} from "../testing/frameworkTesting.js";

let db: FrameworkDb;
let app: ReturnType<typeof buildAuthRoutes>;

before(async () => {
  const fresh = await freshFrameworkDb();
  db = fresh.db;
  app = (await buildAuthOnly({ db })).app;
});

/** Thin adapter over the shared `jsonFetch` — defaults `target` to the suite's `app`. */
function call(
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
  target: ReturnType<typeof buildAuthRoutes> = app,
) {
  return jsonFetch(target, method, path, init);
}

describe("auth REST — register / login / me / logout", () => {
  it("register issues a session cookie and returns the user without passwordHash", async () => {
    const r = await call("POST", "/register", {
      body: { name: "Alice", email: "alice@x.com", password: "secret123" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.email, "alice@x.com");
    assert.ok(!("passwordHash" in r.body.user), "leaked passwordHash");
    const token = cookieValue(r.setCookies, "sid");
    assert.ok(token && token.length >= 32, `expected session cookie, got ${r.setCookies.join(", ")}`);
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
    assert.ok(cookieValue(ok.setCookies, "sid"));

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
    const token = cookieValue(login.setCookies, "sid")!;

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
    const token = cookieValue(login.setCookies, "sid")!;

    const before = await resolveSessionFromToken(db, { users, sessions, roles }, token);
    assert.ok(before.user);

    const out = await call("POST", "/logout", { headers: { cookie: `sid=${token}` } });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.ok(
      out.setCookies.some((c) => /Max-Age=0/.test(c)),
      `expected a clearing Set-Cookie (Max-Age=0), got ${out.setCookies.join(", ")}`,
    );

    const after = await resolveSessionFromToken(db, { users, sessions, roles }, token);
    assert.equal(after.user, null);
  });

});

describe("session helpers", () => {
  it("resolveSessionFromToken returns nulls for missing / unknown tokens", async () => {
    assert.deepEqual(
      await resolveSessionFromToken(db, { users, sessions, roles }, null),
      { user: null, session: null, role: null },
    );
    assert.deepEqual(
      await resolveSessionFromToken(db, { users, sessions, roles }, "not-a-real-token"),
      { user: null, session: null, role: null },
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
  // Drive the limiter with small, distinct limits so the tests exercise the
  // logic (lockout, bucket isolation, success-resets) rather than the prod
  // defaults. The two limits differ so per-IP / per-(IP,email) can't be
  // confused for one another.
  const PER_IP_EMAIL = 3;
  const PER_IP = 5;
  const RL_EMAIL = "ratelimit@x.com";
  const RL_PASSWORD = "rl-secret-123";

  /** Fresh sub-app per test → fresh MemoryStores; no shared rate-limit state to reset. */
  let rlApp: ReturnType<typeof buildAuthRoutes>;
  const rlCall: typeof call = (method, path, init) => call(method, path, init, rlApp);

  before(async () => {
    // Register against the shared `app` once; the user row persists in the DB
    // and is visible to every per-test rlApp (they share the same DB handle).
    await call("POST", "/register", {
      body: { name: "RL", email: RL_EMAIL, password: RL_PASSWORD },
      headers: { "x-forwarded-for": "10.0.0.99" },
    });
  });

  beforeEach(async () => {
    rlApp = (await buildAuthOnly({
      db,
      loginRateLimit: { maxPerIpEmail: PER_IP_EMAIL, maxPerIp: PER_IP },
    })).app;
  });

  it("locks out after maxPerIpEmail failures for the same (IP, email)", async () => {
    const ip = "10.0.1.1";
    for (let i = 0; i < PER_IP_EMAIL; i++) {
      const r = await rlCall("POST", "/login", {
        body: { email: RL_EMAIL, password: "WRONG" },
        headers: { "x-forwarded-for": ip },
      });
      assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
    }
    const over = await rlCall("POST", "/login", {
      body: { email: RL_EMAIL, password: "WRONG" },
      headers: { "x-forwarded-for": ip },
    });
    assert.equal(over.status, 429);
    // Pin the exact documented envelope so a future refactor can't silently
    // change the body shape while keeping the 429 status.
    assert.deepEqual(over.body, { error: "Too many attempts, try again in a minute" });

    // Same email from a DIFFERENT IP within the same window must NOT be
    // locked out — proves the bucket is keyed on (IP, email), not email alone.
    const otherIp = await rlCall("POST", "/login", {
      body: { email: RL_EMAIL, password: "WRONG" },
      headers: { "x-forwarded-for": "10.0.1.99" },
    });
    assert.equal(otherIp.status, 401);
  });

  it("successful login resets the per-(IP, email) bucket", async () => {
    const ip = "10.0.1.2";
    // One shy of the limit.
    for (let i = 0; i < PER_IP_EMAIL - 1; i++) {
      const r = await rlCall("POST", "/login", {
        body: { email: RL_EMAIL, password: "WRONG" },
        headers: { "x-forwarded-for": ip },
      });
      assert.equal(r.status, 401);
    }
    // Successful login clears the bucket.
    const ok = await rlCall("POST", "/login", {
      body: { email: RL_EMAIL, password: RL_PASSWORD },
      headers: { "x-forwarded-for": ip },
    });
    assert.equal(ok.status, 200);
    // maxPerIpEmail more failures should all be 401 (proves bucket was reset to 0, not 1).
    for (let i = 0; i < PER_IP_EMAIL; i++) {
      const r = await rlCall("POST", "/login", {
        body: { email: RL_EMAIL, password: "WRONG" },
        headers: { "x-forwarded-for": ip },
      });
      assert.equal(r.status, 401, `post-reset attempt ${i + 1} should be 401`);
    }
    // The next attempt should now trip the limiter — pins the reset boundary
    // precisely (reset → 0, not → 1 and not "permanently off").
    const reLock = await rlCall("POST", "/login", {
      body: { email: RL_EMAIL, password: "WRONG" },
      headers: { "x-forwarded-for": ip },
    });
    assert.equal(reLock.status, 429);
  });

  it("per-(IP, email) bucket isolates different emails on the same IP", async () => {
    const ip = "10.0.1.3";
    const emailA = RL_EMAIL;
    const emailB = "ratelimit-b@x.com";
    // Limit-minus-one failures on email A.
    for (let i = 0; i < PER_IP_EMAIL - 1; i++) {
      const r = await rlCall("POST", "/login", {
        body: { email: emailA, password: "WRONG" },
        headers: { "x-forwarded-for": ip },
      });
      assert.equal(r.status, 401);
    }
    // A single failure on email B (unknown email) — bucket is independent, expect 401.
    const b = await rlCall("POST", "/login", {
      body: { email: emailB, password: "WRONG" },
      headers: { "x-forwarded-for": ip },
    });
    assert.equal(b.status, 401);
  });

  it("per-IP bucket trips after maxPerIp failures across many emails from one IP", async () => {
    const ip = "10.0.1.4";
    // Use PER_IP distinct emails so the per-(IP, email) bucket never hits its own limit.
    for (let i = 0; i < PER_IP; i++) {
      const r = await rlCall("POST", "/login", {
        body: { email: `noone-${i}@x.com`, password: "WRONG" },
        headers: { "x-forwarded-for": ip },
      });
      assert.equal(r.status, 401, `IP-axis attempt ${i + 1} should be 401`);
    }
    // A brand-new email from the same IP should now be rate-limited by the per-IP bucket.
    const over = await rlCall("POST", "/login", {
      body: { email: "fresh-email@x.com", password: "WRONG" },
      headers: { "x-forwarded-for": ip },
    });
    assert.equal(over.status, 429);
    assert.deepEqual(over.body, { error: "Too many attempts, try again in a minute" });

    // A brand-new email + correct password from a DIFFERENT IP must still
    // succeed in the same window — proves the per-IP lockout is per-IP-scoped,
    // not a global kill-switch.
    const otherIp = await rlCall("POST", "/login", {
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
          const login = await call("POST", "/login", {
            body: { email: SECURE_EMAIL, password: SECURE_PASSWORD },
            headers: { "x-forwarded-for": c.ip },
          });
          assert.equal(login.status, 200);

          // Pick the cookie under inspection based on the flow. For "login"
          // it's the freshly-issued sid cookie; for "logout" it's the
          // clearing (Max-Age=0) cookie that the /logout response writes.
          let sidCookie: string | undefined;
          if (c.flow === "login") {
            sidCookie = login.setCookies.find((s) =>
              s.startsWith(`${SESSION_COOKIE_NAME}=`),
            );
          } else {
            const token = cookieValue(login.setCookies, SESSION_COOKIE_NAME)!;
            const out = await call("POST", "/logout", {
              headers: {
                cookie: `${SESSION_COOKIE_NAME}=${token}`,
                "x-forwarded-for": c.ip,
              },
            });
            assert.equal(out.status, 200);
            sidCookie = out.setCookies.find(
              (s) => s.startsWith(`${SESSION_COOKIE_NAME}=`) && /Max-Age=0/.test(s),
            );
          }
          assert.ok(sidCookie, `expected ${c.flow} sid Set-Cookie`);

          if (c.expectSecure) {
            assert.match(sidCookie!, SECURE_ATTR);
          } else {
            assert.equal(SECURE_ATTR.test(sidCookie!), false, `sid: ${sidCookie}`);
          }
        } finally {
          process.env.NODE_ENV = orig;
        }
      });
    }
  });
});
