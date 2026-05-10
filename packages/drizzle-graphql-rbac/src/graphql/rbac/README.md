# `graphql/rbac` — Odoo-style access control

Three-layer access control, declared in code and synced to DB tables by `xid`:

1. **Roles** with optional `isAdmin` short-circuit. There is no inheritance —
   each role's grants stand alone.
2. **Access rights** — per-role CRUD booleans on a resource (a table's JS
   schema key, e.g. `"todos"`). Union across the user's roles. Deny-by-default
   if no role grants the action.
3. **Record rules** — per-role row-level filters on `(resource, action)`,
   expressed as Odoo polish-prefix domains. Domains from roles granting the
   action are OR-combined and AND-ed into the resolver's `where`.

All three are declared in TypeScript with `xid`-bearing entries; `syncRbacFromCode`
materializes them into the matching DB tables on server start. The user → role
assignment lives in the `user_roles` table (FK to `roles.id`).

## Files

| File             | Role                                                                                        |
|------------------|---------------------------------------------------------------------------------------------|
| `config.ts`      | `defineRoles` / `defineAccessRights` / `defineRecordRules` helpers + `buildRbacConfig` validation (xid uniqueness, unknown role refs, unknown action keys, missing xids). |
| `sync.ts`        | `syncRbacFromCode` (DB ↔ code reconciliation by `xid`) + `loadRbacSnapshot` (engine snapshot loader). |
| `rbac.ts`        | Engine: snapshot-driven `enforce` factory. Delegates domain parsing/translation to `../domain`. |
| `cache.ts`       | Two-store TTL+LRU cache (effective roles + per-`(user,resource,action)` enforce result).    |
| `rbacDb.ts`      | Per-request Drizzle wrapper that runs `enforce` automatically on chained calls.             |
| `rbac.test.ts`   | Engine tests: domains, leaf operators, ACL semantics, record-rule combination.              |
| `rbacDb.test.ts` | Wrapper tests: where-injection, gated insert, bypass passthrough, raw escape hatch.         |
| `sync.test.ts`   | Sync tests: insert / update / cascade-delete / idempotency.                                  |

## Public API

```ts
import { buildRbac } from "./graphql/rbac/rbac.js";
import { buildRbacDb, RbacDb } from "./graphql/rbac/rbacDb.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./graphql/rbac/config.js";
import {
  syncRbacFromCode,
  loadRbacSnapshot,
  syncAndSnapshot,
} from "./graphql/rbac/sync.js";
// Domain syntax helpers:
import { parseDomain, domainToSql } from "./graphql/domain/domain.js";
```

- `defineRoles({...})` / `defineAccessRights({...})` / `defineRecordRules({...})`
  are identity helpers that exist for IDE autocomplete on role keys. Each
  entry **must** include a string `xid`.
- `buildRbac(db, { roles, accessRights, recordRules, userRoles }, config)` →
  `{ enforce, invalidateUser, clearCache, sync, refreshSnapshot, getSnapshot }`.
  The engine starts with an empty snapshot (deny-all); call `sync()` (or let
  `createApp` do it for you in the background) to reconcile and load.
- `syncRbacFromCode(db, schema, resolved)` reconciles the DB (delete missing
  xids, upsert by xid, content-compare on update) and returns counts.
- `loadRbacSnapshot(db, schema)` reads the four tables into the runtime
  snapshot the engine consults.

Example rule: `[["assigneeId", "=", "current_user.id"]]` — read only my own todos.

## Engine semantics (`enforce`)

For a single `(resource, action)` call:

1. Resolve the caller's role-id set from `user_roles`. If any of those roles
   has `isAdmin: true` in the snapshot → return `{}` (no filter, no throw).
2. Find roles whose `access_rights` row in the snapshot grants `(resource, action)`.
   None → throw `FORBIDDEN`.
3. Collect record rules for the granting roles (one rule per role per
   `(resource, action)`, by the unique index). Per-role filters OR together;
   a granting role with no rule means unrestricted access — if any granting
   role is unrestricted, the engine returns `{}`.

The per-request `batch` map caches the role-id lookup so a single GraphQL
request doesn't repeat the read for every resolver.

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
