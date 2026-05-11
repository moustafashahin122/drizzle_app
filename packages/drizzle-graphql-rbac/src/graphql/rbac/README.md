# `graphql/rbac` — Odoo-style access control (in-memory)

Three-layer access control, declared in code and held entirely in process memory:

1. **Roles** with optional `isAdmin` short-circuit. There is no inheritance —
   each role's grants stand alone.
2. **Access rights** — per-role CRUD booleans on a resource (a table's JS
   schema key, e.g. `"todos"`). Union across the user's roles. Deny-by-default
   if no role grants the action.
3. **Record rules** — per-role row-level filters on `(resource, action)`,
   expressed as Odoo polish-prefix domains. Domains from roles granting the
   action are OR-combined and AND-ed into the resolver's `where`.

User → role assignments live in the engine alongside the snapshot; mutate them
via `assignRole` / `revokeRole`. Nothing is persisted — restarting the process
resets memberships to empty.

## Files

| File             | Role                                                                                        |
|------------------|---------------------------------------------------------------------------------------------|
| `config.ts`      | `defineRoles` / `defineAccessRights` / `defineRecordRules` helpers + `buildRbacConfig` validation (unknown role refs, unknown action keys, non-array domains). |
| `rbac.ts`        | Engine: builds the snapshot synchronously from the config, holds in-memory user→role assignments, exposes `enforce` + membership API. |
| `rbacDb.ts`      | Per-request Drizzle wrapper that runs `enforce` automatically on chained calls.             |
| `rbac.test.ts`   | Engine tests: domains, leaf operators, ACL semantics, record-rule combination.              |
| `rbacDb.test.ts` | Wrapper tests: where-injection, gated insert, bypass passthrough, raw escape hatch.         |

## Public API

```ts
import { buildRbac } from "./graphql/rbac/rbac.js";
import { buildRbacDb, RbacDb } from "./graphql/rbac/rbacDb.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./graphql/rbac/config.js";
// Domain syntax helpers:
import { parseDomain, domainToSql } from "./graphql/domain/domain.js";
```

- `defineRoles({...})` / `defineAccessRights({...})` / `defineRecordRules({...})`
  are identity helpers that exist for IDE autocomplete on role keys.
- `buildRbac(config)` → `{ enforce, listRoleKeys, listUserRoles, assignRole,
  revokeRole, hasRole }`. The snapshot is built immediately and synchronously.
- `assignRole(userId, roleKey)` / `revokeRole(userId, roleKey)` mutate the
  in-memory membership map. Throws on an unknown `roleKey`.

Example rule: `[["assigneeId", "=", "current_user.id"]]` — read only my own todos.

## Engine semantics (`enforce`)

For a single `(resource, action)` call:

1. Resolve the caller's role-id set from the in-memory map. If any role has
   `isAdmin: true` → return `{}` (no filter, no throw).
2. Find roles whose access-rights grant `(resource, action)`. None → throw
   `FORBIDDEN`.
3. Collect record rules for the granting roles (one rule per role per
   `(resource, action)`). Per-role filters OR together; a granting role with
   no rule means unrestricted access — if any granting role is unrestricted,
   the engine returns `{}`.

The per-request `batch` map caches each `(user, resource, action)` enforce
result so a single GraphQL request doesn't repeat work for every resolver.

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
  bootstrap (resolving the session token), seed scripts, and anywhere that
  runs before there is a user.
- `bypassResources: Set<string>` — resources whose calls pass through
  unchanged (e.g. `users` for the public `register` flow).
