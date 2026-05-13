# Test Isolation Audit — `src/todos.test.ts`

This document inventories the **test-isolation hazards** present in `src/todos.test.ts` and the harness it depends on (`src/testing/appTestCase.ts` → `packages/drizzle-graphql-rbac/src/testing/app_testing.ts` and `.../base.ts`).

The framing is the "Option 2" mindset from our discussion of SAVEPOINT-based testing:

> A `ROLLBACK TO SAVEPOINT` undoes **SQL state only**. Anything in JS process memory — caches, singletons, captured row snapshots — is not undone. The safest fix is to arrange for as little state as possible to outlive a single test.

Each problem below is rated by severity:

- **Live** — the bug can be triggered by the current code as written.
- **Latent** — the code is currently safe, but the design makes the bug one small refactor away.
- **Structural** — a property of the harness; affects the whole test suite, not just this file.

---

## Setting the scene

Two facts from the harness shape every issue below:

1. **`buildOnce()` in `app_testing.ts:75–80` builds the Hono app, the RBAC engine, and the compiled GraphQL schema exactly once per process** via a memoized `Promise`. Every suite and every test in the process shares those instances.
2. **`getSharedSqlite()` in `base.ts:24–27` returns one process-wide `:memory:` database.** Suite savepoints nest inside it; test savepoints nest inside suite savepoints.

The resulting rollback hierarchy:

```
process-wide sqlite handle           ← never reset; lives for the process
  SAVEPOINT suite_N (before)         ← rolls back at `after` (end of describe-tree)
    SAVEPOINT test_M (beforeEach)    ← rolls back at `afterEach` (end of each it)
      <test body>
```

Everything **outside** that hierarchy — the Hono app, the RBAC engine, the compiled GraphQL schema, every plain JS object — survives every rollback in the file.

---

## Problem 1 — `tc.seed` is a JS object, not a DB row  *(Latent)*

### Where

`src/todos.test.ts:28–52` (the `setupAppTestCase` callback) builds the seed and returns it:

```ts
const tc = setupAppTestCase(async (base) => {
  const carol = await createUser(...);
  const alice = await createUser(...);
  const bob   = await createUser(...);
  // ...
  const inserted = await base.sudoDb.insert(base.schema.todos).values([...]).returning();
  const byTitle = Object.fromEntries(inserted.map((r) => [r.title, r]));
  return { carol, alice, bob, todos: byTitle };
});
```

That callback runs **once per suite**, inside `before`. The returned object is what `tc.seed` reads through to via the Proxy in `transactionCase`.

### What's wrong

`tc.seed.todos["alice-1"]` is a plain JS object — the row Drizzle returned at INSERT time. The savepoint rollback only restores DB state; it cannot reach this object. If any test **mutates** a field on it, the mutation persists into the next test even though the DB row reverts.

The reassignment test at line 303 is currently safe because it only **reads** from `tc.seed`:

```ts
const targetId = tc.seed.todos["alice-1"].id;  // read — OK
```

But a "tidier" refactor would break isolation silently:

```ts
// HYPOTHETICAL refactor that would corrupt cross-test state
const target = tc.seed.todos["alice-1"];
target.assigneeId = tc.seed.bob.id;           // ← mutates the cached object
await tc.runHttp(M_UPDATE, {
  variables: { w: [["id","=",target.id]], s: { assigneeId: target.assigneeId }},
});
```

After rollback, the DB row's `assigneeId` reverts to `alice.id`, but `tc.seed.todos["alice-1"].assigneeId` still says `bob.id`. The next test that consults `tc.seed.todos["alice-1"]` for setup uses the wrong value, and the failure surfaces as a *different* test mis-asserting on row counts or ownership — the classic "spooky action at a distance" test bug.

### Why it's latent, not live

The file as written never writes to fields of `tc.seed.*`. It only reads them and re-queries the DB for ground truth via `dbAllTodos()` / `dbTodoById()`. So today, this is a footgun aimed at the next contributor.

### Proposed solution

Push seed construction down from `before` (per suite) into `beforeEach` (per test). Concretely, change the harness so the `setUp` callback runs inside the per-test savepoint:

```ts
// In app_testing.ts — sketch
const setupAppTestCase = (setUp) => {
  const ctx = transactionCase(async () => {
    const built = await buildOnce();
    return makeTestCtx(built);             // suite-level: app, schema, db handle
  });
  let seed;
  beforeEach(async () => { seed = await setUp(ctx); });
  return new Proxy(ctx, {
    get(t, p) { return p === "seed" ? seed : t[p]; },
  });
};
```

Effect: `tc.seed` is a fresh object every test. Even if a test mutates `tc.seed.todos["alice-1"].assigneeId`, the next test rebuilds the whole seed from scratch and never sees the mutation.

Tradeoff: re-running the 3 user inserts + 4 todo inserts per test costs ~1 ms on `:memory:` sqlite. Worth it.

---

## Problem 2 — Cross-file sqlite sharing  *(Resolved)*

> **Fixed.** `getSharedSqlite()` and the module-level `sharedSqlite` singleton have been removed from `packages/drizzle-graphql-rbac/src/testing/base.ts`. `transactionCase` now opens a fresh `:memory:` database in `before` and closes it in `after`. Each suite owns its DB; cross-file sharing is no longer possible through the public testing surface.

### What it was

`base.ts` used to export a process-wide singleton:

```ts
let sharedSqlite: Database.Database | undefined;
export function getSharedSqlite(): Database.Database {
  if (!sharedSqlite) sharedSqlite = new Database(":memory:");
  return sharedSqlite;
}
```

Every test file that imported `setupAppTestCase` eventually went through this function. If two test files ran in the same process — possible with aggregated runners or `--test-concurrency` in in-process mode — their seed data coexisted in one sqlite, and the per-suite SAVEPOINT only isolated *within* a file, not *between* files.

### How the fix works

`transactionCase` was rewritten to own its sqlite handle by default:

```ts
// base.ts (current)
export function transactionCase<Ctx extends object>(
  setUpClass: (sqlite: Database.Database) => Promise<Ctx> | Ctx,
  options: TransactionCaseOptions = {},
): Ctx {
  // ... in `before`:
  if (options.sqlite) {
    sqlite = options.sqlite;
    ownsSqlite = false;
  } else {
    sqlite = new Database(":memory:");
    ownsSqlite = true;
  }
  // ... in `after`:
  if (ownsSqlite) sqlite.close();
}
```

The setUp callback receives the suite's sqlite handle as its argument. `createAppTestHarness` (in `app_testing.ts`) was updated to consume it and build the Hono app + RBAC engine per suite — see "Problem 3 follow-on" below.

The optional `options.sqlite` escape hatch exists for one caller — the framework's own RBAC fixture (`packages/drizzle-graphql-rbac/src/graphql/rbac/__helpers__.ts`) — which intentionally shares a single connection across the test files in that directory because they all push the same `users`/`roles`/`todos` schema once at module load. That handle is now **module-private** to `__helpers__.ts` (a `new Database(":memory:")` literal) rather than exposed through the public `getSharedSqlite()` API, so host-app harnesses can no longer touch it. The four framework test files (`rbac.test.ts`, `recordRules.test.ts`, `accessRights.test.ts`, `rbacDb.test.ts`) keep calling `transactionCase(async () => …)` unchanged — `__helpers__.ts` exports a wrapper that pre-binds `options.sqlite` to its private handle.

### Files changed

- `packages/drizzle-graphql-rbac/src/testing/base.ts` — removed `getSharedSqlite`/`sharedSqlite`; rewrote `transactionCase` to own a per-suite DB; added `TransactionCaseOptions` for the explicit-sqlite case.
- `packages/drizzle-graphql-rbac/src/testing/index.ts` — dropped `getSharedSqlite` re-export.
- `packages/drizzle-graphql-rbac/src/testing/app_testing.ts` — see Problem 3 follow-on.
- `packages/drizzle-graphql-rbac/src/graphql/rbac/__helpers__.ts` — module-private sqlite + wrapped `transactionCase`.
- `src/testing/appTestCase.ts` — dropped the app-side `getSharedSqlite` re-export.

### Verification

- Full framework suite: **197/197 pass**.
- `src/todos.test.ts`: **25/25 pass**.

### Problem 3 follow-on (partially resolved)

Because each suite now owns its sqlite, the old `buildPromise` Promise-cache in `app_testing.ts` no longer made sense — the cached app was bound to one DB and would be stale for any subsequent suite. The cache was removed; `setupAppTestCase` now calls `buildAppForSuite(appConfig, sqlite)` once per `transactionCase` (i.e. once per suite, not once per process).

This eliminates **half of Problem 3**: the RBAC engine and Hono app are no longer process-wide singletons. They're still **per-suite** singletons, meaning any future in-memory cache added to the engine would still survive between *tests within a suite* — Problem 1's fix (rebuild seed per test) is the complementary change that closes that remaining gap.

---

## Problem 3 — The RBAC engine and Hono app are process singletons  *(Latent)*

### Where

`packages/drizzle-graphql-rbac/src/testing/app_testing.ts:75–80`:

```ts
let buildPromise: Promise<BuiltApp<S>> | undefined;

const buildOnce = (): Promise<BuiltApp<S>> => {
  if (!buildPromise) buildPromise = buildAppOnce(appConfig);
  return buildPromise;
};
```

`buildAppOnce` calls `createApp({...})`, which constructs the RBAC engine and wires the Hono app. The result is cached on a module-level `let` — shared across every `setupAppTestCase` in the process.

### What's wrong (today)

Currently the file is safe because role lookups happen through the DB at request time:

- `lookupRole` at `app_testing.ts:188` issues a live `SELECT … FROM users INNER JOIN roles …` every call.
- `assignRole` writes through to the DB via `setUserRole` (updates `users.roleId`).

So the engine doesn't cache user→role facts in memory. A savepoint rollback restores the DB, and the next request reads the restored state.

### What's wrong (the moment anyone optimizes)

The CLAUDE.md note at the top of the project says:

> RBAC is fully in-memory: `createApp` builds the engine snapshot synchronously from the code config, and user → role memberships live in process memory.

That description is *stale relative to the current harness*, but it tells us this codebase has already lived through the singleton-engine pattern once. The very next perf change — e.g. "cache `engine.canRead(role, table)` lookups on the engine," or "memoize `userId → role` per request batch" — puts mutable state on the process-wide singleton.

Concrete failure mode after such a change:

1. Test A: `assignRole(userId=7, 'admin')`, engine populates its cache with `7 → admin`.
2. Test A ends, savepoint rolls back. DB now says user 7 has no role.
3. Test B: reuses `userId=7`, makes a request, engine cache hits `7 → admin`. Request succeeds when it should have been denied.

The bug would surface in unrelated tests — and you'd waste a day before suspecting the engine cache.

### Proposed solution

Don't memoize `buildPromise` across suites. Move the build inside `setupAppTestCase` itself:

```ts
const setupAppTestCase = (setUp) =>
  transactionCase(async () => {
    const built = await buildAppOnce(appConfig);   // fresh app + engine per suite
    return makeTestCtx(built);
  });
```

The expensive part is the GraphQL schema build (it walks the whole Drizzle namespace). The schema is **immutable** once built, so cache *only that*:

```ts
let cachedGraphqlSchema; // safe to share — never mutated
async function buildAppOnce(appConfig) {
  // build sqlite + engine + Hono app FRESH every call
  cachedGraphqlSchema ??= buildGraphqlSchema(sudoDb, appConfig.schema, {...}).schema;
  // ...
}
```

This is the canonical Option 2 split: **share the immutable, rebuild the mutable.**

---

## Problem 4 — The savepoint-pair test bakes in execution order  *(Live, but intentional)*

### Where

`src/todos.test.ts:429–447`:

```ts
describe("todos — savepoint rollback between tests", () => {
  it("an insert in this test is visible inside this test", async () => {
    // inserts a row titled "ephemeral"
  });

  it("the next test does not see the previous insert (rolled back)", async () => {
    // expects 0 rows with title "ephemeral"
  });
});
```

### What's wrong

The pair only makes sense if the first `it` runs before the second. `node:test` honors declaration order today, but:

- Enabling `--test-concurrency` with parallel `it` execution (not currently the default but possible) would let them race.
- Reordering the file accidentally (or via a linter that sorts `it` blocks) would silently break the semantics.
- The second test would pass trivially if it ran first (no "ephemeral" row exists yet), giving a false green.

### Why this is an honest tradeoff

The comment at line 426 acknowledges this:

> Two intentionally-paired tests: the invariant is that the per-test SAVEPOINT rolls back BETWEEN tests, so merging them would defeat the point.

The whole purpose of this test is to **observe** the rollback's effect across the test boundary — which inherently requires two ordered tests. Option 2 (rebuild-per-test) doesn't apply here; the test *is* the assertion about isolation.

### Proposed solution

Keep the pair, but harden the contract:

1. Add an explicit comment that these two `it` blocks must run sequentially in declaration order, and that running with parallel-it concurrency will produce false greens.
2. Make the second test fail noisily if it runs in isolation:
   ```ts
   it("the next test does not see the previous insert (rolled back)", async () => {
     // If this test runs first (parallel concurrency or reordering), the
     // assertion below trivially passes — which is a false green. The pair
     // is only meaningful when run sequentially after the previous it().
     const found = await tc.sudoDb.select().from(tc.schema.todos)
       .where(eq(tc.schema.todos.title, "ephemeral"));
     assert.equal(found.length, 0);
     assert.equal((await dbAllTodos()).length, 4);
   });
   ```
3. Optionally collapse to a single test that uses a nested savepoint internally — but that tests `transactionCase` against itself, which is less honest. Better to leave as-is and document.

---

## Problem 5 — `buildOnce` Promise caching swallows partial failures  *(Latent)*

### Where

`app_testing.ts:77–80`, same code as Problem 3:

```ts
const buildOnce = () => {
  if (!buildPromise) buildPromise = buildAppOnce(appConfig);
  return buildPromise;
};
```

### What's wrong

If `buildAppOnce` throws **after** mutating shared state — most importantly after `pushDrizzleSchema` has executed some but not all DDL on the shared sqlite handle — then:

- `buildPromise` is now a rejected `Promise`.
- Every subsequent `setupAppTestCase` call awaits the same rejection and propagates the same error.
- The partial DDL changes are **already on the shared sqlite handle** and persist for the rest of the process.

You get a cascade of confusing errors and a corrupted DB that doesn't match the schema you think you have.

### Why it's latent

It requires `buildAppOnce` to fail in a specific window: after `pushDrizzleSchema` started writing DDL, before the function returned. Not common — but the failure mode is silent-then-cascading rather than fail-fast.

### Proposed solution

Two complementary fixes:

1. **Combine with Problem 3's fix**: stop memoizing `buildPromise` at module scope. If each suite builds fresh, a single bad build poisons one suite, not the whole process.
2. **Don't reuse a poisoned sqlite handle**: if Problem 2's fix is applied (per-harness sqlite), a build failure leaves only that harness's sqlite in a bad state, and it gets closed in `after`.

Either fix individually mitigates Problem 5; together they eliminate it.

---

## Priority order

| # | Fix | Solves | Status |
|---|---|---|---|
| 1 | Move seeding from `before` to `beforeEach` (rebuild `tc.seed` per test) | Problem 1 | **Pending** |
| 2 | Per-suite sqlite handle, drop process-wide `getSharedSqlite()` | Problem 2 (+ Problem 3 cache, + Problem 5) | **Done** |
| 3 | Document the ordered-pair contract in the savepoint test | Problem 4 | **Pending** |
| — | Cache only the immutable GraphQL schema (further optimisation of Problem 3) | Problem 3 (remaining per-suite singleton) | Optional |

Problem 2's fix transitively resolved the `buildPromise` memoisation half of Problem 3 and the partial-failure cascade in Problem 5 (a poisoned build can no longer affect later suites — each suite builds its own app on its own DB).

---

## The principle, restated

The current harness **shares the maximum amount of state and relies on the SAVEPOINT plus contributor discipline to keep it consistent.** That works as long as:

- nobody adds a cache to the RBAC engine,
- nobody mutates fields on `tc.seed`,
- the test runner keeps using process-per-file isolation,
- every build of the app succeeds cleanly.

The Option-2 alternative — **share only the immutable, rebuild the mutable** — costs a millisecond per test and removes the need for any of those assumptions. The four fixes above are concrete steps toward that posture.
