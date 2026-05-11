# RBAC sync from code → DB, and runtime invalidation

This repo’s RBAC system has **two distinct “truth layers”**:

- **Code-defined RBAC definition**: roles, access rights, record rules (declared in TypeScript; each item has an `xid`).
- **Runtime user assignments**: which users have which roles (stored in the DB table `user_roles` and mutated at runtime).

Everything in the first bucket is treated as **configuration** (changes only by changing code + restarting). Everything in the second bucket is treated as **data** (changes while the process is running).

The system exists in three representations that must stay aligned:

1. **Code config** (TypeScript objects)
2. **DB rows** (`roles`, `access_rights`, `record_rules`)
3. **In-memory snapshot** (a compact Map-based structure the engine consults on each request)

The sync and invalidation logic is basically: **“code is the source of truth for definitions → DB is reconciled to match code → engine snapshot is reloaded from DB → any cached decisions are cleared.”**

---

## Big picture: what “sync” and “invalidation” mean here

### Sync (definitions)

“Sync” means:

- Take the **resolved** RBAC config from code (roles/access rights/record rules).
- Ensure the DB tables contain **exactly** those entries (by `xid`).
  - If an `xid` exists in DB but not in code anymore → delete it.
  - If an `xid` exists in code but not in DB → insert it.
  - If an `xid` exists in both but fields differ → update it.

This reconciliation is implemented in `packages/drizzle-graphql-rbac/src/graphql/rbac/sync.ts` as `syncRbacFromCode(...)`.

### Invalidation (runtime decisions)

During request handling, the engine caches certain RBAC computations:

- **Per-request** caching: stored in `ctx.batch` (a `Map`) so one GraphQL request doesn’t recompute the same RBAC check across multiple resolvers.
- **Cross-request** caching (optional TTL+LRU): stored in `RbacCache` so repeated requests don’t re-read `user_roles` and don’t rebuild record-rule SQL every time.

When something changes that could make those cached answers wrong, we “invalidate”:

- **Per-user invalidation**: clear cached results for that user (roles + enforce results).
- **Global invalidation**: clear the entire cache (used after definition sync or snapshot refresh).

This is implemented in `packages/drizzle-graphql-rbac/src/graphql/rbac/cache.ts` and wired in `packages/drizzle-graphql-rbac/src/graphql/rbac/rbac.ts`.

---

## Where sync is triggered

### On app startup (background sync)

`createApp(...)` constructs the RBAC engine (via `buildRbac(...)`) and then kicks off `rbac.sync()` in the background using `queueMicrotask` (see `packages/drizzle-graphql-rbac/src/app.ts`).

Why `queueMicrotask`?

- It allows the host to call `serve({ fetch: app.fetch, ... })` and start listening immediately.
- RBAC sync and snapshot load happen “right after” startup, without blocking startup.

The trade-off is explicit: the engine starts with an **empty snapshot** (deny-all), so the **very first requests** can be denied until the background sync finishes. In practice (SQLite, tiny tables) this is usually milliseconds.

The app exposes `rbacReady: Promise<void>` so tests (or strict bootstraps) can `await` RBAC being synced and loaded.

### In scripts (one-shot sync)

Seed/admin scripts often run sync explicitly before relying on roles existing. For example, `src/scripts/seed-admin.ts` syncs definitions first, then inserts a `user_roles` row referencing the `admin` role.

---

## Phase-by-phase: how `syncRbacFromCode` reconciles DB state

The sync is designed to be **idempotent**: calling it twice with the same config should make the second call a no-op.

There are three phases, always in this order:

1. **Roles**
2. **Access rights**
3. **Record rules**

That order matters because access rights and record rules reference roles, and the sync needs a stable `roleId` lookup first.

### Core identity concept: `xid`

Every RBAC definition entry in code has a stable string `xid` (“external id”). The sync uses `xid` as the durable identity:

- DB reconciliation identity is **`xid`**
- Not DB `id` (generated), not role `key` (human-friendly), not `(role, resource)` (composite)

This gives you a powerful property: **you can change names and details without changing identity**, as long as `xid` stays the same.

### Phase 1: roles

Implementation: `packages/drizzle-graphql-rbac/src/graphql/rbac/sync.ts`.

Flow:

- Build `codeRolesByXid` from `config.roles`.
- Load all DB roles.
- Compute “orphans”: DB roles whose `xid` is not present in code.
- For orphan roles, delete in a safe order:
  - delete `user_roles` rows referencing those role ids
  - delete `access_rights` rows referencing those role ids
  - delete `record_rules` rows referencing those role ids
  - delete the `roles` rows

Then upsert by `xid`:

- If `xid` missing in DB → insert `{ xid, key, isAdmin }`
- Else if `(key, isAdmin)` differs → update the row in place

Finally it reloads roles to build:

- `roleIdByKey: roleKey → roles.id`

That mapping is used in the next phases.

### Phase 2: access rights

Access rights are per-role per-resource CRUD grants.

Flow:

- Delete orphan access rights: DB rows whose `xid` disappeared from code.
- For each access-right definition in code:
  - resolve `roleId` by `roleKey` (throws if the role key doesn’t exist)
  - insert if missing by `xid`
  - else update if any of these changed:
    - `roleId`, `resource`, `canCreate`, `canRead`, `canUpdate`, `canDelete`

### Phase 3: record rules

Record rules are per-role row-level filters for a `(resource, action)` pair.

Flow:

- Delete orphan record rules: DB rows whose `xid` disappeared from code.
- For each record-rule definition in code:
  - resolve `roleId` by `roleKey` (throws if unknown)
  - serialize the domain: `domainJson = JSON.stringify(r.domain)`
  - insert if missing by `xid`
  - else update if any of these changed:
    - `roleId`, `resource`, `action`, `domain`

Domains are stored as a JSON string in the DB, then parsed back when loading the snapshot.

---

## After sync: how the in-memory RBAC snapshot is built

The enforcement engine doesn’t query RBAC definition tables on every check; it consults an in-memory **snapshot**, built by `loadRbacSnapshot(db, schema)` in `sync.ts`.

Snapshot structure (simplified mental model):

- **`rolesById`**: roleId → `{ key, isAdmin }`
- **`accessByRole`**: roleId → resource → set of allowed actions (`"create" | "read" | "update" | "delete"`)
- **`rulesByRole`**: roleId → resource → action → domain array

How it’s loaded:

- 1 query to `roles` to build `rolesById`
- 1 query to `access_rights` to build action sets
- 1 query to `record_rules` to parse and attach domains

In `rbac.ts`, `rbac.sync()` does:

1. `syncRbacFromCode(...)`
2. `snapshot = await loadRbacSnapshot(...)`
3. `cache.clear()` (global invalidation)

So definition sync always ends with a fresh snapshot and a cache flush.

---

## What gets cached at runtime (and what “invalidation” clears)

There are two caching layers.

### Per-request cache (`ctx.batch`)

`createApp` creates a `batch: Map<string, unknown>` per GraphQL request and passes it as part of RBAC context. This avoids duplicate RBAC work inside one GraphQL operation.

It caches:

- the user’s resolved `{ roleIds, isAdmin }`
- the enforce result `{ where?: SQL }` or a cached denial marker

### Cross-request cache (`RbacCache`, optional)

`RbacCache` is TTL+LRU and caches across requests:

1. **Effective roles per user**: `userId → { roleIds, isAdmin }`
2. **Enforce result per triple**: `(userId, resource, action) → { where?: SQL } | { __forbidden }`

It’s enabled only when `cacheTtlMs > 0`. `createApp` currently defaults this to 30 minutes unless overridden.

---

## When invalidation happens

### Definition changes: sync and snapshot replace (global clear)

When `rbac.sync()` runs:

- DB definition tables may change
- snapshot is replaced with a newly loaded one
- **the entire cross-request cache is cleared** (`cache.clear()`)

That’s necessary because definition changes can affect *any* user and *any* `(resource, action)` decision.

### Snapshot reload without sync (global clear)

When `rbac.refreshSnapshot()` runs:

- snapshot is replaced
- **the entire cache is cleared**

This is meant for cases where something external changed RBAC definition tables in DB (not the intended operational model, but supported).

### User membership changes: `user_roles` updates (per-user invalidate)

When a user’s role assignments change (admin routes) or when a user signs out:

- the app calls `invalidateUser(userId)`
- that clears that user’s cached roles and enforce results (both stores)

This is the minimal invalidation required when only one user’s assignments changed.

---

## Mental model: startup → first request

1. Process starts.
2. RBAC engine is created with an **empty snapshot** (deny-all).
3. App starts listening immediately.
4. Microtask runs `rbac.sync()`:
   - DB definitions are reconciled by `xid`
   - snapshot is loaded from DB
   - global RBAC caches are cleared
5. Requests run:
   - user’s roles are read from `user_roles`
   - those role ids are interpreted through the snapshot (grants + rules)
   - record rules (if any) become SQL filters AND-ed into the resolver’s `where`

---

## Subtle edge cases / failure modes

### “First requests may be denied”

Because the engine starts deny-all and sync is backgrounded, a request arriving immediately after boot can be rejected until sync completes.

Mitigations:

- In production boot, await `rbacReady` before advertising readiness (or before accepting traffic behind a load balancer).
- Alternatively, change boot to run `rbac.sync()` synchronously.

### Snapshot lag versus DB

Role resolution deliberately drops `roleId`s not present in `snapshot.rolesById`. Even with DB FKs, the snapshot can briefly lag during startup or if you refresh it at runtime. Dropping unknown ids is the safe default (prevents phantom permissions).

### Domain JSON stability

Record-rule updates compare stored `domain` string to `JSON.stringify(r.domain)`. If the same domain can serialize differently (object key order, etc.), you could see “updates” that don’t change semantics. In practice, domains tend to be arrays and stringify stably.

---

## Suggested optimizations

### Low-risk (keep the same model)

- **Transactional sync**: wrap the whole 3-phase sync in a DB transaction so readers never observe a partially reconciled state; also usually faster.
- **DB-native upserts**: use `ON CONFLICT (xid) DO UPDATE` (or dialect equivalent) to reduce round-trips and simplify logic.
- **Skip snapshot reload + cache clear when nothing changed**:
  - If `SyncResult` is all zeros, you can keep the existing snapshot and keep caches warm.
  - This is a nice win if you ever run sync more than once per boot (tests, dev, or a future “periodic reconcile” mode).
- **Avoid the nested-loop cleanup in orphan-role deletion**:
  - Right now, deleted role ids are removed from `dbRolesByXid` by scanning the map repeatedly.
  - Easier: build `orphanXids` directly, or rebuild the map after deletions.

### Operational / correctness knobs

- **Offer a “strict readiness” mode**: an option in `createApp` to run sync+snapshot before returning (or before mounting routes), so you never have a deny-all window.
- **Version the snapshot**: keep an incrementing `snapshotVersion` and store it in cache entries; a version mismatch is treated as a cache miss. This makes invalidation robust and cheap.

### Bigger wins (only if RBAC grows significantly)

- **Coalesce concurrent cache misses**: keep an in-flight promise map so that concurrent requests for the same `(userId, resource, action)` don’t all rebuild the same computation on a cold cache.
- **Precompute per-role/per-resource grant maps at build time**: the snapshot already does this, but you could also precompute “granting role ids per `(resource, action)`” if you ever have lots of roles.

---

## Practical guidance

### When you edit `src/roles.ts`, `src/accessRights.ts`, or `src/recordRules.ts`

- Restart the server.
- The background sync reconciles DB definitions and reloads the snapshot.
- Cross-request RBAC caches are cleared automatically as part of `rbac.sync()`.

### When you change a user’s assignments in admin routes

- Make sure to call `invalidateUser(userId)` after modifying `user_roles`.
- The built-in admin routes already do this via `onRolesChanged`.

### When writing tests

- If your test needs RBAC ready immediately, `await app.rbacReady` before issuing requests.

