# drizzle-graphql-rbac

> A batteries-included backend framework that turns a [Drizzle](https://orm.drizzle.team/) schema into a production-ready GraphQL + REST API — complete with authentication, sessions, and Odoo-style role-based access control.

A single `createApp(...)` call stands up an HTTP service with a fully-typed GraphQL CRUD layer, cookie/bearer authentication, an admin sub-app, and a row-level security engine governed by three small TypeScript files. No code generators, no migrations to write for the framework tables, no runtime schema drift.

## Highlights

- **Zero-boilerplate GraphQL CRUD.** Every table in your Drizzle namespace gets typed `Query` and `Mutation` fields — `list`, `single`, `insert`, `update`, `delete` — with filter, ordering, and pagination inputs derived from the column types.
- **Automatic relations.** Single-column foreign keys are promoted into forward (`one`) and inverse (`many`) GraphQL fields automatically; explicit Drizzle `relations(...)` declarations take precedence when you need them.
- **Built-in authentication.** REST `/auth/*` routes (`register`, `login`, `logout`, `me`) with bcrypt-hashed passwords and dual cookie + bearer-token sessions, ready to mount.
- **Admin sub-app.** REST `/admin/*` endpoints for user management and runtime role-membership changes, gated by the same RBAC engine that protects GraphQL.
- **Code-defined RBAC, DB-synced.** Roles, access rights, and record rules are declared in TypeScript and reconciled to the database on startup by external id (`xid`) — like Odoo's `xml_id`. Rename a role's key, the row persists; remove an entry, it cascade-deletes.
- **Row-level security with a domain DSL.** Per-role, per-action record rules written in an Odoo-style domain language (`["&", [...], ["|", [...], [...]]]`) are compiled to SQL and AND-injected into every read, update, and delete.
- **Per-request enforcement wrapper.** `rdbFor(ctx)` returns a Drizzle handle that automatically applies the caller's RBAC envelope to `select`, `insert`, `update`, `delete` — use it in custom routes and they're protected for free.
- **Multi-role union semantics.** Users may hold any number of roles; grants combine as the union and per-role record rules OR together. Matches Odoo's behavior exactly.
- **TTL + LRU caching.** Effective roles and per-`(user, resource, action)` enforce results are cached in-process with bounded size; surgical invalidation hooks are exposed.
- **Composable primitives.** `createApp` is a convenience layer over `buildSchema`, `buildRbac`, `buildRbacDb`, `buildAuthRoutes`, and `buildAdminRoutes` — use them directly when you need a custom pipeline.
- **Hermetic, no-mocks test suite.** Every subsystem is exercised end-to-end through the generated GraphQL schema against in-memory SQLite.

## At a glance

| Area              | What you get                                                                                |
|-------------------|---------------------------------------------------------------------------------------------|
| Transport         | Hono app exposing GraphQL (via `graphql-yoga`) and REST sub-apps; runs on any Web Fetch host. |
| Database          | Drizzle ORM. SQLite is the reference dialect; the engine only relies on `select()`.         |
| Auth              | Email + password, bcrypt-hashed, with cookie and `Authorization: Bearer` sessions.          |
| Authorization     | Code-defined roles, CRUD grants, and row-level rules; cache-backed enforcement.             |
| Persistence model | Six framework-owned tables: `users`, `sessions`, `roles`, `access_rights`, `record_rules`, `user_roles`. |
| Runtime mutation  | Only `user_roles` is written at runtime; role catalog and grants are code-only.             |

A working reference application is available in this monorepo's root (`../../`).

---

## Quick start

### 1. Install

```bash
npm install drizzle-graphql-rbac \
            drizzle-orm better-sqlite3 \
            graphql graphql-yoga hono @hono/node-server
```

The package treats `drizzle-orm`, `better-sqlite3`, `graphql`, `graphql-yoga`, and `hono` as peer dependencies. Other Drizzle dialects work — only `select()` is used internally — but the helpers in this README use SQLite for brevity.

### 2. Define your DB

Re-export the framework-owned tables alongside your own:

```ts
// src/db.ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { frameworkTables, users } from "drizzle-graphql-rbac";

export {
  users, sessions, roles, accessRights, recordRules, userRoles,
} from "drizzle-graphql-rbac";
export type {
  User, Session, UserRole, Role, AccessRight, RecordRule,
} from "drizzle-graphql-rbac";

export const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  assigneeId: integer("assignee_id").references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

const sqlite = new Database("app.db");
sqlite.pragma("foreign_keys = ON");
export const db = drizzle(sqlite, { schema: { ...frameworkTables, todos } });
```

The framework owns six tables: `users`, `sessions`, `roles`, `access_rights`, `record_rules`, `user_roles`. The last four are written by `syncRbacFromCode` on server start to mirror your code config — see below. Only `user_roles` is touched at runtime by the admin dashboard.

### 3. Define your RBAC config

Three files. Each entry carries an `xid` ("external id", like Odoo's `xml_id`) that anchors its identity in the DB across rebuilds — rename a role's key, the row stays; remove an xid, its row gets cascade-deleted on next sync.

The framework provides one role for free: `admin` (full bypass via `isAdmin: true`, xid `dgr.role.admin`). `createApp` merges it into your config automatically — **do not redeclare `admin`** or any xid that starts with the reserved `dgr.` prefix.

```ts
// src/roles.ts
import { defineRoles } from "drizzle-graphql-rbac";
export const roles = defineRoles({
  // 'admin' is provided by the framework — don't add it here.
  user: { xid: "app.role.user" },
  demo: { xid: "app.role.demo" },
});
```

```ts
// src/accessRights.ts
import { defineAccessRights } from "drizzle-graphql-rbac";
export const accessRights = defineAccessRights({
  demo: {
    todos: {
      xid: "app.ar.demo.todos",
      create: true, read: true, update: true, delete: true,
    },
  },
});
```

```ts
// src/recordRules.ts
import { defineRecordRules } from "drizzle-graphql-rbac";
const own = [["assigneeId", "=", "current_user.id"]];
export const recordRules = defineRecordRules({
  demo: {
    todos: {
      read:   { xid: "app.rr.demo.todos.read",   domain: own },
      update: { xid: "app.rr.demo.todos.update", domain: own },
      delete: { xid: "app.rr.demo.todos.delete", domain: own },
    },
  },
});
```

### 4. Wire the app

```ts
// src/server.ts
import { serve } from "@hono/node-server";
import { createApp } from "drizzle-graphql-rbac";
import * as schema from "./db.js";
import { roles } from "./roles.js";
import { accessRights } from "./accessRights.js";
import { recordRules } from "./recordRules.js";

const { app } = createApp({
  db: schema.db,
  schema,
  rbac: { roles, accessRights, recordRules },
});

serve({ fetch: app.fetch, port: 3000 });
```

That's the whole server. GraphiQL is at `/graphql`, REST auth at `/auth/*`, admin at `/admin/*`. The RBAC config sync runs in the background (via `queueMicrotask`) right after `serve(...)` starts listening — `createApp` returns immediately. Tests can `await app.rbacReady` if they need the snapshot loaded before issuing requests.

---

## Defining roles

`defineRoles` takes an object whose **keys** are short role names used in code, and whose **values** carry the metadata: a stable `xid` and an optional `isAdmin` flag. The framework already supplies an `admin` role — your file only declares the roles your app needs.

```ts
// src/roles.ts
import { defineRoles } from "drizzle-graphql-rbac";

export const roles = defineRoles({
  /** Logged-in user with no special powers — the default for new sign-ups. */
  user: { xid: "app.role.user" },

  /** Sees and edits todos in their team. */
  manager: { xid: "app.role.manager" },

  /** Read-only auditor — useful for compliance reviews. */
  auditor: { xid: "app.role.auditor" },
});

export type RoleKey = keyof typeof roles;
```

| Field     | Effect                                                                                      |
|-----------|---------------------------------------------------------------------------------------------|
| `xid`     | **Required.** Stable external id (like Odoo's `xml_id`). Anchors the DB row across rebuilds. Convention: `<app>.role.<name>`. Renaming the role key keeps the row; removing the entry cascade-deletes it (and its access-rights / record-rules / `user_roles` rows). |
| `isAdmin` | Optional. Members bypass every RBAC check. The framework already provides one — you should rarely need a second. |

There is **no inheritance** — each role's grants stand alone. If `manager` should also have what `user` has, restate those grants under `manager`, or assign both roles to the user via `user_roles`.

> Users hold roles via the `user_roles` table (FK to `roles.id`). The admin dashboard manages assignments at runtime; the role catalog itself is code-only.

### Framework-owned `admin` role

`createApp` automatically merges in `admin` (`isAdmin: true`, xid `dgr.role.admin`). App authors should not:

- declare a role with key `"admin"`, or
- use any xid starting with the reserved `dgr.` prefix.

`mergeFrameworkRbac` throws on either collision so the mistake surfaces on startup.

If you're calling `buildRbac` directly (lower-level than `createApp`) and want the framework admin, opt in:

```ts
import { mergeFrameworkRbac } from "drizzle-graphql-rbac";

const cfg = mergeFrameworkRbac({ roles, accessRights, recordRules });
const rbac = buildRbac(db, schema, cfg);
```

### What admins should not be

`isAdmin: true` is a full bypass — no ACL check, no record-rule filter. Don't put it on application roles. Use it for service accounts and dashboard admins; grant feature access through normal `accessRights` entries on non-admin roles.

---

## Defining access rights

`defineAccessRights` is a `role → resource → entry` map. Each entry says which CRUD verbs that role may perform on that resource.

```ts
// src/accessRights.ts
import { defineAccessRights } from "drizzle-graphql-rbac";

export const accessRights = defineAccessRights({
  user: {
    todos: {
      xid: "app.ar.user.todos",
      read: true,
      create: true,
      update: true,
      // delete: false — default; user can't delete todos.
    },
  },

  manager: {
    todos: {
      xid: "app.ar.manager.todos",
      read: true, create: true, update: true, delete: true,
    },
    users: {
      xid: "app.ar.manager.users",
      read: true, // managers can browse the user directory
    },
  },

  auditor: {
    todos: { xid: "app.ar.auditor.todos", read: true },
    users: { xid: "app.ar.auditor.users", read: true },
  },
});
```

### The shape

```ts
defineAccessRights({
  [roleKey]: {
    [resourceJsKey]: {
      xid:     string,    // required, globally unique
      create?: boolean,   // missing = false
      read?:   boolean,
      update?: boolean,
      delete?: boolean,
    },
  },
});
```

- **`roleKey`** must match a key from `defineRoles({...})` (or the framework's `admin`). `mergeFrameworkRbac` / `buildRbacConfig` throws on unknown role refs.
- **`resourceJsKey`** is the **JS export name** of the Drizzle table (e.g. `todos`, `users`) — not the SQL table name. The auto-generated GraphQL CRUD uses the same key, so the names line up by construction.
- **`xid` convention**: `<app>.ar.<role>.<resource>`. Stays stable even if you rename the role key.

### Deny by default

If no role the user holds grants `(resource, action)`, the engine throws `FORBIDDEN`. There is no implicit "everyone can read" — if you want one, define a `user` role, give it the grants, and assign `user` to everyone (or have your registration flow do it).

### How grants combine

A user with **multiple roles** gets the **union** of their grants. So a user in both `auditor` (read-only) and `manager` (full CRUD) has full CRUD on `todos`.

### Resources the framework owns

The auto-generated GraphQL CRUD applies to every table in your schema namespace, including the framework tables (`users`, `sessions`, `roles`, `access_rights`, `record_rules`, `user_roles`). If you don't want clients reading `sessions` over GraphQL, simply don't grant `sessions.read` to any role (the default) — admin tooling can use the unwrapped `rdb.raw` handle.

---

## Defining record rules

`defineRecordRules` narrows access **per row**. A role with `todos.read` granted can read all todos by default; add a record rule and the engine AND-injects an extra `WHERE` into every `read` query for that role.

```ts
// src/recordRules.ts
import { defineRecordRules } from "drizzle-graphql-rbac";

// Reusable domain: rows the current user owns.
const own = [["assigneeId", "=", "current_user.id"]];

export const recordRules = defineRecordRules({
  user: {
    todos: {
      // 'user' can read every todo, but only update or delete their own.
      update: { xid: "app.rr.user.todos.update", domain: own },
      delete: { xid: "app.rr.user.todos.delete", domain: own },
    },
  },

  manager: {
    todos: {
      // Managers see and edit todos in their team; the team id is stamped
      // onto each row at insert time.
      read: {
        xid: "app.rr.manager.todos.read",
        domain: [["teamId", "=", "current_user.teamId"]],
      },
      update: {
        xid: "app.rr.manager.todos.update",
        domain: [["teamId", "=", "current_user.teamId"]],
      },
    },
  },

  auditor: {
    todos: {
      // Auditors see only published, non-archived todos.
      read: {
        xid: "app.rr.auditor.todos.read",
        domain: ["&", ["state", "=", "published"], ["archived", "=", false]],
      },
    },
  },
});
```

### The shape

```ts
defineRecordRules({
  [roleKey]: {
    [resourceJsKey]: {
      read?:   { xid: string, domain: Domain },
      update?: { xid: string, domain: Domain },
      delete?: { xid: string, domain: Domain },
      create?: { xid: string, domain: Domain }, // ACL-only on insert; create
                                                // domains are accepted but
                                                // not currently enforced by
                                                // the auto-CRUD layer.
    },
  },
});
```

- **`xid` convention**: `<app>.rr.<role>.<resource>.<action>`.
- The DB enforces one rule per `(role, resource, action)` via a unique index — the entry above replaces, not stacks.
- A role that **grants** an action with **no rule** on it gets unrestricted access. So the `user` example above lets `user` *read* every todo (no rule) but only *update / delete* their own (rule per action).

### Domain syntax

A **domain** is an array of leaves and combinators. Each leaf is `[field, operator, value]`. The `field` must be a column on the resource table.

| Operator               | Notes                                                                |
|------------------------|----------------------------------------------------------------------|
| `=`, `!=`              | `null` on either side becomes `IS NULL` / `IS NOT NULL`.             |
| `<`, `<=`, `>`, `>=`   | Numeric / lexicographic depending on column type.                    |
| `in`, `not in`         | Value must be an array.                                              |
| `like`, `not like`     | Case-sensitive pattern match (SQL `LIKE`).                           |
| `ilike`, `not ilike`   | Case-insensitive pattern match.                                      |

Combinators are written in **prefix notation** as control strings followed by their operands:

| Token | Arity        |
|-------|--------------|
| `&`   | binary AND   |
| `\|`  | binary OR    |
| `!`   | unary NOT    |

Implicit AND: a flat list of leaves with no combinator is AND-ed together (Odoo's default).

```ts
// Implicit AND — both leaves must match.
[["state", "=", "open"], ["archived", "=", false]]

// Explicit AND (same meaning).
["&", ["state", "=", "open"], ["archived", "=", false]]

// OR.
["|", ["assigneeId", "=", "current_user.id"], ["state", "=", "public"]]

// NOT.
["!", ["archived", "=", true]]

// Mix: own todos OR (public AND not archived).
["|",
  ["assigneeId", "=", "current_user.id"],
  ["&", ["state", "=", "public"], ["archived", "=", false]],
]

// IN list.
[["priority", "in", ["high", "urgent"]]]
```

### Placeholders

The engine injects `{ "current_user.id": ctx.user?.id ?? null }` before evaluating each rule. Reference it as a *string value* — the engine substitutes it at enforce time:

```ts
const own = [["assigneeId", "=", "current_user.id"]];
```

Anonymous callers get `null`, which makes equality against the placeholder match no rows — the safe default. To add more placeholders (e.g. `current_user.teamId` from a custom user shape), wrap `enforce` yourself; see "Going off the rails" below.

### How rules combine across roles

If a user holds **multiple roles** that all grant the same action, their per-role rules **OR** together — holding *any* qualifying role is enough. So a user with both `manager` (sees their team's todos) and `auditor` (sees published todos) sees the union: their team's todos *or* any published todo.

A granting role with **no rule** on `(resource, action)` is unrestricted on that grant — and unrestricted ORed with anything is still unrestricted. So mixing a role with no rule and a role with a rule yields no row filter at all (matches Odoo).

### Putting it together (worked example)

Given the three files above, a request from a user holding only `user`:

| Operation                             | Outcome                                                            |
|---------------------------------------|--------------------------------------------------------------------|
| `query { todos { id } }`              | Lists every todo (read granted, no rule).                          |
| `mutation updateTodos(...)` mine      | Succeeds — rule says `assigneeId = current_user.id`.               |
| `mutation updateTodos(...)` someone else's | `WHERE` narrows to my own; zero rows updated. No error.       |
| `mutation deleteFromTodos(...)`       | Same as above — only my own get deleted.                           |
| `mutation insertIntoTodos(...)`       | Granted (`create: true`).                                          |
| `query { users { id } }`              | `FORBIDDEN` — `user` has no grant on `users`.                      |

A granting role with no rule on `(resource, action)` grants unrestricted access. Mixing such a role with a rule-bearing role yields unrestricted access — same as Odoo: "no rule" means "no row restriction".

---

## Managing role membership at runtime

Roles themselves are immutable from the dashboard, but membership is fully dynamic. The framework mounts these REST endpoints under `/admin/*`:

| Method | Path                          | Body            | Returns                          |
|--------|-------------------------------|-----------------|----------------------------------|
| GET    | `/admin/roles`                | —               | `{ roles: string[] }`            |
| GET    | `/admin/users/:id/roles`      | —               | `{ userId, roles: string[] }`    |
| POST   | `/admin/users/:id/roles`      | `{ roleKey }`   | `{ userId, roles }` (201)        |
| DELETE | `/admin/users/:id/roles/:key` | —               | `{ userId, roles }` (200)        |

- All endpoints require an authenticated session.
- `GET` requires the caller to have `users.read`; `POST` / `DELETE` require `users.update`.
- Posting a `roleKey` that doesn't match any synced row in the `roles` table returns 400.
- Membership changes invalidate the RBAC cache for the affected user, so the next request sees the new set.

There is no endpoint for creating or deleting roles. To change what a role can do, edit `roles.ts` / `accessRights.ts` / `recordRules.ts` and redeploy — `syncRbacFromCode` reconciles the DB on next start. Removed roles cascade-delete their `user_roles` / AR / RR rows.

---

## What you get from `createApp`

```ts
const {
  app,
  rdbFor,
  invalidateRbacUser,
  clearRbacCache,
  rbacReady, // Promise<void> — resolves once the background sync + snapshot load is done
} = createApp({
  db,
  schema,
  rbac: { roles, accessRights, recordRules },

  // All optional:
  hiddenOutputColumns: { users: ["passwordHash"] }, // default
  typeNames:           { /* override generated GraphQL type names */ },
  extraQueryFields:    { /* bespoke Query fields */ },
  extraMutationFields: { /* bespoke Mutation fields */ },
  publicDir:           "./public", // null to disable static serving
  graphqlEndpoint:     "/graphql",
  logger:              true,        // boolean | (msg, ...rest) => void
  rbacCache:           { cacheTtlMs: 30 * 60 * 1000 },
});
```

- `app` — a Hono app. Pass `app.fetch` to `@hono/node-server`'s `serve`, or to any Web Fetch host.
- `rdbFor(ctx)` — per-request RBAC-bound Drizzle wrapper. Use it in custom routes so they're enforced just like the auto-CRUD.
- `invalidateRbacUser(userId)` — drop one user's cached roles + enforce results.
- `clearRbacCache()` — drop everything.
- `rbacReady` — resolves when the background sync + snapshot load finishes. The server starts listening immediately; the very first requests may be denied (deny-all default) until the sync completes (usually a few ms against SQLite). Awaiting is optional but useful in tests.

### Per-request RBAC db

Inside a custom Hono route, build a wrapped Drizzle handle for the current user and let it gate everything:

```ts
app.get("/me/todos", async (c) => {
  const user = c.get("user");
  const rdb = rdbFor({ user, batch: new Map() });
  const rows = await rdb.select().from(todos); // automatically RBAC-filtered
  return c.json({ rows });
});
```

The wrapper supports `select`, `update`, `delete`, `insert` and forwards `where`, `orderBy`, `limit`, `offset`, joins, `set`, `values`, `returning`. Awaiting the chain is the finalization point — that's when `enforce` runs and the record-rule SQL is AND-injected into your where clause.

### Escape hatches

- `rdb.raw` — the unwrapped Drizzle handle. Use it for the pre-auth bootstrap (resolving the session token), seed scripts, and anywhere that runs before there is a user.
- `bypassResources: Set<string>` — when constructing a custom `RbacDb`, list resources whose calls should pass through unchanged (e.g. `users` for the public `register` flow).

---

## Going off the rails (using primitives directly)

`createApp` is a convenience wrapper. The pieces are exposed individually so you can compose your own pipeline:

```ts
import {
  buildSchema,            // GraphQL CRUD generator
  buildRbac,              // RBAC engine
  buildRbacDb,            // per-request Drizzle wrapper
  buildAuthRoutes,        // /auth/* sub-app
  buildAdminRoutes,       // /admin/* sub-app
  sessionMiddleware,
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "drizzle-graphql-rbac";

const rbac = buildRbac(
  db,
  {
    roles: schema.roles,
    accessRights: schema.accessRights,
    recordRules: schema.recordRules,
    userRoles: schema.userRoles,
  },
  { roles, accessRights, recordRules },
);

// Run the sync against the DB and load the snapshot before serving traffic.
await rbac.sync();

const { schema: gqlSchema } = buildSchema(db, schema, {
  rbac: { enforce: rbac.enforce },
  hiddenOutputColumns: { users: ["passwordHash"] },
});

const rdbFor = buildRbacDb({ db, schema, enforce: rbac.enforce });
```

`buildRbac` returns `{ enforce, invalidateUser, clearCache, sync, refreshSnapshot, getSnapshot }`. You can also call `syncRbacFromCode` and `loadRbacSnapshot` directly (e.g. in seed scripts) — see `src/graphql/rbac/sync.ts`.

You can write a custom `enforce` if you want extra placeholders, multi-tenancy filters, or audit logging — it just needs to return `Promise<{ where?: SQL }>` (and throw `GraphQLError` with `extensions.code = "FORBIDDEN"` to deny). See `src/graphql/rbac/rbac.ts` for the reference implementation.

---

## Caching

`buildRbac` keeps two TTL+LRU caches per process:

- Effective roles per user — the role keys held + the `isAdmin` flag.
- Per-`(userId, resource, action)` enforce result — either the SQL fragment or a `__forbidden` marker carrying the deny message.

Both share one TTL. Defaults are `cacheTtlMs: 0` for direct `buildRbac` callers (off — every request hits the DB) and `30 * 60 * 1000` for `createApp` (30-minute TTL with bounded size). Pass `rbacCache: { cacheTtlMs: 0 }` to disable, or call `invalidateRbacUser(id)` after any out-of-band change to a user's `user_roles` rows.

The admin role-membership endpoints already invalidate the affected user. Custom code that writes to `user_roles` directly should do the same.

---

## DB bootstrap

The framework owns six tables (`users`, `sessions`, `roles`, `access_rights`, `record_rules`, `user_roles`), but `drizzle-kit` cannot load this package's TS-only entry point in CJS mode, so its `push` / `generate` commands fail. Two reliable paths:

1. **One-shot CREATE** — run a small script (see the reference app's `src/scripts/init-db.ts`) that issues `CREATE TABLE IF NOT EXISTS` for the six framework tables plus your app tables. Idempotent and works in production. The runtime sync routine fills `roles` / `access_rights` / `record_rules` from the code config.
2. **Hand-written migrations** — once you publish a built dist of this package, `drizzle-kit` will resolve it normally and the standard `db:generate` / `db:migrate` flow works.

RBAC schema reference:

```sql
CREATE TABLE roles (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  xid       TEXT    NOT NULL UNIQUE,
  key       TEXT    NOT NULL UNIQUE,
  is_admin  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE access_rights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  xid         TEXT    NOT NULL UNIQUE,
  role_id     INTEGER NOT NULL REFERENCES roles(id),
  resource    TEXT    NOT NULL,
  can_create  INTEGER NOT NULL DEFAULT 0,
  can_read    INTEGER NOT NULL DEFAULT 0,
  can_update  INTEGER NOT NULL DEFAULT 0,
  can_delete  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ar_role_resource_uniq ON access_rights(role_id, resource);
CREATE TABLE record_rules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  xid       TEXT    NOT NULL UNIQUE,
  role_id   INTEGER NOT NULL REFERENCES roles(id),
  resource  TEXT    NOT NULL,
  action    TEXT    NOT NULL,
  domain    TEXT    NOT NULL  -- JSON-encoded domain
);
CREATE UNIQUE INDEX rr_role_res_act_uniq ON record_rules(role_id, resource, action);
CREATE TABLE user_roles (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id),
  role_id  INTEGER NOT NULL REFERENCES roles(id)
);
CREATE UNIQUE INDEX ur_user_role_uniq ON user_roles(user_id, role_id);
```

The sync routine matches code entries to DB rows by `xid`. Renaming a role's `key` keeps the row; removing the entry from code cascade-deletes its `user_roles` / AR / RR rows on the next sync.

---

## Layout of this package

| Path                                   | What's there                                                             |
|----------------------------------------|--------------------------------------------------------------------------|
| `src/index.ts`                         | Public surface — re-exports everything below.                            |
| `src/app.ts`                           | `createApp` composition root.                                            |
| `src/tables.ts`                        | Drizzle definitions for `users`, `sessions`, `roles`, `access_rights`, `record_rules`, `user_roles`. |
| `src/auth/`                            | `/auth/*` REST sub-app, session primitives, Hono middleware.             |
| `src/admin/`                           | `/admin/*` REST sub-app (user CRUD + role membership).                   |
| `src/graphql/builder/`                 | Schema generator: types, root fields, where/orderBy translation.         |
| `src/graphql/relations.ts`             | Relation introspection (explicit + auto-promoted single-column FK).      |
| `src/graphql/rbac/config.ts`           | `defineRoles` / `defineAccessRights` / `defineRecordRules` + validation. |
| `src/graphql/rbac/rbac.ts`             | The `enforce` engine + snapshot accessors.                               |
| `src/graphql/rbac/sync.ts`             | DB ↔ code reconciliation by `xid` + snapshot loader.                     |
| `src/graphql/rbac/rbacDb.ts`           | Per-request Drizzle proxy that auto-runs `enforce`.                      |
| `src/graphql/rbac/cache.ts`            | TTL+LRU caches for effective roles and enforce results.                  |
| `src/graphql/domain/`                  | Odoo-style domain parser + SQL translator.                               |

Each subdirectory has its own README that goes deeper.

---

## Testing

```bash
npm test --workspace drizzle-graphql-rbac
```

Tests use Node's built-in test runner via `tsx`, with hermetic in-memory SQLite databases per file. They exercise the engine and the wrapper end-to-end through the generated GraphQL schema, so the schema-as-output is the contract under test — when changing builder/filter/relation/RBAC logic, prefer adjusting or adding queries in the existing `*.test.ts` files over mocking internals.
