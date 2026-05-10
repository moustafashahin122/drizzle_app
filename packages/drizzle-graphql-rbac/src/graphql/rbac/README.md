# `graphql/rbac` — Odoo-style access control

Three-layer access control:

1. **Groups** (roles) with optional `parentGroupId` inheritance. Membership is
   transitive — being in a child group implies being in every ancestor. A
   group flagged `isAdmin` short-circuits all checks.
2. **Access rights** — per-group CRUD booleans on a resource (a table's JS
   schema key, e.g. `"todos"`). Union across the user's effective groups.
   Deny-by-default if no group grants the action.
3. **Record rules** — per-group row-level filters on `(resource, permType)`,
   expressed as Odoo polish-prefix domains. Domains from groups granting the
   action are OR-combined and AND-ed into the resolver's `where`.

## Files

| File             | Role                                                                                        |
|------------------|---------------------------------------------------------------------------------------------|
| `rbac.ts`        | Engine: group resolution, record-rule combination, `enforce` factory. Delegates domain parsing/translation to `../domain`. |
| `rbacDb.ts`      | Per-request Drizzle wrapper that runs `enforce` automatically on chained calls.             |
| `rbac.test.ts`   | Engine tests: domains, leaf operators, ACL semantics, record-rule combination.              |
| `rbacDb.test.ts` | Wrapper tests: where-injection, gated insert, bypass passthrough, raw escape hatch.         |

## Public API

```ts
import { buildRbac } from "./graphql/rbac/rbac.js";
import { buildRbacDb, RbacDb } from "./graphql/rbac/rbacDb.js";
// Domain syntax helpers live in their own module:
import { parseDomain, domainToSql } from "./graphql/domain/domain.js";
import type {
  RbacContext,
  RbacEnforce,
  RbacSchema,
  Action,
} from "./graphql/rbac/rbac.js";
```

- `buildRbac(db, { groups, userGroups, accessRights, recordRules })` →
  `{ enforce }`. Pass `enforce` to `buildSchema({ rbac: { enforce } })` so
  every auto-CRUD resolver checks access before hitting the DB.
- `buildRbacDb({ db, schema, enforce, bypassResources? })` →
  `(ctx) => RbacDb`. Per-request factory; the returned wrapper runs `enforce`
  on every `select` / `update` / `delete` / `insert` call and AND-injects the
  record-rule SQL into the user's `where`.
- `parseDomain` / `domainToSql` — re-exported from `../domain`. The engine
  passes `{ "current_user.id": ctx.user?.id ?? null }` as the placeholder map
  on every call. See `../domain/README.md` for the full syntax reference.

Example rule: `[["assigneeId", "=", "current_user.id"]]` — read only my own
todos.

## Engine semantics (`enforce`)

For a single `(resource, action)` call:

1. Resolve the caller's effective group set (BFS through `parentGroupId`,
   visited-set guard against cycles). Admin → return `{}` (no filter, no
   throw).
2. Look up granting `accessRights` rows for `(resource, action)` across those
   groups. None → throw `FORBIDDEN`.
3. Collect `recordRules` for the granting groups. Within a group, rules AND
   together (additional restrictions on that group's grant). Across groups,
   per-group filters OR (being in any qualifying group is enough).
4. **A granting group with no rule grants unrestricted access** — if any such
   group exists, the engine returns `{}`. This is intentional and matches
   Odoo: "no rule" means "no row restriction".

The per-request `batch` map caches the effective group lookup so a single
GraphQL request doesn't repeat the BFS for every resolver.

## `RbacDb` chain semantics

Resolvers should use `ctx.db` (the wrapper) instead of the raw `db`. The
wrapper mirrors the Drizzle chain API for the methods resolvers use
(`from`, `where`, `orderBy`, `limit`, `offset`, joins, `set`, `values`,
`returning`). Other methods are forwarded transparently.

Awaiting the chain (`then` / `catch` / `finally`) is the finalization point —
that's when `enforce` runs and the combined `where` is attached:

- `select().from(t)` → enforces `read`, AND-injects.
- `update(t).set(...).where(...)` → enforces `update`, AND-injects.
- `delete(t).where(...)` → enforces `delete`, AND-injects.
- `insert(t).values(...)` → enforces `create` ACL only (no record rule).

Escape hatches:

- `rdb.raw` — the underlying unwrapped Drizzle handle. Use for the pre-auth
  bootstrap (resolving the session token), seed scripts, and the RBAC
  engine itself — anything that runs before there is a user.
- `bypassResources: Set<string>` — resources whose calls pass through
  unchanged (e.g. `users` for the public `register` flow).
