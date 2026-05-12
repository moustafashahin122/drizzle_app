# RBAC Module — Test Case Catalog

Module: `packages/drizzle-graphql-rbac/src/graphql/rbac/`

Test files in scope:

- `rbac.test.ts` — GraphQL-layer enforcement contract.
- `rbac.unit.test.ts` — Engine-level unit tests for `buildRbac` (enforce + membership API).
- `accessRights.test.ts` — Per-role CRUD verb gating end-to-end through GraphQL.
- `recordRules.test.ts` — Row-level domain scoping end-to-end through GraphQL.
- `rbacDb.test.ts` — `RbacDb` proxy contracts (select/insert/update/delete, relational `query.*`, `transaction`).

Shared fixtures live in `__helpers__.ts`: a shared sqlite + drizzle handle wrapped in per-test `transactionCase` SAVEPOINT rollback, plus seed helpers (`insertCast`, `seedReaderAdmin`, `seedUserManager`) for the canonical Alice / Bob / Carol actors.

---

## 1. `rbac.test.ts` — GraphQL-layer enforcement

Suite: **`rbac — enforcement (GraphQL layer)`**

Cast: Alice = `reader`, Bob = `admin`, Carol = no role. The RBAC config grants `reader` `read` on `todos` with an `ownerId = current_user.id` record rule.

### 1.1 Deny paths

| # | Case | Expectation |
|---|---|---|
| 1 | Unauthenticated caller (`ctx.user = null`) queries `todos` | `data.todos === null`; one GraphQL error matching `/Not authenticated/` |
| 2 | Authenticated user with no role memberships (Carol) queries `todos` | `data.todos === null`; one error matching `/Access denied/` |

### 1.2 Happy paths and scoping

| # | Case | Expectation |
|---|---|---|
| 3 | Admin (Bob) reads `todos { id title ownerId { id name } }` | All 4 rows returned verbatim; `ownerId` relation traverses for every row; names match the seed |
| 4 | Reader (Alice) reads `todos { id title }` (no relation traversal) | Exactly the 2 alice-owned rows; titles `["alice-1", "alice-2"]` |
| 4b | Reader queries the same scope via `where: [["ownerId", "=", alice.id]]` | Same 2 rows — proves the scalar FK remains usable on the input side |
| 5 | Reader traverses `ownerId { id }` without read ACL on `users` | Parent `todos` list still resolves (2 rows); one `Access denied` error per row, each with `path` ending in `ownerId`; every row's `ownerId` is `null` |
| 6 | Reader runs `insertIntoTodos(values: [...])` (no `canCreate`) | One `/Access denied/` error; row count unchanged; no row with the attempted title |
| 7 | Reader with `update` + record rule attempts to update a row owned by Bob via `where` | `updateTodos` returns `[]`; Bob's row untouched; Alice's own row also untouched (alt-config isolated DB) |

### 1.3 Config validation (unit)

| # | Case | Expectation |
|---|---|---|
| 8 | `rbac.assignRole(1, "ghost")` | Throws `/unknown role/` |
| 9 | `buildRbac({ roles: {}, accessRights: {}, recordRules: {} })` | Throws `/roles config is empty/` |

---

## 2. `rbac.unit.test.ts` — Engine-level unit tests

Suite: **`rbac — engine unit`**

Tests construct `buildRbac` directly and invoke `enforce` / membership methods without GraphQL. Column maps come from `getTableColumns(todos)`. Two tests execute the produced SQL against a `freshDb()` to prove binding correctness.

### 2.1 `enforce`

| # | Case | Branch covered | Expectation |
|---|---|---|---|
| 10 | Admin membership, no ACL grants | `if (isAdmin) return memo({})` | Returns `{}` (no `where`) |
| 11 | Granting role, no record rule | `if (!domain) anyUnrestricted = true` | Returns `{}` |
| 12 | Rule referencing an unknown column → `domainToSql` returns `undefined` | `else anyUnrestricted = true` | Returns `{}` |
| 13 | Granted on `read` but called with `delete` | Empty `grantingRoleIds` deny | Rejects `/Access denied on 'todos' for 'delete'/` |
| 14 | No grants on the resource at all | Empty `grantingRoleIds` deny | Rejects `/Access denied on 'users'/` |
| 15 | Single granting role with one record rule | `perRole.length === 1` short-circuit | `where` is the rule's SQL verbatim (no `or(...)` wrap) |
| 16 | Two granting roles, each with a rule | `or(...perRole)` combine | `where` is defined and combines both |
| 17 | One role with rule + one unruled granting role | `anyUnrestricted` wins over OR | Returns `{}` |
| 18 | `ctx.user === null` | `if (!ctx.user) throw forbidden` | Rejects `/Not authenticated/` |
| 19 | Authenticated user with no memberships | `!roleIds.length` deny | Rejects `/Access denied on 'todos'/` |
| 20 | `ctx.batch` undefined | `ctx.batch?.set` is a no-op | Returns `{}` without throwing |
| 21 | Same `(ctx, resource, action)` invoked twice | Cache hit on success | Second call returns the **same object** as the first; `ctx.batch.size === 1` |
| 22 | Three calls covering `(todos, read)`, `(todos, update)`, `(users, read)` | Cache key format `__rbac_enforce:userId:resource:action` | Three distinct cache entries; only `todos:read` has a `where`; the other two are `{}` |
| 23 | Two ctxs (different `userId`); user 1 allowed, user 2 denied | Cache is per-user (key includes `userId`) | User 2's call rejects with `/Access denied/`; not poached from user 1's cache |
| 24 | Allow memoized, then `revokeRole` on the same user | Cache returns stale memo | Second call returns the original memo unchanged |
| 25 | Admin + non-admin roles, the non-admin role has a record rule | `isAdmin` short-circuit fires before per-role evaluation | Returns `{}` (no rule narrowing) |
| 26 | Two roles; only one grants `read`; the other has a rule on `read` but no grant | Only granting roles' rules contribute | Produced SQL filters rows to the reader's rule only; SQL executed against real DB yields `["mine"]` |
| 27 | Two granting roles, both unruled | Missing-domain branch for every role | Returns `{}` |
| 28 | `current_user.id` placeholder with two different callers | Placeholder substitution per call | Caller A's SQL returns A's rows; caller B's SQL returns B's rows |
| 29 | Deny memoized via `denyAndThrow`, then role revoked, then re-called | Cache hit on `{ __forbidden }` | Second call rejects with the **original** message (`for 'delete'`), not the post-revocation deny message |

### 2.2 Membership API

All tests use a config with `reader`, `writer`, and `root: { isAdmin: true }`.

| # | Case | Expectation |
|---|---|---|
| 30 | `listRoleKeys()` | `["reader", "root", "writer"]` (sorted) |
| 31 | `listUserRoles(unknownId)` | `[]` |
| 32 | Assign `writer` then `reader` to user 1 | `listUserRoles(1)` → `["reader", "writer"]`; revoke each → eventually `[]` |
| 33 | `assignRole(1, "reader")` twice | First call `true`, second call `false` |
| 34 | `assignRole(1, "ghost")` | Throws `/unknown role 'ghost'/` |
| 35 | `revokeRole(1, "reader")` when not assigned (never, or wrong user) | Returns `false` |
| 36 | `revokeRole(1, "ghost")` | Throws `/unknown role 'ghost'/` |
| 37 | `hasRole("reader")` / `hasRole("ghost")` | `true` / `false` |
| 38 | `isAdmin` transitions: none → reader → reader + root → reader | `false → false → true → false` |

---

## 3. `accessRights.test.ts` — Verb-level gating with no record rules

Suite: **`access rights — verb-level gating with no record rules`**

Config: `user` has `{ read, create, update }` on `todos` (no `delete`); `manager` has full CRUD on both `todos` and `users`. No record rules.

### 3.1 `user` role — has read/create/update, lacks delete

| # | Case | Expectation |
|---|---|---|
| 39 | `read` every row in `todos` | All seeded rows returned (no record rule narrows) |
| 40 | `insertIntoTodos` | New row persists with the supplied FK; readback confirms |
| 41 | `updateTodos` against a cross-owner row | Update succeeds (no record rule scopes); ACL alone is verb-gating |
| 42 | `deleteFromTodos` | Errors with `/Access denied/`; row count unchanged |

### 3.2 `manager` role — full CRUD

| # | Case | Expectation |
|---|---|---|
| 43 | `read` every row | All rows visible |
| 44 | `updateUsers` someone else's row | Succeeds (cross-owner allowed at ACL layer with no rule) |
| 45 | `deleteFromUsers` someone else's row | Succeeds; only that row disappears |
| 46 | `insertIntoTodos` of their own | Persists |

### 3.3 Non-actor deny paths

| # | Case | Expectation |
|---|---|---|
| 47 | Role-less authenticated user, every verb | `Access denied` on read/create/update/delete; DB unchanged |
| 48 | Anonymous caller, every verb | `Not authenticated` on every verb |

---

## 4. `recordRules.test.ts` — Row-level scoping with full ACL grants

Suite: **`record rules — row-level scoping with full ACL grants`**

Config: `user` has full CRUD on `todos` with `ownerId = current_user.id` record rule on `read/update/delete`. `manager` has full CRUD with no record rule.

### 4.1 `user` role — scoped to own rows on read/update/delete

| # | Case | Expectation |
|---|---|---|
| 49 | Read | Only own rows; Bob/Carol excluded |
| 50 | Read with user-supplied `where` | `where` AND-s with scope rule (no escape via `where`) |
| 51 | Update own row | Persisted; FK preserved on readback |
| 52 | Cross-owner update | Returns `[]`; target row and own rows untouched |
| 53 | Delete own row | Total count drops by exactly one |
| 54 | Cross-owner delete | Returns `[]`; total count unchanged |
| 55 | Create new own row | Succeeds (no record rule scopes `create`) |

### 4.2 `manager` role — no record rule

| # | Case | Expectation |
|---|---|---|
| 56 | Read | Every row, all three owners represented |
| 57 | Update someone else's row | Visible to that user on readback through their scoped view |
| 58 | Delete someone else's row | Only that row disappears |
| 59 | Create own row | Persists |

### 4.3 Cross-actor isolation

| # | Case | Expectation |
|---|---|---|
| 60 | Manager edits Bob's row; Alice reads | Edit invisible to Alice (her scope filters Bob out) |
| 61 | Alice and Bob (same `user` role) read | Disjoint row sets |

---

## 5. `rbacDb.test.ts` — `RbacDb` proxy contracts

### 5.1 `rbacDb — proxy-specific contracts`

| # | Case | Expectation |
|---|---|---|
| 62 | Admin role through `rdb.select()` | Sees every row — enforcement short-circuits at rdb layer |
| 63 | `orderBy` + `limit` through the proxy | Order and length preserved |
| 64 | `bypassResources` on role-less user | Reads all rows verbatim |
| 65 | `rdb.sudo` | Reads and writes skip enforcement entirely |

### 5.2 `rbacDb.query — relational query API`

| # | Case | Expectation |
|---|---|---|
| 66 | `findMany` as reader | Record-rule `where` injected (own todos only) |
| 67 | `findFirst` as reader | Cannot see other actors' rows |
| 68 | `findMany` as admin (`isAdmin`) | Every row — no record-rule injection |
| 69 | `with:` one-level relation | Record rule applies on the related table |
| 70 | `with:` two-level nested | Record rules apply at every level |
| 71 | `query.<x>` with `bypassResources` | Falls through to raw `db.query` |
| 72 | `query` with `.sudo` passthrough | Skips enforcement |
| 73 | `findMany` without `read` ACL | Throws `FORBIDDEN` |
| 74 | Callback-form `where` + record rule | AND-combined (not OR, not overridden) |
| 75 | `with:` without `read` on related table | Throws |
| 76 | `with:` unknown relation key | Passes through unchanged — Drizzle surfaces the error |

### 5.3 `rbacDb.transaction — sync-dialect guard`

| # | Case | Expectation |
|---|---|---|
| 77 | `rdb.transaction(cb)` on better-sqlite3 (sync dialect) | Throws with a hint pointing at `.sudo.transaction` |
| 78 | `rdb.sudo.transaction(cb)` | Runs the sync callback (documented escape) |

---

## Coverage notes

- Every branch of `enforce` in `rbac.ts` is exercised in `rbac.unit.test.ts`: auth check, both cache-hit shapes, admin bypass, no-memberships deny, no-grant deny, missing-domain unrestricted, null-SQL unrestricted, single-rule short-circuit, multi-rule OR-combine, `memo` writes, and `denyAndThrow` writes.
- The `if (!role) continue` guards inside the resolved-config loops (lines around `accessByRoleId` / `rulesByRoleId` construction) are unreachable under normal flow because `buildRbacConfig` rejects rights/rules referencing unknown roles. They are defensive against future refactors and are intentionally not exercised.
- The `if (!perRole.length) return memo({})` line in `enforce` is currently unreachable: if all granting roles' domains compile to nothing, the `else anyUnrestricted = true` branch fires first. It remains as a defensive guard against future changes in `domainToSql` semantics.
