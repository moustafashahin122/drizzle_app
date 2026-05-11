/**
 * Sign-in / sign-out HTTP flow against the full Hono app (REST /auth/* +
 * session middleware). Mirrors what the browser does: cookies in,
 * server-side session lifecycle verified via `/auth/me`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { setupAppTestCase, createUser } from "./testing/appTestCase.js";

const PASSWORD = "secret123";

const tc = setupAppTestCase(async (base) => {
  const alice = await createUser(base.sudoDb, {
    name: "Alice",
    email: "alice@auth-test.example.com",
    password: PASSWORD,
  });
  return { alice };
});

/** Read every Set-Cookie header from a Response (Node 20+ has getSetCookie). */
function setCookies(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookieValue(list: string[], name: string): string | null {
  for (const raw of list) {
    const first = raw.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    if (first.slice(0, eq).trim() !== name) continue;
    return first.slice(eq + 1).trim() || null;
  }
  return null;
}

/** True iff a Set-Cookie for `name` carries `Max-Age=0` (a clear). */
function isCleared(list: string[], name: string): boolean {
  for (const raw of list) {
    const parts = raw.split(";").map((s) => s.trim());
    const [head] = parts;
    if (!head?.startsWith(`${name}=`)) continue;
    if (parts.some((p) => /^max-age=0$/i.test(p))) return true;
  }
  return false;
}

async function login(email: string, password: string) {
  const res = await tc.app.fetch(
    new Request("http://test.local/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  const body = await res.json().catch(() => null);
  const cookies = setCookies(res);
  return {
    status: res.status,
    body,
    cookies,
    sid: cookieValue(cookies, "sid"),
  };
}

async function me(sid: string | null) {
  const res = await tc.app.fetch(
    new Request("http://test.local/auth/me", {
      method: "GET",
      headers: sid ? { cookie: `sid=${sid}` } : {},
    }),
  );
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function logout(opts: { sid: string | null }) {
  const headers: Record<string, string> = {};
  if (opts.sid) headers.cookie = `sid=${opts.sid}`;
  const res = await tc.app.fetch(
    new Request("http://test.local/auth/logout", { method: "POST", headers }),
  );
  const body = await res.json().catch(() => null);
  const cookies = setCookies(res);
  return { status: res.status, body, cookies };
}

describe("auth HTTP flow — sign in", () => {
  it("valid credentials → 200, user payload (no passwordHash), sid cookie", async () => {
    const r = await login(tc.seed.alice.email, PASSWORD);
    assert.equal(r.status, 200);
    assert.ok(r.body?.user, "login response includes user");
    assert.equal(r.body.user.email, tc.seed.alice.email);
    assert.equal(r.body.user.id, tc.seed.alice.id);
    assert.equal(r.body.user.passwordHash, undefined, "passwordHash must never leak");

    assert.ok(r.sid, "sid cookie set");

    // sid cookie must be HttpOnly so JS can't steal it.
    const sidRaw = r.cookies.find((c) => c.startsWith("sid="))!;
    assert.match(sidRaw, /HttpOnly/i);

    // The freshly minted sid must resolve a session through /auth/me.
    const m = await me(r.sid);
    assert.equal(m.status, 200);
    assert.equal(m.body.user.id, tc.seed.alice.id);
  });

  it("wrong password → 401, no cookies", async () => {
    const r = await login(tc.seed.alice.email, "not-the-password");
    assert.equal(r.status, 401);
    assert.equal(r.sid, null);
  });

  it("unknown email → 401, no cookies (timing-equivalent path)", async () => {
    const r = await login("nobody@auth-test.example.com", PASSWORD);
    assert.equal(r.status, 401);
    assert.equal(r.sid, null);
  });

  it("login persists a sessions row pointing at the user", async () => {
    const r = await login(tc.seed.alice.email, PASSWORD);
    assert.equal(r.status, 200);
    const rows = await tc.sudoDb
      .select()
      .from(tc.schema.sessions)
      .where(eq(tc.schema.sessions.token, r.sid!));
    assert.equal(rows.length, 1, "exactly one session row for the issued token");
    assert.equal(rows[0].userId, tc.seed.alice.id);
  });
});

describe("auth HTTP flow — sign out", () => {
  it("logout → 200 ok, session destroyed, cookie cleared", async () => {
    const li = await login(tc.seed.alice.email, PASSWORD);
    assert.equal(li.status, 200);

    const out = await logout({ sid: li.sid });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true });

    assert.ok(isCleared(out.cookies, "sid"), "sid Set-Cookie clears with Max-Age=0");

    // Server-side session is gone — /auth/me with the now-stale sid returns 401.
    const m = await me(li.sid);
    assert.equal(m.status, 401);

    const rows = await tc.sudoDb
      .select()
      .from(tc.schema.sessions)
      .where(eq(tc.schema.sessions.token, li.sid!));
    assert.equal(rows.length, 0, "sessions row removed by destroySession");
  });

  it("logout with no session cookie at all → 200 ok:false, cookie still cleared (idempotent)", async () => {
    const out = await logout({ sid: null });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: false });
    assert.ok(isCleared(out.cookies, "sid"));
  });

  it("after logout, the old sid cannot be reused to log in again — re-login mints a fresh session row", async () => {
    const first = await login(tc.seed.alice.email, PASSWORD);
    await logout({ sid: first.sid });

    const second = await login(tc.seed.alice.email, PASSWORD);
    assert.equal(second.status, 200);
    assert.ok(second.sid);
    assert.notEqual(second.sid, first.sid, "re-login issues a different session token");

    const rows = await tc.sudoDb
      .select()
      .from(tc.schema.sessions)
      .where(eq(tc.schema.sessions.userId, tc.seed.alice.id));
    assert.equal(rows.length, 1, "only the new session row survives");
    assert.equal(rows[0].token, second.sid);
  });
});
