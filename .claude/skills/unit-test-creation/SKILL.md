---
name: unit-test-creation
description: |
  Writes new unit and integration tests for this repo from scratch — covering every component class with no exceptions: pure helpers, Drizzle schema/relations, the hand-rolled GraphQL builder (`builder.ts`, `filters.ts`, `relations.ts`), GraphQL queries and mutations end-to-end, the in-memory RBAC engine (`roles`, `accessRights`, `recordRules`), the auth Hono routes and session helpers, the admin dashboard routes, `createApp` wiring, CLI/seed scripts, and schema-level invariants like FK relation promotion and column-vs-relation behavior. Calibrated for `node:test` + `node:assert/strict` + `better-sqlite3` in-memory DBs (per-file or shared via `drizzle-graphql-rbac/testing#transactionCase`) and the in-process GraphQL/Hono surfaces. Use whenever the user asks to add, generate, write, scaffold, expand, fill in, or "cover" tests for code in this repo — including phrases like "write tests for X", "add coverage", "test this module", "I need unit tests", "TDD this", "fixture this". Do NOT use to refactor or dedupe existing tests — that is the [[test-suite-refactor]] skill.
---

# Unit-test creation

Writes **new** tests in this repo. Goal: comprehensive, deterministic, behavior-focused coverage for every component, asserting outcomes and side effects — not implementation details.

For pruning/merging an existing suite, use the sibling skill `test-suite-refactor` instead.

## Stack assumptions (this repo)

- **Runner**: Node's built-in `node:test` via `tsx`, invoked by `npm test`. The `drizzle-graphql-rbac` workspace's `test` script globs `src/**/*.test.ts` across `auth/`, `admin/`, `graphql/builder/`, `graphql/rbac/`, `graphql/domain/`. New test files MUST land under one of those globs or extend the script.
- **Assertions**: `node:assert/strict` — `assert.equal`, `assert.deepEqual`, `assert.ok`, `assert.rejects`, `assert.match`. No chai/jest.
- **DB**: `better-sqlite3` in-memory (`new Database(":memory:")`) + `drizzle-orm/better-sqlite3`. Two valid styles, see "Choosing a DB fixture" below. Never import `src/db.ts` or `src/sudoDb.ts` from a test — those are runtime singletons backed by `todo.db`.
- **GraphQL**: drive end-to-end through `graphql({ schema, source, contextValue, variableValues })` against a schema built by `buildSchema(...)` from `packages/drizzle-graphql-rbac/src/graphql/builder/`. Treat the GraphQL response (`data` / `errors`) as the contract — do not poke into builder internals.
- **RBAC**: build with `buildRbac(...)` from `defineRoles` / `defineAccessRights` / `defineRecordRules`. The `admin` role is framework-injected and bypasses every rule; declaring `admin` in app config throws at startup, so any test that exercises this must `assert.throws`.
- **HTTP**: Hono apps are tested by calling `app.request(path, { method, headers, body })` — no live socket. The auth and admin sub-apps both follow this pattern.
- **Column-vs-relation rule**: a single-column FK (e.g. `todos.assigneeId`) is replaced by a relation field on the **output** type. The scalar remains usable inside `where` / `set` / Insert / Update inputs. Tests must cover both halves explicitly when relevant.

## When to use vs. when not to

Use this skill when the user wants to **write new tests** — green-field coverage, TDD on a new module, filling a gap pointed at by a bug, or scaffolding the test file for a freshly added component.

Do NOT use this skill to: refactor existing tests (`test-suite-refactor`), debug a failing test, or change product code. If the user asks for "tests for X" and X already has a test file, read it first — extending may be a refactor task, not a creation task.

## Operating principles

- **Behavior over implementation.** Assert what the user / API caller observes (GraphQL response, HTTP response, DB rows, thrown error category). Do not assert on intermediate builder maps, private functions, or stringified internal types.
- **End-to-end where it's cheap.** This repo's GraphQL and Hono apps are constructible in-process against in-memory SQLite. Prefer wiring the real component and asserting the real response over mocking. Reach for pure-unit tests only when the function is a pure translator (`whereToSql`, `orderByToSql`) or when an integration test would obscure the contract.
- **Both sides of every boundary.** Allow AND deny for RBAC. Success AND error shapes for GraphQL/HTTP. Forward AND inverse relation traversal. Happy path AND null/empty/boundary inputs.
- **Cardinality first, identity second, isolation third.** Before indexing into a result, assert `length === N`. Then assert the full identifying tuple of each row. Then assert that rows you did *not* touch are unchanged.
- **Deterministic by construction.** Each suite owns its DB state. No shared mutable fixtures across files unless using `transactionCase` (which rolls back per-test). No `Date.now()`, `Math.random()`, or wall-clock comparisons without a stable seed or explicit tolerance.
- **One coherent flow per `it`.** Arrange (minimal), Act (one action), Assert (outcomes + side effects + isolation). Multi-step scenarios live in `t.test` subtests or a `describe` block, not in a single mega-`it`.

## Workflow

### 1) Map the component and identify every invariant it claims

Before writing a single `it`, read the source file(s) under test and enumerate:

- **Inputs**: arguments, request bodies, GraphQL variables, DB state preconditions, RBAC context.
- **Outputs**: return value, GraphQL `data` / `errors`, HTTP `status` / `body` / `Set-Cookie`, thrown errors.
- **Side effects**: DB rows inserted/updated/deleted, session cookies set/cleared, RBAC memberships changed, in-memory caches mutated, logs/PII emitted.
- **Branches**: every `if`, every early return, every `throw`, every RBAC role path.
- **Invariants**: contractual claims the module makes — "admin bypasses record rules", "delete cascades to sessions", "rate limiter rejects after N requests", "FK promotion replaces scalar on output only", etc.

Write this list down as a table — it becomes the test plan.

```markdown
| Invariant | Inputs | Expected outcome | Side effects | Test name |
|-----------|--------|------------------|--------------|-----------|
| login: valid creds → 200 + session cookie | POST /login {email, password} | 200, body.user.id, Set-Cookie session=… | row in sessions | auth__login__valid_credentials_issues_session |
| login: bad password → 401, no cookie, no session row | … | 401, body.error | sessions row count unchanged | auth__login__bad_password__rejects |
```

Each row becomes one test. **No invariant goes uncovered.** If the source has 14 branches and the plan has 6 rows, the plan is incomplete.

### 2) Pick the test layer

Decide per invariant; a single file may mix layers.

- **Pure unit** — when the unit is a side-effect-free function over data (e.g. translators in `filters.ts`, `parseSessionCookie`, slug helpers). Import the function directly, feed values, assert the return.
- **Module integration** — when the unit is glued to a DB or another module but is not the public surface (e.g. a Drizzle query helper, an RBAC engine method, a relation builder). Construct the minimum surrounding state (in-memory SQLite + a tiny schema) and call the function.
- **End-to-end (in-process)** — when the contract under test is the public response shape (GraphQL `data`/`errors`, Hono `Response`). Build the full schema/app and exercise it through `graphql(...)` or `app.request(...)`. This is the default for anything in `graphql/` or `auth/` or `admin/`.

Bias toward the **highest layer at which the invariant is visible**. A record-rule test belongs at the GraphQL layer, not at the engine layer — the engine layer is the implementation detail.

### 3) Pick a DB fixture

Two valid patterns in this repo. Choose by suite, not per-test.

#### A) Per-file `:memory:` (default for new files)

Each test file constructs its own sqlite handle, applies a minimal DDL inline, builds the module under test, and uses Node's `before` / `beforeEach` to reset state. Used by `filters.test.ts`, `auth.test.ts`, `admin.test.ts`.

```ts
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

let db: ReturnType<typeof drizzle>;
before(() => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE ...`);
  db = drizzle(sqlite);
});
beforeEach(() => { /* delete-all or re-seed */ });
```

Use this when the suite needs an unusual schema, needs to mutate cross-test state aggressively (e.g. rate limiter, RBAC memberships), or doesn't share fixtures with siblings.

#### B) Shared `transactionCase` fixture

`drizzle-graphql-rbac/testing` owns one process-wide `:memory:` handle and gives you nested SAVEPOINTs — suite-level around setup, test-level around each `it` — so reference data is built once and per-test mutations roll back automatically.

```ts
import { transactionCase, getSharedSqlite, applySchemaSql } from "drizzle-graphql-rbac/testing";

applySchemaSql(`CREATE TABLE IF NOT EXISTS ...`);

const tc = transactionCase(async () => {
  const sqlite = getSharedSqlite();
  // seed reference rows, build rbac, build schema, return ctx
  return { db, schema, rbac, alice, bob };
});

it("…", () => { tc.db.insert(...); /* rolled back automatically */ });
```

Use this when several suites share a schema and seed shape, when seed cost is non-trivial, or when you want Odoo-style "reference data" semantics. **Caveat**: only **SQL state** rolls back. RBAC role memberships and any other in-process state must be reset explicitly (`clearAllRbacMemberships`, or revoke in `afterEach`). Tests must not destructure ctx at module scope — the Proxy throws until `before` runs.

### 4) Write the tests, component by component

Below is a playbook per component. Every component in the repo appears here; if a new component is added, slot it in under the closest analog.

#### 4.a Pure helpers (`filters.ts` translators, `session.ts#parseSessionCookie`, slug/format helpers)

- Import the function directly. No DB needed.
- Cover: null/undefined input, empty inputs, single-element happy path, multi-element happy path, unknown-key behavior (silently dropped vs. thrown), the documented operator matrix (`eq, ne, lt, lte, gt, gte, inArray, notInArray, like, ilike, notLike, notIlike, isNull`, `AND`/`OR`/`NOT`).
- Assert the return shape, not the internal SQL text. If you must inspect SQL fragments, assert structural properties (length, operator presence) rather than full strings.

#### 4.b Drizzle schema and table declarations (`src/schema.ts`, `tables.ts`)

- Build a sqlite, apply DDL that mirrors the Drizzle declaration, insert a row using the Drizzle table, read it back, assert column types and defaults round-trip.
- Cover FK declarations by inserting a child row that points at an existing parent, and a child that points at a missing parent (with `PRAGMA foreign_keys=ON;` if the suite asserts FK enforcement).
- For `notNull` / `default` / `generated` columns, assert what happens when the field is omitted from the insert object — the row should still materialize with the declared default.

#### 4.c GraphQL builder (`builder.ts`)

- Build a schema from a tiny 1-2 table Drizzle namespace. Print/inspect it via `schema.getType("Foo")` and `objectType.getFields()`.
- For each table assert: object type exists; Insert input exists with required = `notNull && !hasDefault && !generated`; Update input has all fields optional; Where input exposes the documented operators per scalar; OrderBy input has one direction enum per column.
- For each root field: `<jsKey>`, `<jsKey>Single`, `insertInto<Type>`, `insertInto<Type>Single`, `update<Type>`, `deleteFrom<Type>` are wired and have the expected argument names.
- Smoke-test cyclic types: a self- or mutually-referential schema must resolve without throwing during build.

#### 4.d GraphQL filters and order-by (`filters.ts` end-to-end)

- Insert rows in a known order; query with `where` covering each operator on each scalar type the schema supports; assert returned ids equal the expected set in expected order.
- For `orderBy`, assert both order and length. Include a tie-break case if the schema permits one.
- For `limit`/`offset`, assert the page contents, the length, and that asking past the end returns `[]` (not an error).
- For combinators, assert one nested `AND`-of-`OR` case to lock in precedence.

#### 4.e Relation promotion (`relations.ts`)

- Build a schema with a single-column FK (`child.parentId → parent.id`). Insert one parent and several children.
- Assert the forward relation: `child { parentId { id name } }` returns the parent row.
- Assert the inverse relation: `parent { children { id } }` returns exactly the seeded child ids — no extras, no duplicates.
- Assert the column-vs-relation rule on **input**: `where: { parentId: { eq: 1 } }`, `set: { parentId: 2 }`, and `insertInto…Single(values: { parentId: 1, … })` all still accept the scalar.
- Assert composite FKs are skipped (no relation field appears).
- Assert that an explicit Drizzle `relations(...)` declaration **wins** over auto-promotion when both exist.

#### 4.f GraphQL queries (end-to-end through `graphql(...)`)

For every query field the builder emits:

- **Empty table** → returns `[]`, no errors.
- **Multiple rows** → returns all rows; assert `length` then full tuples.
- **`where` narrowing** → returns the matching subset; assert the *non*-matches are absent.
- **`orderBy` + `limit` + `offset`** → assert order and pagination edges.
- **Single variant** (`<jsKey>Single`) returns the first row or `null` (per builder contract) and respects the same `where`/`orderBy`.
- **Nested traversal** through a relation returns expected nested rows.

#### 4.g GraphQL mutations (end-to-end)

- **Insert**: send Insert input via `insertInto<Type>` and `insertInto<Type>Single`. Assert the `.returning()` payload's full tuple, then **read back from the DB directly** and assert the row landed. Trust neither GraphQL alone nor DB alone — assert both.
- **Update**: mutate a subset of columns. Assert returned rows have new values for touched columns and old values for untouched columns. Read the DB and assert untouched **other rows** weren't mutated.
- **Delete**: assert returned rows match the deleted set; assert post-state row count and that surviving rows are intact.
- **Required-field violations** and **type mismatches**: assert `errors` exists with a stable message substring; assert DB state is unchanged.

#### 4.h RBAC engine (`roles.ts`, `rbac.ts`)

- `defineRoles`: declaring `admin` throws at startup — assert with `assert.throws`. Declaring a role with empty/duplicate keys throws — cover each.
- `buildRbac`: returns an engine exposing `assignRole`, `revokeRole`, `listUserRoles`, and the resolution helpers used by the GraphQL layer. Assert membership round-trips: assign then list, revoke then list.
- `admin` is framework-injected: an unassigned admin user has no roles; an assigned admin user has exactly `["admin"]`.
- Multiple roles per user: assign two roles, assert union behavior in `listUserRoles`.

#### 4.i Access rights (`accessRights.ts`)

- For each role × table × CRUD bit declared in the app config, assert the engine returns the expected boolean.
- Assert that a role with no entry for a table denies all four operations (default-deny).
- Assert `admin` returns true for every operation on every table without an explicit entry.
- Assert flattening behavior: there is **no inheritance**; a role declared with grants on table A has no grants on table B unless explicitly declared.

#### 4.j Record rules (`recordRules.ts`)

For every rule, write tests that exercise it through the GraphQL layer (the engine layer is implementation detail). Each rule needs:

- **Allow path**: a user matching the rule sees / can mutate the targeted rows. Assert exact row ids returned, not just "non-empty".
- **Deny path**: a user not matching the rule sees zero filtered rows (queries) or gets a rejected mutation (assert the error category — usually `errors[0].message` substring).
- **Admin bypass**: an admin user sees / mutates every row regardless of the rule.
- **No-rule baseline**: when no rule is declared for a (role, table, op), behavior falls back to the access-rights bit only.

#### 4.k Auth routes (`auth/routes.ts`, `auth/session.ts`)

Drive through `app.request(...)` on the Hono sub-app built by `buildAuthRoutes`.

- **Register**: valid input → 201, user row exists with hashed password (NOT plaintext), `Set-Cookie` session value parses via `parseSessionCookie`, a `sessions` row exists for the user.
- **Register**: duplicate email → 4xx, no second user row, no new session.
- **Login**: valid creds → 200, new session row, cookie present.
- **Login**: wrong password → 401, no new session row, no cookie.
- **Login**: unknown email → 401 (same shape as wrong password; avoid leaking user existence — assert the response body equals the wrong-password body).
- **Logout**: with a valid cookie → cookie cleared (assert Max-Age=0 or empty value), session row removed.
- **Logout**: without a cookie → 4xx or no-op per the route contract; assert no DB mutation.
- **Session lookup** (`resolveSessionFromToken`): valid → returns user; expired → returns `null`; tampered → returns `null`. Cover the `parseSessionCookie` edge cases (missing `=`, empty value, multiple cookies with same name).
- **Rate limiting**: if the route uses `hono-rate-limiter`, make N+1 requests in a tight loop and assert request N+1 returns 429. Call `__resetRateLimitForTests` between cases so counters don't leak.
- **CSRF**: when CSRF protection is on, a request without/with-wrong CSRF token is rejected; a correctly-formed one passes. Cover both.

#### 4.l Admin dashboard routes (`admin/*.ts`)

Same `app.request(...)` pattern as auth. For each route:

- Unauthenticated request → 401/302 (whichever the route contract says), no DB mutation.
- Authenticated non-admin → 403, no DB mutation.
- Authenticated admin → success; assert response body and DB side effects (e.g. `/admin/users/:id/roles` add/remove → `rbac.listUserRoles` reflects the change).
- Invalid params (non-numeric id, unknown role key) → 4xx with stable error shape.

#### 4.m `createApp` wiring (`app.ts`)

- Build with a valid config → returns `{ app, schema, rbac }`. Assert each is the expected shape.
- Declaring `admin` in roles config → throws at `createApp` time (locks the framework invariant).
- A GraphQL query through `schema` reflects role memberships established via `rbac.assignRole` — covers that the engine snapshot the schema closes over is the same engine the caller holds (no accidental copy).

#### 4.n CLI / seed scripts (`bootstrapUsers.ts`, `seedDemo.ts`)

These are normally run as `npm run seed:demo` etc., but the modules are importable. Test the *functions*, not the process.

- `seedDemo` on an empty DB → seeds the three demo users + demo project/todos; assert row counts and identifying tuples.
- `seedDemo` on a DB that already has todos → upserts users, skips todos (one-shot). Assert idempotency: running twice produces the same final state.
- `bootstrapUsers` in `NODE_ENV=production` without `ADMIN_EMAIL`/`ADMIN_PASSWORD` → throws (or exits with a clear error). With both → upserts one admin row, then is idempotent on re-run.
- `bootstrapUsers` in dev → no-op; assert DB row count unchanged.

#### 4.o Server (`server.ts`)

The `serve(...)` boot is a side effect — don't exercise it directly. Instead test the role-seeding step `server.ts` performs after `createApp`: build the app, run the post-create seed function (extract one if needed), assert the well-known emails receive the expected role memberships.

### 5) Determinism, isolation, and side-effect hygiene

- **Time**: avoid `Date.now()` comparisons. If a row stores `createdAt`, assert the column **exists** and is non-empty, not its exact value — unless the test deliberately freezes time with an injected clock.
- **Random**: pass deterministic values into anything that would otherwise read from `crypto.randomUUID` / `Math.random`. If a token is generated internally, assert it matches a stable shape (`assert.match(token, /^[A-Za-z0-9_-]{32,}$/)`) rather than a literal.
- **Cross-test leakage**:
  - Per-file `:memory:` style: reset all mutated tables in `beforeEach`, or rebuild the sqlite handle. Rate limiters and other in-memory state need explicit resets.
  - `transactionCase` style: trust SQL rollback; reset RBAC memberships and any other non-DB caches manually.
- **Async**: every async route call is `await`ed. `assert.rejects` for expected throws, not try/catch with a flag.
- **Resource cleanup**: do not leave open sqlite handles per test in the per-file pattern; one handle per file in `before` is enough. `transactionCase` owns its handle for the process.

### 6) Assertion checklist (apply to every test that creates or mutates a row)

- [ ] **Cardinality** asserted (`rows.length === N`) before any indexing.
- [ ] **Identity** asserted: primary key plus the human-meaningful identifier(s) the invariant names.
- [ ] **Touched fields** all assert to expected values; **untouched fields** assert unchanged (read back).
- [ ] **Forward FK**: `child.parentId === parent.id` at the DB level.
- [ ] **Inverse relation**: parent's relation field returns exactly the seeded child ids.
- [ ] **Column-vs-relation**: if a single-column FK is involved, the scalar still works inside `where` / `set` / Insert / Update; the output type exposes the relation, not the scalar.
- [ ] **Ordering / pagination**: when `orderBy` / `limit` / `offset` is used, assert both order and length.
- [ ] **Negative rows**: rows that should be filtered out are absent (assert exclusion, not just inclusion).
- [ ] **Errors**: `result.errors === undefined` on success; on error, length and a stable message substring.
- [ ] **Side effects across stores**: DB **and** cookies **and** RBAC memberships **and** any in-memory caches all checked when the invariant touches them.
- [ ] **Isolation**: unrelated rows and unrelated users untouched.

### 7) Naming and structure

- File location: place the test next to the module under test — `foo.ts` ↔ `foo.test.ts`. Confirm the path is matched by the test script's glob; if not, extend the script.
- File header: `import { describe, it, before, beforeEach } from "node:test";` + `import assert from "node:assert/strict";` first.
- Top-level layout: one `describe` per public function or per route group; `it` per invariant. Use `t.test` subtests for table-driven cases where per-case failure isolation matters.
- Test names: `<feature>__<scenario>__<expected_outcome>` or `<feature>__<edge_case>__<invariant>`. Names should be greppable and self-explanatory in CI output.
- Helpers: co-locate in the same file or a sibling `__helpers__.ts`. Reach for `drizzle-graphql-rbac/testing` only for shared-DB fixtures — don't invent a new shared fixture package.

### 8) Verification

After writing the file:

1. Confirm it's matched by the workspace `test` glob (run `npm test -- --test-name-pattern <your_name>` to verify it actually executes).
2. Run `npm test` from the repo root — every test must pass.
3. Deliberately break the production code in one place (flip a boolean, comment out a guard) and rerun: at least one of your new tests must fail. If nothing fails, the test is asserting something tautological — strengthen it. Restore the code afterwards.
4. If you added a new test directory (e.g. `src/newthing/`), update `packages/drizzle-graphql-rbac/package.json#scripts.test` to include the new glob.

## Deliverable

Produce a short report:

- **Component**: which file/module is now covered.
- **Test plan**: the table from step 1 (invariant → test name).
- **Files added/modified**: each with a one-line description.
- **Coverage notes**: any invariant that was intentionally not covered, and why (e.g. "rate-limit window length not asserted — depends on wall clock; would be flaky").
- **Mutation check**: confirm step 8.3 (break-code-rerun) exposed at least one failure.
- **Verification**: confirm `npm test` is green and note runtime if it changed materially.

## Quick checklist

- [ ] Source read; every branch and invariant enumerated in a test-plan table.
- [ ] Test layer chosen per invariant (pure / module-integration / end-to-end); end-to-end preferred where the contract lives.
- [ ] DB fixture chosen (per-file `:memory:` vs. shared `transactionCase`) and applied consistently within the suite.
- [ ] Every component class above has at least the listed coverage; nothing skipped without an explicit note in the report.
- [ ] Allow, deny, and admin-bypass covered on every RBAC / record-rule surface.
- [ ] Success and error shapes covered on every GraphQL and HTTP surface.
- [ ] Cardinality + identity + isolation asserted on every mutation test.
- [ ] Column-vs-relation behavior asserted on both input and output sides where FKs are involved.
- [ ] No assertion-free / "does not throw" tests; no implementation-detail assertions.
- [ ] Tests deterministic; no wall-clock or unseeded randomness leaks.
- [ ] `npm test` green; mutation check confirmed at least one test fails when the code is broken.
