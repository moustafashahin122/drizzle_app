# `drizzle-graphql-rbac/testing`

Reusable test fixtures published by the framework. Three files, two audiences:

- **`base.ts`** — low-level plumbing. Shared in-memory sqlite, SAVEPOINT-based suite/test isolation, drizzle-kit schema push, and `jsonFetch` + cookie helpers for hitting any Hono app. No opinions about schema, RBAC, or auth.
- **`app_testing.ts`** — host-app harness. Given a `createApp({...})` config, `createAppTestHarness` returns `{ setupAppTestCase, createUser }` so app suites get a fully wired app (GraphQL schema, RBAC engine, session minting, role assignment) over the shared sqlite handle.
- **`framework_testing.ts`** — internal helpers for the framework's own auth / admin / persistence / builder tests. **Not** re-exported from `index.ts`; host apps should not import it.

Public surface is `index.ts`:

```ts
import {
  getSharedSqlite,
  transactionCase,
  pushDrizzleSchema,
  cookieValue,
  jsonFetch,
  createAppTestHarness,
} from "drizzle-graphql-rbac/testing";
```

## `base.ts`

| Export | Purpose |
| --- | --- |
| `getSharedSqlite()` | Process-wide singleton `:memory:` better-sqlite3 handle. Lazy on first call. |
| `pushDrizzleSchema(sqlite, schema)` | Materialize a Drizzle namespace via `drizzle-kit/api`. Idempotent. Enables `PRAGMA foreign_keys = ON`. |
| `transactionCase(setUpClass)` | Nested-SAVEPOINT suite fixture (see below). Returns a `Proxy` over the ctx your `setUpClass` produced. |
| `jsonFetch(app, method, path, opts)` | Fire a request at any Hono-like app; returns `{ status, body, setCookies }`. Auto-JSON, bearer/cookie shortcuts. |
| `cookieValue(list, name)` | Pull a single cookie value out of a `Set-Cookie` list, or `null`. |

### `transactionCase` lifecycle

```
before:     SAVEPOINT suite_n;   setUpClass() seeds reference data
beforeEach: SAVEPOINT test_m;
afterEach:  ROLLBACK TO test_m;  RELEASE
after:      ROLLBACK TO suite_n; RELEASE
```

Only SQL state is rolled back — in-process state (e.g. in-memory caches) is the suite's responsibility to reset. The returned `Proxy` reads through to the live ctx; accessing fields **before** `setUpClass` ran throws. This means you must read `tc.foo` inside `it` bodies, not at module scope.

## `app_testing.ts`

`createAppTestHarness(appConfig)` is the entry point. Call it once at test-module load time with the same options you'd pass to `createApp` (minus `db`). It returns:

```ts
{
  setupAppTestCase(setUp?): AppTestCtx<Schema, Seed>;
  createUser(sudoDb, { name, email, password? }): Promise<User>;
}
```

The app is built once per process on the first call to `setupAppTestCase`:

1. Grabs `getSharedSqlite()` and pushes `appConfig.schema` via `pushDrizzleSchema`.
2. Calls `createApp({ db, ...appConfig, publicDir: null, logger: false })` — real production wiring.
3. Rebuilds the GraphQL schema via `buildSchema` for direct (`graphql()`) invocation, sharing the live `rbac.enforce` hook.

Tests get isolation from the SAVEPOINT fixture, not from rebuilding.

`setupAppTestCase(setUp)` wraps `transactionCase` and hands each test the following ctx (via the `tc` proxy):

| Field | Notes |
| --- | --- |
| `sudoDb` | Raw Drizzle handle — **bypasses RBAC**. Use for fixture seeding and post-condition checks. |
| `app` | The Hono app. Call `app.fetch(new Request(...))` directly, or use `runHttp`. |
| `schema` | The schema namespace you passed in. |
| `assignRole(userId, name \| null)` | DB-backed role assignment (writes `users.role_id`). Rolled back by savepoints. |
| `runHttp(query, { asUserId?, variables? })` | Full Hono stack — session middleware → RBAC → resolvers. `asUserId` mints a bearer token. |
| `runDirect(query, { user?, variables? })` | Direct `graphql()` call with synthetic context. Faster, but skips auth/middleware wiring. |
| `seed` | Whatever your `setUp` returned. |

### Typical host-app wiring

In the host app's `src/testing/appTestCase.ts` (or equivalent):

```ts
import { createAppTestHarness } from "drizzle-graphql-rbac/testing";
import * as schema from "../schema.js";
import { rbac } from "../rbacConfig.js";

export const { setupAppTestCase, createUser } =
  createAppTestHarness({ schema, rbac });
```

And in a suite:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupAppTestCase, createUser } from "./appTestCase.js";

describe("todos", () => {
  const tc = setupAppTestCase(async ({ sudoDb, assignRole }) => {
    const alice = await createUser(sudoDb, { name: "Alice", email: "a@x" });
    await assignRole(alice.id, "user");
    return { alice };
  });

  it("alice can list her own todos", async () => {
    const { status, body } = await tc.runHttp(
      `{ todos { id title } }`,
      { asUserId: tc.seed.alice.id },
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.data.todos));
  });
});
```

## `framework_testing.ts` (internal)

Used by the framework's own tests. Each helper makes a **fresh** `:memory:` sqlite — no shared singleton, no SAVEPOINT magic.

| Export | Purpose |
| --- | --- |
| `frameworkSchema` | `{ roles, users, sessions }` — the framework-owned tables. |
| `FrameworkDb` | `BetterSQLite3Database<typeof frameworkSchema>`. |
| `freshFrameworkDb()` | New `:memory:` sqlite with the framework DDL applied. Returns `{ sqlite, db }`. |
| `wipeFrameworkTables(db)` | Delete every `users` / `sessions` row. (`roles` is code-defined.) |
| `seedUser(db, { name, email, password?, active? })` | Insert a user with a bcrypt'd password. |
| `seedUserWithRole(db, attrs & { role })` | `seedUser` + `setUserRole`. |
| `loginViaHttp(authApp, email, password)` | POST `/login` and return the `sid` cookie value. |
| `buildFrameworkApp(db, overrides?)` | Full `createApp` over the framework schema with a minimal `admin` + `user` RBAC. |
| `makeBuilderFixture({ tables, seed?, builder?, countQueries? })` | Isolated sqlite + schema push + typed `run` for builder tests. |

## Notes & gotchas

- **One sqlite handle for the whole process.** All suites that go through `createAppTestHarness` share it; isolation comes from SAVEPOINTs, not separate databases. If you need a truly isolated DB (e.g. for the builder fixture's `countQueries` mode) construct a fresh `new Database(":memory:")` and push your schema onto it directly — that's what `makeBuilderFixture` does.
- **`sudoDb` bypasses RBAC.** Don't use it to assert RBAC semantics — use `runHttp` or `runDirect` for that.
- **Role assignments are DB-backed** (`users.role_id` → `roles.id`), so they're rolled back by the same savepoints as every other write. There is no separate in-memory-membership reset to do.
- **`framework_testing.ts` is intentionally not re-exported.** Host apps should never import it; it exists for the framework's own auth/admin/persistence/builder tests and uses fresh per-test DBs rather than the shared singleton.
