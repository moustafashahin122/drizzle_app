/**
 * `createApp` security-surface tests for the GraphQL endpoint:
 *  - HTTP-layer auth gate: anonymous /graphql is 401'd before parse.
 *  - Introspection: admin-only at validation time.
 *
 * Each case builds a real `createApp` over an in-memory sqlite (framework
 * schema only — no app tables needed for these contracts) and hits `/graphql`
 * through Hono.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CreateAppOptions } from "./app.js";
import { cookieValue, jsonFetch } from "./testing/base.js";
import {
  buildFrameworkApp,
  freshFrameworkDb,
  seedUserWithRole,
} from "./testing/framework_testing.js";

type BuiltApp = Awaited<ReturnType<typeof buildFrameworkApp>>;

/** Fresh DB + fresh createApp wired for each test — supports the option matrix. */
async function buildApp(
  overrides: Partial<Omit<CreateAppOptions, "db" | "schema" | "rbac">> = {},
): Promise<BuiltApp> {
  const db = (await freshFrameworkDb()).db;
  return buildFrameworkApp(db, overrides);
}

/**
 * Seed a user (default role: `user`, "pw" password) and return the `sid`
 * cookie value. Uses the full app's `/auth/login` so CSRF + middleware run.
 */
async function seedAndLogin(
  built: BuiltApp,
  opts: { role?: string; email?: string; name?: string } = {},
): Promise<string> {
  const role = opts.role ?? "user";
  const email = opts.email ?? "alice@x.com";
  const name = opts.name ?? "Alice";
  await seedUserWithRole(built.db, { name, email, password: "pw", role });
  const r = await jsonFetch(built.app, "POST", "http://t.local/auth/login", {
    body: { email, password: "pw" },
  });
  const sid = cookieValue(r.setCookies, "sid");
  if (!sid) throw new Error("login failed: no sid cookie");
  return sid;
}

async function gql(
  app: BuiltApp["app"],
  query: string,
  opts: { token?: string } = {},
): Promise<{ status: number; body: any }> {
  return jsonFetch(app, "POST", "http://t.local/graphql", {
    body: { query },
    bearer: opts.token,
  });
}

describe("createApp — /graphql always requires auth", () => {
  it("rejects anonymous /graphql with 401 and a plain JSON error envelope (no parse)", async () => {
    const { app } = await buildApp();
    // Use an obviously invalid query body — proves the parser is NOT reached:
    // a non-auth-gated endpoint would respond with a GraphQL validation error.
    const { status, body } = await gql(app, "this is not graphql syntax");
    assert.equal(status, 401);
    assert.deepEqual(body, { error: "Authentication required" });
  });

  it("allows authenticated /graphql through to the resolver layer", async () => {
    const built = await buildApp();
    const { app } = built;
    const sid = await seedAndLogin(built);
    const { status, body } = await gql(app, `{ users { id name } }`, { token: sid });
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(Array.isArray(body.data?.users), true);
    assert.equal(body.data.users.length, 1);
    assert.equal(body.data.users[0].name, "Alice");
  });
});

describe("createApp — introspection is admin-only", () => {
  const INTROSPECTION_Q = `{ __schema { types { name } } }`;

  it("admin can introspect", async () => {
    const built = await buildApp();
    const { app } = built;
    const sid = await seedAndLogin(built, {
      role: "admin",
      email: "admin@x.com",
      name: "Admin",
    });
    const { status, body } = await gql(app, INTROSPECTION_Q, { token: sid });
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const names: string[] = body.data.__schema.types.map((t: any) => t.name);
    // Pin a couple of expected types — proves we got a real schema, not an
    // empty stub or a silent-success placeholder.
    assert.ok(names.includes("Users"), "expected Users in introspected types");
    assert.ok(names.includes("Query"), "expected Query in introspected types");
  });

  it("non-admin is rejected by the introspection validation rule", async () => {
    // Introspection reveals the full schema shape (including names of hidden
    // columns), so it is hard-gated to admins.
    const built = await buildApp();
    const { app } = built;
    const sid = await seedAndLogin(built); // default role: "user"
    const { status, body } = await gql(app, INTROSPECTION_Q, { token: sid });
    assert.equal(status, 200);
    assert.equal(body.data ?? null, null);
    assert.ok((body.errors?.length ?? 0) >= 1, "expected validation error");
    for (const e of body.errors) {
      assert.match(e.message, /introspection/i);
    }
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
        const built = await buildApp();
    const { app } = built;
        const sid = await seedAndLogin(built);
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

describe("createApp — CSRF protection (origin gate via hono/csrf)", () => {
  /** POST helper for the integration cases — picks the content-type per call. */
  async function post(
    app: ReturnType<typeof buildApp>["app"],
    contentType: string,
    headers: Record<string, string> = {},
  ): Promise<number> {
    const rawBody =
      contentType.startsWith("application/x-www-form-urlencoded") ? "a=1" :
      contentType.startsWith("multipart/form-data") ? "--xxx--" :
      contentType.startsWith("application/json") ? "{}" : "hi";
    const r = await jsonFetch(app, "POST", "http://app.localhost/auth/login", {
      rawBody, contentType, headers,
    });
    return r.status;
  }

  it("default config blocks foreign-origin form POSTs (403) and lets JSON through", async () => {
    const { app } = await buildApp();
    // Form-encoded from an attacker origin → blocked.
    assert.equal(
      await post(app, "application/x-www-form-urlencoded", { origin: "http://evil.example" }),
      403,
    );
    // JSON is never inspected — proves only the form-submission hole is gated.
    // (Bad credentials → 401, but crucially NOT 403 from the CSRF layer.)
    assert.notEqual(
      await post(app, "application/json", { origin: "http://evil.example" }),
      403,
    );
  });

  it("default config allows same-origin form POSTs (passes through to the route handler)", async () => {
    const { app } = await buildApp();
    // Same-origin form POST should reach the auth route — which then returns
    // 400 (missing fields) since the form body isn't a valid login payload.
    // The point is that CSRF did NOT short-circuit with 403.
    const status = await post(app, "application/x-www-form-urlencoded", {
      origin: "http://app.localhost",
    });
    assert.notEqual(status, 403);
  });

  it("csrf: { origin: <allowlist> } gates by exact match", async () => {
    const { app } = await buildApp({ csrf: { origin: "https://trusted.example" } });
    assert.equal(
      await post(app, "application/x-www-form-urlencoded", { origin: "https://trusted.example" }),
      // Trusted origin: reaches the route → 400 missing fields.
      400,
    );
    assert.equal(
      await post(app, "application/x-www-form-urlencoded", { origin: "https://other.example" }),
      403,
    );
  });

  it("csrf: false disables protection (foreign-origin form POST reaches the route)", async () => {
    const { app } = await buildApp({ csrf: false });
    // Without CSRF, even an evil-origin form POST is forwarded — auth then
    // 400s on the malformed body, proving the request was not blocked at 403.
    assert.equal(
      await post(app, "application/x-www-form-urlencoded", { origin: "http://evil.example" }),
      400,
    );
  });
});

