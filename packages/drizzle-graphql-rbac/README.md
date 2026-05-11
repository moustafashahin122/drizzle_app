# drizzle-graphql-rbac

> A batteries-included backend framework that turns a [Drizzle](https://orm.drizzle.team/) schema into a production-ready GraphQL + REST API — complete with authentication, sessions, and Odoo-style role-based access control.

A single `createApp(...)` call stands up an HTTP service with a fully-typed GraphQL CRUD layer, cookie/bearer authentication, an admin sub-app, and a row-level security engine governed by three small TypeScript files. RBAC is fully **in-memory** in this build: the engine is constructed synchronously on startup from your code config and there is no RBAC schema to migrate.

## Highlights

- **Zero-boilerplate GraphQL CRUD.** Every table in your Drizzle namespace gets typed `Query` and `Mutation` fields — `list`, `single`, `insert`, `update`, `delete` — with filter, ordering, and pagination inputs derived from the column types.
- **Automatic relations.** Single-column foreign keys are promoted into forward (`one`) and inverse (`many`) GraphQL fields automatically; explicit Drizzle `relations(...)` declarations take precedence when you need them.
- **Built-in authentication.** REST `/auth/*` routes (`register`, `login`, `logout`, `me`) with bcrypt-hashed passwords and dual cookie + bearer-token sessions, ready to mount.
- **Admin sub-app.** REST `/admin/*` endpoints for user management and runtime role-membership changes, gated by the same RBAC engine that protects GraphQL.
- **Code-defined, in-memory RBAC.** Roles, access rights, and record rules are declared in TypeScript and compiled into the engine snapshot at startup — no migrations, no sync routines, no DB drift. User → role assignments live in process memory and can be mutated at runtime via the REST API or the engine handle.
- **Row-level security with a domain DSL.** Per-role, per-action record rules written in an Odoo-style domain language (`["&", [...], ["|", [...], [...]]]`) are compiled to SQL and AND-injected into every read, update, and delete.
- **Per-request enforcement wrapper.** `rdbFor(ctx)` returns a Drizzle handle that automatically applies the caller's RBAC envelope to `select`, `insert`, `update`, `delete` — use it in custom routes and they're protected for free.
- **Multi-role union semantics.** Users may hold any number of roles; grants combine as the union and per-role record rules OR together. Matches Odoo's behavior exactly.
- **Composable primitives.** `createApp` is a convenience layer over `buildSchema`, `buildRbac`, `buildRbacDb`, `buildAuthRoutes`, and `buildAdminRoutes` — use them directly when you need a custom pipeline.
- **Hermetic, no-mocks test suite.** Every subsystem is exercised end-to-end through the generated GraphQL schema against in-memory SQLite.
- **Pino logger re-exported.** A pre-configured [pino](https://getpino.io/) root is exported as `logger`; framework code uses it via `logger.child({ component: "..." })`. Pretty + colorized via `pino-pretty` on a TTY, JSON otherwise. `LOG_LEVEL` env var controls the active level.

## At a glance

| Area              | What you get                                                                                |
|-------------------|---------------------------------------------------------------------------------------------|
| Transport         | Hono app exposing GraphQL (via `graphql-yoga`) and REST sub-apps; runs on any Web Fetch host. |
| Database          | Drizzle ORM. SQLite is the reference dialect; the engine only relies on `select()`.         |
| Auth              | Email + password, bcrypt-hashed, with cookie and `Authorization: Bearer` sessions.          |
| Authorization     | Code-defined roles, CRUD grants, and row-level rules; built synchronously, held in process memory. |
| Persistence model | Two framework-owned tables: `users` and `sessions`. RBAC is in-memory.                      |
| Runtime mutation  | Role memberships live in the engine; the role catalog and grants are code-only.             |

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

export { users, sessions } from "drizzle-graphql-rbac";
export type { User, NewUser, Session } from "drizzle-graphql-rbac";

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

The framework owns two tables: `users` and `sessions`. RBAC is fully in-memory.

### 3. Define your RBAC config

Three files. The framework provides one role for free: `admin` (full bypass via `isAdmin: true`). `createApp` merges it into your config automatically — **do not redeclare `admin`**.

```ts
// src/roles.ts
import { defineRoles } from "drizzle-graphql-rbac";
export const roles = defineRoles({
  // 'admin' is provided by the framework — don't add it here.
  user: {},
  demo: {},
});
```

```ts
// src/accessRights.ts
import { defineAccessRights } from "drizzle-graphql-rbac";
export const accessRights = defineAccessRights({
  demo: {
    todos: { create: true, read: true, update: true, delete: true },
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
      read:   { domain: own },
      update: { domain: own },
      delete: { domain: own },
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

const { app, rbac } = createApp({
  db: schema.db,
  schema,
  rbac: { roles, accessRights, recordRules },
});

// Seed memberships in memory — re-run on every restart since RBAC is not persisted.
rbac.assignRole(/* adminUserId */ 1, "admin");

serve({ fetch: app.fetch, port: 3000 });
```

That's the whole server. GraphiQL is at `/graphql`, REST auth at `/auth/*`, admin at `/admin/*`. The RBAC engine is constructed synchronously inside `createApp` — there is nothing to await.

---

## Defining roles

`defineRoles` takes an object whose **keys** are short role names used in code, and whose **values** carry the metadata (currently just an optional `isAdmin` flag). The framework already supplies an `admin` role — your file only declares the roles your app needs.

```ts
// src/roles.ts
import { defineRoles } from "drizzle-graphql-rbac";

export const roles = defineRoles({
  /** Logged-in user with no special powers — the default for new sign-ups. */
  user: {},

  /** Sees and edits todos in their team. */
  manager: {},

  /** Read-only auditor — useful for compliance reviews. */
  auditor: {},
});

export type RoleKey = keyof typeof roles;
```

| Field     | Effect                                                                                      |
|-----------|---------------------------------------------------------------------------------------------|
| `isAdmin` | Optional. Members bypass every RBAC check. The framework already provides one — you should rarely need a second. |

There is **no inheritance** — each role's grants stand alone. If `manager` should also have what `user` has, restate those grants under `manager`, or assign both roles to the user.

> Users hold roles via the engine's in-memory membership map. The admin REST endpoints manage assignments at runtime; the role catalog itself is code-only.

### Framework-owned `admin` role

`createApp` automatically merges in `admin` (`isAdmin: true`). App authors should not declare a role with key `"admin"` — `mergeFrameworkRbac` throws on collision.

If you're calling `buildRbac` directly (lower-level than `createApp`) and want the framework admin, opt in:

```ts
import { mergeFrameworkRbac, buildRbac } from "drizzle-graphql-rbac";

const rbac = buildRbac(mergeFrameworkRbac({ roles, accessRights, recordRules }));
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
      read: true,
      create: true,
      update: true,
      // delete: false — default; user can't delete todos.
    },
  },

  manager: {
    todos: { read: true, create: true, update: true, delete: true },
    users: { read: true }, // managers can browse the user directory
  },

  auditor: {
    todos: { read: true },
    users: { read: true },
  },
});
```

### The shape

```ts
defineAccessRights({
  [roleKey]: {
    [resourceJsKey]: {
      create?: boolean,   // missing = false
      read?:   boolean,
      update?: boolean,
      delete?: boolean,
    },
  },
});
```

- **`roleKey`** must match a key from `defineRoles({...})` (or the framework's `admin`). `buildRbacConfig` throws on unknown role refs.
- **`resourceJsKey`** is the **JS export name** of the Drizzle table (e.g. `todos`, `users`) — not the SQL table name. The auto-generated GraphQL CRUD uses the same key, so the names line up by construction.

### Deny by default

If no role the user holds grants `(resource, action)`, the engine throws `FORBIDDEN`. There is no implicit "everyone can read" — if you want one, define a `user` role, give it the grants, and assign `user` to everyone (or have your registration flow do it).

### How grants combine

A user with **multiple roles** gets the **union** of their grants. A user in both `auditor` (read-only) and `manager` (full CRUD) has full CRUD on `todos`.

### Resources the framework owns

The auto-generated GraphQL CRUD applies to every table in your schema namespace, including the framework tables (`users`, `sessions`). If you don't want clients reading `sessions` over GraphQL, simply don't grant `sessions.read` to any role (the default) — admin tooling can use the unwrapped `rdb.raw` handle.

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
      update: { domain: own },
      delete: { domain: own },
    },
  },

  manager: {
    todos: {
      read:   { domain: [["teamId", "=", "current_user.teamId"]] },
      update: { domain: [["teamId", "=", "current_user.teamId"]] },
    },
  },

  auditor: {
    todos: {
      // Auditors see only published, non-archived todos.
      read: {
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
      read?:   { domain: Domain },
      update?: { domain: Domain },
      delete?: { domain: Domain },
      create?: { domain: Domain }, // ACL-only on insert; create domains are
                                   // accepted but not enforced by the
                                   // auto-CRUD layer.
    },
  },
});
```

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

Anonymous callers get `null`, which makes equality against the placeholder match no rows — the safe default. To add more placeholders (e.g. `current_user.teamId` from a custom user shape), wrap `enforce` yourself.

### How rules combine across roles

If a user holds **multiple roles** that all grant the same action, their per-role rules **OR** together — holding *any* qualifying role is enough. A user with both `manager` (sees their team's todos) and `auditor` (sees published todos) sees the union: their team's todos *or* any published todo.

A granting role with **no rule** on `(resource, action)` is unrestricted on that grant — and unrestricted ORed with anything is still unrestricted. Mixing a role with no rule and a role with a rule yields no row filter at all (matches Odoo).

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

---

## Managing role membership

Memberships live in the engine. The REST API for the admin dashboard:

| Method | Path                          | Body            | Returns                          |
|--------|-------------------------------|-----------------|----------------------------------|
| GET    | `/admin/roles`                | —               | `{ roles: string[] }`            |
| GET    | `/admin/users/:id/roles`      | —               | `{ userId, roles: string[] }`    |
| POST   | `/admin/users/:id/roles`      | `{ roleKey }`   | `{ userId, roles }` (201)        |
| DELETE | `/admin/users/:id/roles/:key` | —               | `{ userId, roles }` (200)        |

- All endpoints require an authenticated session.
- `GET` requires the caller to have `users.read`; `POST` / `DELETE` require `users.update`.
- Posting a `roleKey` that isn't defined in the code config returns 400.

Programmatically, use the engine handle returned by `createApp`:

```ts
const { rbac } = createApp({ ... });
rbac.assignRole(userId, "manager");
rbac.revokeRole(userId, "auditor");
rbac.listUserRoles(userId);  // ["manager"]
rbac.listRoleKeys();         // every role known to the engine, sorted
rbac.hasRole("ghost");       // false
```

> Because memberships are in-memory, they reset to empty on every restart. Seed your bootstrap admin (and any well-known accounts) explicitly after `createApp` returns — e.g. look up users by email and call `rbac.assignRole(id, "admin")`.

There is no endpoint for creating or deleting roles. To change what a role can do, edit `roles.ts` / `accessRights.ts` / `recordRules.ts` and redeploy.

---

## What you get from `createApp`

```ts
const { app, rbac, rdbFor } = createApp({
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
});
```

- `app` — a Hono app. Pass `app.fetch` to `@hono/node-server`'s `serve`, or to any Web Fetch host.
- `rbac` — the engine handle. Use it to seed memberships at startup and read/mutate them at runtime: `assignRole`, `revokeRole`, `listUserRoles`, `listRoleKeys`, `hasRole`, `enforce`.
- `rdbFor(ctx)` — per-request RBAC-bound Drizzle wrapper. Use it in custom routes so they're enforced just like the auto-CRUD.

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
  buildRbac,              // RBAC engine (in-memory)
  buildRbacDb,            // per-request Drizzle wrapper
  buildAuthRoutes,        // /auth/* sub-app
  buildAdminRoutes,       // /admin/* sub-app
  sessionMiddleware,
  mergeFrameworkRbac,
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "drizzle-graphql-rbac";

const rbac = buildRbac(mergeFrameworkRbac({ roles, accessRights, recordRules }));

const { schema: gqlSchema } = buildSchema(db, schema, {
  rbac: { enforce: rbac.enforce },
  hiddenOutputColumns: { users: ["passwordHash"] },
});

const rdbFor = buildRbacDb({ db, schema, enforce: rbac.enforce });
```

`buildRbac` returns `{ enforce, listRoleKeys, listUserRoles, assignRole, revokeRole, hasRole }`. You can write a custom `enforce` if you want extra placeholders, multi-tenancy filters, or audit logging — it just needs to return `Promise<{ where?: SQL }>` (and throw `GraphQLError` with `extensions.code = "FORBIDDEN"` to deny). See `src/graphql/rbac/rbac.ts` for the reference implementation.

---

## Logging

The framework uses [pino](https://getpino.io/) and exports a pre-configured root logger. Use it directly or construct your own — there's no custom wrapper.

```ts
import { logger } from "drizzle-graphql-rbac";

const log = logger.child({ component: "billing" });
log.info({ invoiceId: 42, customerId: 7 }, "invoice issued");
log.warn({ attempt: 3 }, "retrying");
```

### Configuration

Set the active level with either a CLI flag or an env var. Precedence: `--log-level` > `LOG_LEVEL` > default `info`. Pino's six levels apply (plus `silent`): `trace`, `debug`, `info`, `warn`, `error`, `fatal`.

```bash
# CLI flag (both forms supported)
node app.js --log-level=debug
node app.js --log-level debug

# Env var
LOG_LEVEL=debug node app.js
```

Unknown values fall back silently to `info`.

When stdout is a TTY (and `NO_COLOR` is unset), output is rendered via `pino-pretty` with colorized levels and an ISO timestamp; otherwise pino emits newline-delimited JSON.

### Framework-emitted components

`createApp` writes through the same root logger:

| Component            | When                                                           |
|----------------------|----------------------------------------------------------------|
| `framework.app`      | `debug` line when the app is composed.                         |
| `framework.app.http` | Hono request log — 4xx → `warn`, 5xx → `error`, else `info`.   |

Pass `logger: false` to `createApp` to silence the HTTP middleware, or `logger: (msg, ...rest) => {...}` to fully override the sink.

### Bridging Drizzle's query logger

Drizzle's `logger: true` option writes raw SQL via `console.log`. To keep everything flowing through pino, pass a small adapter instead:

```ts
import { drizzle } from "drizzle-orm/better-sqlite3";
import { logger } from "drizzle-graphql-rbac";

const dbLog = logger.child({ component: "app.db" });

export const db = drizzle(sqlite, {
  schema,
  logger: {
    logQuery: (query, params) => dbLog.debug({ query, params }, "drizzle query"),
  },
});
```

SQL then respects `LOG_LEVEL` and emits as structured JSON (or pretty in a TTY) alongside the rest of your logs.

### Want a different setup?

Construct your own pino root (custom transport, redact, etc.) and pass child loggers around in your app. The framework's own logging will keep using its own root, but you're not forced into ours.

---

## DB bootstrap

The framework owns just two tables — `users` and `sessions`. A small `CREATE TABLE IF NOT EXISTS` script is sufficient; see the reference app's `src/scripts/init-db.ts`. Once you publish a built dist of this package, the standard `drizzle-kit` `db:generate` / `db:migrate` flow works as well.

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT    NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT    NOT NULL
);
```

---

## Layout of this package

| Path                                   | What's there                                                             |
|----------------------------------------|--------------------------------------------------------------------------|
| `src/index.ts`                         | Public surface — re-exports everything below.                            |
| `src/app.ts`                           | `createApp` composition root.                                            |
| `src/tables.ts`                        | Drizzle definitions for `users` and `sessions`.                          |
| `src/auth/`                            | `/auth/*` REST sub-app, session primitives, Hono middleware.             |
| `src/admin/`                           | `/admin/*` REST sub-app (user CRUD + role membership).                   |
| `src/graphql/builder/`                 | Schema generator: types, root fields, where/orderBy translation.         |
| `src/graphql/relations.ts`             | Relation introspection (explicit + auto-promoted single-column FK).      |
| `src/graphql/rbac/config.ts`           | `defineRoles` / `defineAccessRights` / `defineRecordRules` + validation. |
| `src/graphql/rbac/rbac.ts`             | In-memory engine: snapshot, membership API, `enforce`.                   |
| `src/graphql/rbac/rbacDb.ts`           | Per-request Drizzle proxy that auto-runs `enforce`.                      |
| `src/graphql/domain/`                  | Odoo-style domain parser + SQL translator.                               |
| `src/logger.ts`                        | Pino root logger (pretty on TTY, JSON otherwise) re-exported from the package.  |

Each subdirectory has its own README that goes deeper.

---

## Testing

```bash
npm test --workspace drizzle-graphql-rbac
```

Tests use Node's built-in test runner via `tsx`, with hermetic in-memory SQLite databases per file. They exercise the engine and the wrapper end-to-end through the generated GraphQL schema, so the schema-as-output is the contract under test — when changing builder/filter/relation/RBAC logic, prefer adjusting or adding queries in the existing `*.test.ts` files over mocking internals.
