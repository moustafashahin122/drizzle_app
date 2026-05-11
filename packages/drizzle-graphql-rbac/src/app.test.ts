/**
 * `createApp` security-surface tests for the GraphQL endpoint:
 *  - introspection gating (`graphqlAllowIntrospection`)
 *  - HTTP-layer auth gate    (`graphqlRequireAuth`)
 *
 * Both options ride on the same `app.fetch` path, so each case builds a real
 * `createApp` over an in-memory sqlite (framework schema only — no app tables
 * needed for these contracts) and hits `/graphql` through Hono.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";

import { createApp } from "./app.js";
import { users, sessions } from "./tables.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./graphql/rbac/config.js";

const frameworkSchema = { users, sessions } as Record<string, unknown> & {
  users: typeof users;
  sessions: typeof sessions;
};

const FRAMEWORK_DDL = `
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
`;

const emptyRbac = {
  roles: defineRoles({ user: {} }),
  accessRights: defineAccessRights({ user: { users: { read: true } } }),
  recordRules: defineRecordRules({}),
};

function buildApp(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const sqlite = new Database(":memory:");
  sqlite.exec(FRAMEWORK_DDL);
  const db = drizzle(sqlite);
  const { app, rbac, sudoDb } = createApp({
    db,
    schema: frameworkSchema,
    rbac: emptyRbac,
    publicDir: null,
    logger: false,
    ...overrides,
  });
  return { app, rbac, sudoDb, sqlite };
}

async function seedAndLogin(
  app: ReturnType<typeof buildApp>["app"],
  sudoDb: ReturnType<typeof buildApp>["sudoDb"],
  rbac: ReturnType<typeof buildApp>["rbac"],
): Promise<string> {
  const passwordHash = await bcrypt.hash("pw", 4);
  const [u] = await sudoDb
    .insert(users)
    .values({ name: "Alice", email: "alice@x.com", passwordHash, active: true })
    .returning();
  rbac.assignRole(u.id, "user");
  const res = await app.fetch(
    new Request("http://t.local/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@x.com", password: "pw" }),
    }),
  );
  const list: string[] =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  const sid = list.map((c) => c.split(";")[0])
    .find((c) => c.startsWith("sid="))
    ?.slice(4);
  if (!sid) throw new Error("login failed: no sid cookie");
  return sid;
}

async function gql(
  app: ReturnType<typeof buildApp>["app"],
  query: string,
  opts: { token?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.fetch(
    new Request("http://t.local/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    }),
  );
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  return { status: res.status, body };
}

describe("createApp — graphqlRequireAuth (HTTP-layer auth gate)", () => {
  it("rejects anonymous /graphql with 401 and a plain JSON error envelope (no parse)", async () => {
    const { app } = buildApp(); // default: auth required
    // Use an obviously invalid query body — proves the parser is NOT reached:
    // a non-auth-gated endpoint would respond with a GraphQL validation error.
    const { status, body } = await gql(app, "this is not graphql syntax");
    assert.equal(status, 401);
    assert.deepEqual(body, { error: "Authentication required" });
  });

  it("allows authenticated /graphql through to the resolver layer", async () => {
    const { app, sudoDb, rbac } = buildApp();
    const sid = await seedAndLogin(app, sudoDb, rbac);
    const { status, body } = await gql(app, `{ users { id name } }`, { token: sid });
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(Array.isArray(body.data?.users), true);
    assert.equal(body.data.users.length, 1);
    assert.equal(body.data.users[0].name, "Alice");
  });

  it("opt-out (graphqlRequireAuth=false) lets anonymous traffic reach resolvers (RBAC then denies)", async () => {
    const { app } = buildApp({ graphqlRequireAuth: false });
    const { status, body } = await gql(app, `{ users { id } }`);
    // Resolver-layer RBAC takes over: the request parses + validates, then
    // enforce throws "Not authenticated" inside the resolver. The shape is a
    // GraphQL errors[] envelope, not the HTTP-layer JSON error.
    assert.equal(status, 200);
    assert.equal(body.data?.users ?? null, null);
    assert.equal(body.errors?.length, 1);
    assert.match(body.errors[0].message, /Not authenticated/i);
  });
});

describe("createApp — graphqlAllowIntrospection", () => {
  const INTROSPECTION_Q = `{ __schema { types { name } } }`;

  it("allowed (default in non-production): __schema returns type names", async () => {
    const { app, sudoDb, rbac } = buildApp();
    const sid = await seedAndLogin(app, sudoDb, rbac);
    const { status, body } = await gql(app, INTROSPECTION_Q, { token: sid });
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const names: string[] = body.data.__schema.types.map((t: any) => t.name);
    // Pin a couple of expected types — proves we got a real schema, not an
    // empty stub or a silent-success placeholder.
    assert.ok(names.includes("Users"), "expected Users in introspected types");
    assert.ok(names.includes("Query"), "expected Query in introspected types");
  });

  it("disabled: __schema is rejected at validation time with GraphQL errors[]", async () => {
    const { app, sudoDb, rbac } = buildApp({ graphqlAllowIntrospection: false });
    const sid = await seedAndLogin(app, sudoDb, rbac);
    const { status, body } = await gql(app, INTROSPECTION_Q, { token: sid });
    assert.equal(status, 200, "validation error returns 200 + errors[], not HTTP 4xx");
    assert.equal(body.data ?? null, null);
    // graphql-js may emit more than one introspection-rejection error per
    // selection path (one per `__schema` / `__type` reference). Assert at
    // least one and that every emitted error is the introspection-disabled
    // variety — leaks of unrelated error categories would be a regression.
    assert.ok((body.errors?.length ?? 0) >= 1, "expected at least one validation error");
    for (const e of body.errors) {
      assert.match(
        e.message,
        /introspection/i,
        `every error should be the introspection-rejected variety; got: "${e.message}"`,
      );
    }
  });

  it("disabled: non-introspection queries still work (validation rule is targeted)", async () => {
    const { app, sudoDb, rbac } = buildApp({ graphqlAllowIntrospection: false });
    const sid = await seedAndLogin(app, sudoDb, rbac);
    const { status, body } = await gql(app, `{ users { id name } }`, { token: sid });
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.users.length, 1);
    assert.equal(body.data.users[0].name, "Alice");
  });

  it("disabled: GraphiQL HTML/JS page is not served (GET /graphql does not render GraphiQL)", async () => {
    const { app, sudoDb, rbac } = buildApp({ graphqlAllowIntrospection: false });
    const sid = await seedAndLogin(app, sudoDb, rbac);
    // GET /graphql with an Accept that would otherwise yield the IDE page.
    const res = await app.fetch(
      new Request("http://t.local/graphql", {
        method: "GET",
        headers: { accept: "text/html", cookie: `sid=${sid}` },
      }),
    );
    const text = await res.text();
    assert.ok(
      !text.toLowerCase().includes("<title>yoga graphiql</title>") &&
        !text.toLowerCase().includes("graphiql"),
      `GraphiQL must not be served when introspection is off — got: ${text.slice(0, 120)}`,
    );
  });
});

/**
 * Login helper that returns BOTH the sid token and the non-HttpOnly
 * `csrf_token` cookie value from the login response. Mirrors the existing
 * `seedAndLogin` shape but exposes the CSRF cookie needed for double-submit
 * tests below.
 */
async function seedAndLoginWithCsrf(
  app: ReturnType<typeof buildApp>["app"],
  sudoDb: ReturnType<typeof buildApp>["sudoDb"],
  rbac: ReturnType<typeof buildApp>["rbac"],
): Promise<{ sid: string; csrf: string }> {
  const passwordHash = await bcrypt.hash("pw", 4);
  const [u] = await sudoDb
    .insert(users)
    .values({ name: "Alice", email: "alice@x.com", passwordHash, active: true })
    .returning();
  rbac.assignRole(u.id, "user");
  const res = await app.fetch(
    new Request("http://t.local/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@x.com", password: "pw" }),
    }),
  );
  const list: string[] =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  const pairs = list.map((c) => c.split(";")[0]);
  const sid = pairs.find((c) => c.startsWith("sid="))?.slice(4);
  const csrf = pairs.find((c) => c.startsWith("csrf_token="))?.slice("csrf_token=".length);
  if (!sid) throw new Error("login failed: no sid cookie");
  if (!csrf) throw new Error("login failed: no csrf_token cookie");
  return { sid, csrf };
}

describe("createApp — CSRF protection on /graphql", () => {
  const Q = `{ users { id name } }`;

  // Table-driven: three cookie-based CSRF cases share the same login + POST
  // /graphql shape — only the X-CSRF-Token header varies.
  // - setHeader=false: header is omitted entirely.
  // - headerValue="MATCH": header value === csrf cookie value.
  // - headerValue="WRONG": header value is a deliberately different string.
  it("CSRF cookie-path per (setHeader, headerValue, expectStatus)", async (t) => {
    const cases: Array<{
      name: string;
      setHeader: boolean;
      headerValue: "MATCH" | "WRONG" | undefined;
      expectStatus: 200 | 403;
    }> = [
      { name: "missing header",  setHeader: false, headerValue: undefined, expectStatus: 403 },
      { name: "matching header", setHeader: true,  headerValue: "MATCH",   expectStatus: 200 },
      { name: "mismatched",      setHeader: true,  headerValue: "WRONG",   expectStatus: 403 },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { app, sudoDb, rbac } = buildApp();
        const { sid, csrf } = await seedAndLoginWithCsrf(app, sudoDb, rbac);
        const headers: Record<string, string> = {
          "content-type": "application/json",
          cookie: `sid=${sid}; csrf_token=${csrf}`,
        };
        if (c.setHeader) {
          headers["x-csrf-token"] = c.headerValue === "MATCH" ? csrf : "not-the-real-token";
        }
        const res = await app.fetch(
          new Request("http://t.local/graphql", {
            method: "POST",
            headers,
            body: JSON.stringify({ query: Q }),
          }),
        );
        assert.equal(res.status, c.expectStatus);
        const body = await res.json();
        if (c.expectStatus === 403) {
          // Pin the rejection envelope so a 403 from any other source (rate
          // limit, auth gate, generic error handler) is distinguishable.
          assert.deepEqual(body, { error: "CSRF token missing or invalid" });
        } else {
          // Strengthened: ensure the resolver actually ran and produced data,
          // not a degenerate {data:null} 200 that would also pass status==200.
          assert.equal(body.errors, undefined);
          assert.ok(Array.isArray(body.data?.users), "expected data.users array");
          assert.equal(body.data.users[0].name, "Alice");
        }
      });
    }
  });

  it("bypasses CSRF for bearer-token requests with no session cookie", async () => {
    const { app, sudoDb, rbac } = buildApp();
    // Use the existing cookie-less login helper to grab a token usable as Bearer.
    const sid = await seedAndLogin(app, sudoDb, rbac);
    const { status, body } = await gql(app, Q, { token: sid });
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.users[0].name, "Alice");
  });
});

describe("createApp — default hiddenOutputColumns", () => {
  // Table-driven: each case asserts that the default schema rejects a
  // sensitive column as an unknown field on its output type. Same flow for
  // every row: login, run a query selecting the banned field, expect a
  // validation error envelope that mentions both the field and its type.
  it("default schema hides sensitive columns per (query, bannedField, typeName)", async (t) => {
    const cases: Array<{ query: string; bannedField: string; typeName: RegExp }> = [
      { query: `{ sessions { id token } }`,     bannedField: "token",        typeName: /Sessions/ },
      { query: `{ users { id passwordHash } }`, bannedField: "passwordHash", typeName: /Users/ },
    ];
    for (const c of cases) {
      await t.test(`${c.bannedField} not selectable`, async () => {
        const { app, sudoDb, rbac } = buildApp();
        const sid = await seedAndLogin(app, sudoDb, rbac);
        const { status, body } = await gql(app, c.query, { token: sid });
        assert.equal(status, 200, "validation error returns 200 + errors[]");
        assert.equal(body.data ?? null, null);
        assert.ok((body.errors?.length ?? 0) >= 1);
        // At least one error must mention the banned field by name — guards
        // against a regression that renames the column but still surfaces it.
        assert.ok(
          body.errors.some((e: any) => new RegExp(c.bannedField, "i").test(e.message)),
          `expected an error mentioning "${c.bannedField}"; got: ${JSON.stringify(body.errors)}`,
        );
        assert.match(body.errors[0].message, c.typeName);
      });
    }
  });
});

// Suppress the unused-import lint for `sql` — it's here as a hedge in case
// future cases need a raw SQL fragment in the framework schema setup.
void sql;
