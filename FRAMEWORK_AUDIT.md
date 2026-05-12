# `drizzle-graphql-rbac` Framework Audit

Date: 2026-05-12
Scope: `packages/drizzle-graphql-rbac/` (framework + tests)
Method: 10 parallel specialist agents (security ×3, performance ×2, readability ×2, dead code, test suite, architecture).

---

## Executive summary

The framework is functional and reasonably well-organised, but it has three categories of issue worth fixing before a 1.0:

1. **Two High-severity RBAC/security gaps** allow privilege escalation or credential exfiltration via the GraphQL surface — no per-column write ACL on insert/update, and `ctx.role.isAdmin` is trusted blindly.
2. **Performance** depends entirely on a request-scoped `ctx.batch` Map being present; if any wrapper forgets it, the schema silently degrades to massive N+1. Domain trees are also re-parsed on every resolver call.
3. **Public API surface is ~3× too large** — roughly 60 of ~80 re-exports in `index.ts` are unused by the consumer app, and the entire `config.ts`/`defaultConfig.ts` "runServer" stack is dead end-to-end.

Below are the prioritized findings. Each item lists `file:line`, severity, and the concrete fix.

---

## 1. Security

### 1.1 Auth module (`src/auth/`)

**HIGH**

- **H1 — Session fixation** (`routes.ts:115-146`, `session.ts:121-132`): `issueSession` is called on register/login but pre-login session cookies are never invalidated. Fix: in `/login` and `/register`, if `c.get("session")` exists, call `destroySession` first, then `issueSession`. Rotate on any role change.
- **H2 — Logout CSRF-exempt** (`csrf.ts:76`): `/auth/logout` is whitelisted, enabling forced logout via cross-site form posts (chains into login-CSRF). Fix: remove the exemption.

**MEDIUM**

- **M1 — Cookie shadowing** (`session.ts:87-101`): no RFC 6265 unquoting; duplicate `sid` cookies (path/domain scoping) can be exploited from a sibling subdomain. Fix: use `__Host-sid` prefix.
- **M2 — `bcrypt.compareSync` blocks event loop** (`routes.ts:131`): ~300 ms/req at cost=12. Fix: `await bcrypt.compare(...)`.
- **M4 — Login enumeration via timing** (`routes.ts:128-133`): success path runs an extra `INSERT`. Fix: defer the INSERT or add a constant-time delay.
- **M5 — Bearer regex accepts huge tokens** (`session.ts:109-115`): no length/charset cap on `Authorization: Bearer …`. Fix: cap to 128 chars + hex.

**LOW**

- **L1 — Session tokens stored plaintext** (`session.ts:167`). Hash with sha256 server-side.
- **L2 — `requireAdmin` truthy check coupling** (`middleware.ts:85`).
- **L4 — Cookie `Secure` flag hardcoded** — make config-driven.

### 1.2 GraphQL builder (`src/graphql/builder/`)

**HIGH**

- **B1 — Mass-assignment on insert/update** (`builder-resolvers.ts:139-146,162-176`): only a coarse `create`/`update` guard runs; arbitrary columns in `args.values`/`args.set` are passed straight to Drizzle. Forgetting to add `passwordHash`, `email`, `id`, or a future `isAdmin` to `hiddenInputColumns` = privilege escalation. Fix: per-column write ACL inside the resolver; default-hide `passwordHash`, `token`, `id`.

**MEDIUM**

- **B3 — Hidden output columns leak via SELECT** (`builder-relations.ts:230-241`, `util.ts:100-127`): `hiddenOutputColumns` is presentation-only; `db.select()` fallbacks still fetch every column. Risk: future code paths that serialize `parent` (logging, errors) leak `passwordHash`. Fix: drop hidden columns from the Drizzle projection itself.
- **B4 — `whereDomainToSql` exposes hidden columns as oracle** (`util.ts:144-162`, `domain.ts:198-202`): no hidden-input filtering on filter paths, so `where: [["passwordHash","like","$argon2id$...%"]]` enumerates the hash byte-by-byte. Same for `orderBy`. Fix: enforce per-table read-column allow-list in `whereDomainToSql` and `orderByToSql`.
- **B5 — No row-count cap on bulk mutations** (`builder-resolvers.ts:131-200`): insert/update/delete with broad `where` are unbounded. Fix: add `maxInsertBatch` and a LIMIT cap on mutation row counts.
- **B6 — Depth limit without complexity limit** (`depth-limit.ts`): breadth + alias-fanout amplifies queries; per-alias unique `where` defeats the `JSON.stringify`-keyed batch cache. Fix: add `graphql-query-complexity` and alias-count cap.

**LOW**

- **B7 — `like`/`ilike` patterns unescaped** (`domain.ts:262-269`): wildcards are honored as wildcards — combine with B4 for enumeration.
- **B8 — No Yoga `maskedErrors`** (`app.ts:264-269`): SQL exceptions and `parseDomain` errors (which echo attacker input) bubble unmasked. Disable GraphiQL in production.
- **B9 — JSON scalar `parseLiteral` recurses unboundedly** (`scalars.ts:33-50`).

**Positive findings**: no SQL-identifier injection (all identifiers go through `meta.columns` lookup → Drizzle Column objects); cycles in relations are bounded by depth limit; introspection is admin-gated correctly.

### 1.3 RBAC engine (`src/graphql/rbac/`, `frameworkRbac.ts`)

**HIGH**

- **R1 — Spoofable admin via `ctx.role.isAdmin`** (`rbac.ts:144-170`): engine trusts the caller-supplied flag without cross-checking the in-memory registry. Anyone who can construct a `RbacContext` (custom resolver, leaked test helper) bypasses everything. Fix: `const reg = rolesByKey.get(role.name); if (!reg) deny()` then use `reg.isAdmin`.
- **R2 — Update record-rule applies to selection, not to `set`** (`builder-resolvers.ts:150-176`, `rbac.ts:181-189`): a user can update *their* row while setting `ownerId = victim`, exfiltrating it. Fix: validate `args.set` against the predicate columns of the same domain, or post-check in a tx.

**MEDIUM**

- **R4 — Memoization cache-key omits role** (`rbac.ts:146`): if `ctx.role` is rebound mid-request the cached admin-bypass replays. Include `role?.name` in the key.
- **R5 — `combineRelWhere` mishandles `null`** (`rbacDb.ts:339-348`): explicit `where: null` falls through to `and(null, extra)`. Fix: treat `null`/`undefined` identically.
- **R6 — `rbacDb.transaction` throws and steers callers to `sudo.transaction`** (`rbacDb.ts:234-247`): in sync dialects (this repo) every transactional write is unenforced. Fix: provide `transactionSync(cb)` that pre-resolves the snapshot.

**LOW**

- **R7 — Unique-constraint side channel** during inserts can confirm row existence even when reads are denied. Mostly inherent.
- **R8 — `syncRoles` async/sync mismatch** (`persistence.ts:73-99`): sync callback in async function; will silently drop promises if a future contributor adds `await` inside.

**Positive findings**: `mergeFrameworkRbac` correctly forbids redeclaring `admin`; `assignRole`/`revokeRole` callers are gated by `requireAdmin` on `/admin/*`.

---

## 2. Performance

### 2.1 GraphQL builder

1. **N+1 if `ctx.batch` is missing** (`builder-relations.ts:140-152`): without the per-request `Map` the cost goes `1 → 1 + N + N² + N³` on a 3-level nest. Fix: install `batch: new Map()` as a Yoga plugin in the package itself; do not rely on app glue.
2. **`jsKeyOf` in hot path** (`builder-relations.ts:114`, `util.ts:120-123`): O(columns) scan per parent row per relation. Fix: precompute keys at build time in the closure.
3. **`JSON.stringify` per parent row for the batch cache key** (`builder-relations.ts:161`). Fix: memoise on `info.fieldNodes` (interned per query) via WeakMap.
4. **`parseDomain` per resolver call** (`util.ts:144-162`, `builder-relations.ts:127`): re-parses identical domains across requests. Fix: WeakMap keyed on `info.fieldNodes`.
5. **Per-parent `limit`/`offset` disables batching** — falls back to per-row queries. Fix: window-function pagination (`ROW_NUMBER() OVER (PARTITION BY fk)`).
6. **`getTableName` called per resolve** (`builder-relations.ts:159`) — capture once in the closure.

### 2.2 RBAC + auth wiring

7. **Record-rule domain re-parsed + re-compiled per `enforce` call** (`rbac.ts:181-186`): biggest single win. Fix: pre-parse at `buildRbac` time; split `domainToSql` into "compile shape" + "bind placeholder values" so the SQL string is cached and only the user id varies.
8. **Session DB JOIN on every request** (`session.ts:157-168`, `middleware.ts:56`). Fix: short-TTL LRU keyed on token; invalidate on `destroySession`.
9. **Sliding-expiry `UPDATE` is awaited** (`session.ts:183-190`). Fire-and-forget.
10. **Proxy traps wrap every chain method** (`rbacDb.ts:377-407,423-446`): replace with a concrete wrapper class — Drizzle's chain surface is small and stable.
11. **`findRole` O(n) linear scan** (`rbac.ts:197`): the `rolesByKey` Map already exists — use it.

---

## 3. Readability & code quality

### 3.1 Builder

- **`buildRelationField` (~105 lines)**, **`createRelationLoader` (~95 lines)**, **`introspectSchema` (~120 lines)** — all over 50 lines and mix concerns. Split each into named phases.
- **`builder-types.ts:100` — TDZ-style forward reference** to `meta` inside the GraphQLObjectType thunk; works only because the thunk is invoked lazily. Declare `let meta` first.
- **`relations.ts:228-232` — dead `relationsByTable.set` inside a `continue` branch.** Drop the line.
- **`filters.ts:106-118` `applyListArgs`** — documented to return the same builder, but `.where()` returns a new one. Type/contract mismatch.
- **`Guard = ((...) => Promise<SQL>) | null`** (`types.ts:92`) — `null` forces a branch at every callsite. Always return a callable; the no-op resolves `undefined`.
- **`DrizzleLike`** is a doc-only marker typed as `any` — either tighten or delete.
- **Pervasive `any` casts in `relations.ts:149-184`** reaching into Drizzle internals — consolidate behind one `drizzle-internals.ts` shim.
- **`whereDomainToSql` knows about `RbacContext`** (`util.ts:144-162`) — domain translation should be RBAC-agnostic. Pass `placeholders` in.
- **`filters.ts` no longer filters** — rename to `list-args.ts`; move `combineWhere` to `util.ts`.
- **`buildTableMeta` has 12 positional args** — pack into `BuilderContext`.

### 3.2 Auth / admin / app

- **Stale module JSDoc** (`app.ts:6-13`, `index.ts:8-12`, `auth/session.ts:8` referencing `../server.ts`).
- **Config duplication**: `defaultConfig.ts:18-41` and `app.ts:210-220` both declare default `port/host/publicDir/...`. Drift risk. Fix: `createApp` should import and spread `frameworkDefaultConfig`.
- **`createApp` is 170 lines** (`app.ts:205-374`) doing 10 things — extract `buildYoga`, `mountMiddleware`, `mountRoutes`.
- **`runServer` ditto** (`config.ts:333-399`).
- **`pickHttpStatus` and `ANSI_RE`** (`app.ts:70-78`) belong in `logger.ts`.
- **`ServerCtx`/`YogaContext` inline** in `app.ts:252-264` — should be the GraphQL builder's exported contract.
- **`auth/csrf.ts:73`**: `/auth/logout` exemption hard-codes a route path defined elsewhere — take an `exempt: string[]` config.
- **Three inconsistent error-handling styles** across `admin/routes.ts`, `auth/routes.ts`, `auth/middleware.ts` — lift `HttpError` + `mapError` into a shared `errors.ts`.
- **`SudoDb`** (`auth/session.ts:62-71`) is `(...args: any[]) => any` — the generic carries no info; every callsite re-casts.
- **`as ResolvedServerConfig` cast** (`config.ts:350`) is unverified.
- **`index.ts:87`** uses value-export syntax for `RbacDb` (a class) — should be `export type` for clarity.
- **`tables.ts:37`**: unnecessary `AnySQLiteColumn` thunk on `references` for a same-file reference.

---

## 4. Dead / unused code

The parent app at `src/` only imports: `createApp`, `logger`, `defineRoles`, `defineAccessRights`, `defineRecordRules`, `syncRoles`, `buildRbacConfig`, `mergeFrameworkRbac`, the framework tables/row-types, and the `testing/` subpath. Everything else in `index.ts` is internal-only or unused.

### Removable surface

- **`src/index.ts`**: roughly 60 of ~80 re-exports are unused externally. Specifically:
  - L17 `Logger`; L23-29 the entire `config.ts` surface (`runServer`, `loadServerConfig`, `loadSecrets`, `parseCliArgs`, `resolveConfigPath`, `defineServerConfig`, `ParsedCli`, `ResolvedServerConfig`, `RunServerHandle`, `RunServerOptions`, `Secrets`, `ServerConfig`); L40 `frameworkDefaultConfig`.
  - L43-44 `roles` / `Role` / `NewRole` (app uses the `./tables` subpath).
  - L50-71 the auth/cookie/CSRF primitives (`buildSessionCookie`, `parseCookieValue`, `extractBearerToken`, `resolveSessionFromToken`, `issueSession`, `destroySession`, `SESSION_COOKIE_NAME`, `SudoDb`, `SessionSchema`, `AuthRoutesDeps`, `AuthVariables`, `createCsrfProtection`, `CsrfConfig`, `CsrfOriginOption`, `CsrfProtection`).
  - L75 `AdminRoutesDeps`; L77-78 builder internals (`GraphQLJSON`, `GraphQLBigIntStr`, `depthLimit`, `BuildSchemaOptions`, `DrizzleLike`).
  - L80-89 RBAC engine surface (`RbacContext`, `RbacEnforce`, `Action`, `BuiltRbac`, `ResolvedUserRole`, `buildRbacDb`, `RbacDb`, `RbacDbDeps`).
  - L94-99 persistence (`getUserRole`, `setUserRole`, `listRoles`, `RolePersistenceSchema`) — only `syncRoles` is used externally.
  - L103-107 `ADMIN_ROLE`, `FRAMEWORK_ROLES`.
  - L117-140 RBAC config types and domain primitives.

- **`src/config.ts`** — entire file is dead end-to-end (no external caller for `runServer` etc.). Largest removable chunk by line count.
- **`src/defaultConfig.ts`** — only consumed by the dead `config.ts:347`. Dead transitively.
- **`src/frameworkRbac.ts`** — `FRAMEWORK_ROLES` can be private (only used inside the file); `ADMIN_ROLE` could be inlined.
- **`src/logger.ts:54`** — `export type { Logger } from "pino"` has no importer.

No commented-out code blocks, no backwards-compat shims, no always-same parameters were found.

---

## 5. Test suite

### Redundancy (drop or merge)

- CSRF coverage duplicated between `auth/csrf.test.ts` and `app.test.ts:153-217`. Keep csrf.test.ts; reduce app.test.ts to one smoke test.
- Admin/RBAC 403 matrix repeated 3× in `admin.test.ts:84-114,116-133,236-244`. Collapse into one table-driven test.
- Admin-bypass tested 3× at three layers (`rbac.unit.test.ts:47`, `rbacDb.test.ts:68,157`, `rbac.test.ts:89`). Drop the duplicate `rbacDb.test.ts:157`.
- Manager-full-CRUD asserted in both `accessRights.test.ts:142-207` and `recordRules.test.ts:201-265`. Drop from `recordRules.test.ts`.
- `rbacDb.test.ts:230` AND-combine duplicates `recordRules.test.ts:92`.
- `rbac.test.ts:115` reader-sees-own-rows duplicates `recordRules.test.ts:76`.

### Weak assertions

- `relations.test.ts:30-33` tautological (js key == sql name in fixture).
- `filters.test.ts:48-54,38-44` only check field existence/length, not types or directions.
- `domain.test.ts:22-42` only checks `node.kind`; never asserts subtree shape. Add `deepEqual` of parse trees.
- `app.test.ts:128-150` regex `/Users/` matches `UsersInsert` — anchor with `^Users$`.
- `rbac.test.ts:228-237` config-validation unit assertions buried inside an integration describe.

### Coverage gaps

- **`auth/middleware.ts`** has no direct test; bearer-vs-cookie precedence, expired sessions, dangling user refs untested.
- **`admin/routes.ts`**: POST `/users` validation 400, self-delete guard, PATCH email-collision/404 untested.
- **`depth-limit.ts`** has no test file.
- **`scalars.ts`**, **`util.ts`** untested directly.
- **`filters.ts` operator matrix**: only `like`/`eq`/`gt` exercised — `inArray/notInArray/isNull/ne/notIlike/notLike` have no direct case.
- **AND/OR/NOT JSON-domain combinators** at the GraphQL surface — only OR is exercised (`builder.test.ts:222`).
- **Composite FK skip** in `relations.ts` — no negative test.

### Brittle

- `admin.test.ts:192-195` pins alphabetical role order — sort or use set equality.

### Slow / setup

- `app.test.ts` rebuilds `createApp` per test in several describes — hoist to per-describe.
- `rbac-mutations.test.ts` repeats the full sqlite+drizzle+buildSchema boilerplate — extract a helper.

### Tests of test infrastructure (low value)

- `auth/csrf.test.ts:207-225` "factory shape" — drop or compress.
- `rbacDb.test.ts:337-346` "unknownJsKey falls through" — tests Drizzle, not RBAC.
- `relations.test.ts:24-34` introspection-shape lock-in.

---

## 6. Architecture & API

- **Public surface too broad for a 0.1.0** (`index.ts`, 140 lines, ~50 exports). Tier the API: keep `createApp`/`runServer`/`define*`/tables in `index.ts`; move primitives behind `./auth`, `./rbac`, `./graphql` subpaths.
- **Stale doc in `index.ts:8-13`** claims memberships live in `users.role_id` reconciled by `syncRoles`; the project `CLAUDE.md` says fully in-memory. Code awaits `syncRoles` — `CLAUDE.md` is stale.
- **`./testing` subpath ships `better-sqlite3` and `drizzle-kit`** at import time (`testing/base.ts:12-15`) — breaks for postgres/mysql consumers. Either document the SQLite coupling or ship a sibling for other dialects.
- **`app.ts` is a god-module** (Yoga config, ANSI stripping, HTTP-status sniffing, depth limit, introspection control). Extract `graphql/yoga.ts` and `logger.ts` sinks.
- **`frameworkRbac.ts` should live under `src/rbac/`**, not at root — RBAC is not GraphQL-scoped (it's used by REST admin routes and middleware too). Promote `graphql/rbac/` to top-level.
- **`CreateAppOptions` mixes security policy with UX knobs.** Nest as `opts.security = { hiddenOutputColumns, hiddenInputColumns, csrf, graphqlMaxDepth, maxListLimit }`.
- **Shallow-merge config precedence bug** (`config.ts:346-350`): a user supplying `hiddenOutputColumns: { users: ["password_hash"] }` silently loses the default `sessions: ["token"]`. Per-field merge for security policy.
- **`bcryptjs` is imported but not declared in `dependencies`** (`config.ts:52`, `framework_testing.ts:11`); `@node-rs/argon2` is declared but unused. Pick one.
- **`testing/app_testing.ts:121-127`** builds the GraphQL schema *twice* (once inside `createApp`, once for `runDirect`) — two truth sources. Return `graphqlSchema` from `createApp`.
- **`peerDependencies` use open-ended `>=` ranges** at 0.1.0 — tighten to caret-bound before publish.
- **`main: ./src/index.ts`** with no build step / no `files`. Either mark `private: true` or set up tsup emit.

---

## Top priorities (recommended order)

1. **Fix RBAC writes** (R1, R2 / B1): per-column write ACL on insert + update, registry-verified `isAdmin`.
2. **Close the filter-column oracle** (B4): apply hidden + RBAC column allow-list to `where`/`orderBy`.
3. **Cookie/CSRF hardening** (H1–H2): session rotation, remove logout exemption.
4. **Performance: pre-parse domains once + always-on batch Map + session cache** (P7, P1, P8). Three changes that together eliminate most resolver overhead.
5. **Cut public API + delete `config.ts`/`defaultConfig.ts`**: ~60 unused exports and ~400 lines of unreachable boot helper. Tightens future-compatibility.
6. **Test gaps**: `auth/middleware.ts`, `depth-limit.ts`, filter-operator matrix.

---

*Generated from 10 parallel review agents (security, performance, readability, dead-code, tests, architecture). Each finding traces back to a specific file:line; see agent transcripts under `/tmp/claude-1000/.../tasks/` for the raw reports.*
