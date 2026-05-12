import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { roles, users, sessions } from "../tables.js";
import { buildAuthRoutes } from "./routes.js";
import {
  resolveSessionFromToken,
  parseSessionCookie,
  SESSION_COOKIE_NAME,
} from "./session.js";
import { cookieValue, jsonFetch } from "../testing/base.js";
import {
  freshFrameworkDb,
  frameworkSchema,
  type FrameworkDb,
} from "../testing/framework_testing.js";

let db: FrameworkDb;
let app: ReturnType<typeof buildAuthRoutes>;

before(async () => {
  const fresh = await freshFrameworkDb();
  db = fresh.db;
  app = buildAuthRoutes({ db, schema: frameworkSchema });
});

/** Thin adapter over the shared `jsonFetch` — defaults to the suite's `app`. */
function call(
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
) {
  return jsonFetch(app, method, path, init);
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

describe("auth cookies — Secure flag is always set", () => {
  const SECURE_EMAIL = "secure-test@x.com";
  const SECURE_PASSWORD = "sec-secret-123";

  before(async () => {
    await call("POST", "/register", {
      body: { name: "Sec", email: SECURE_EMAIL, password: SECURE_PASSWORD },
      headers: { "x-forwarded-for": "10.0.2.99" },
    });
  });

  // Match `; Secure` as a complete cookie attribute (preceded by `; `, ended by
  // `;` or end-of-string) so a stray substring like `Secured` can't false-pass.
  const SECURE_ATTR = /; Secure(?:;|$)/;

  it("Set-Cookie carries `; Secure` on login and logout", async (t) => {
    for (const flow of ["login", "logout"] as const) {
      await t.test(`flow=${flow}`, async () => {
        const ip = flow === "login" ? "10.0.2.1" : "10.0.2.3";
        const login = await call("POST", "/login", {
          body: { email: SECURE_EMAIL, password: SECURE_PASSWORD },
          headers: { "x-forwarded-for": ip },
        });
        assert.equal(login.status, 200);

        // Pick the cookie under inspection based on the flow. For "login"
        // it's the freshly-issued sid cookie; for "logout" it's the
        // clearing (Max-Age=0) cookie that the /logout response writes.
        let sidCookie: string | undefined;
        if (flow === "login") {
          sidCookie = login.setCookies.find((s) =>
            s.startsWith(`${SESSION_COOKIE_NAME}=`),
          );
        } else {
          const token = cookieValue(login.setCookies, SESSION_COOKIE_NAME)!;
          const out = await call("POST", "/logout", {
            headers: {
              cookie: `${SESSION_COOKIE_NAME}=${token}`,
              "x-forwarded-for": ip,
            },
          });
          assert.equal(out.status, 200);
          sidCookie = out.setCookies.find(
            (s) => s.startsWith(`${SESSION_COOKIE_NAME}=`) && /Max-Age=0/.test(s),
          );
        }
        assert.ok(sidCookie, `expected ${flow} sid Set-Cookie`);
        assert.match(sidCookie!, SECURE_ATTR);
      });
    }
  });
});
