# drizzle-graphql-rbac

> A batteries-included backend framework that turns a [Drizzle](https://orm.drizzle.team/) schema into a production-ready GraphQL + REST API — complete with authentication, sessions, and Odoo-style role-based access control.

A single `createApp(...)` call stands up an HTTP service with a fully-typed GraphQL CRUD layer, cookie/bearer authentication, an admin sub-app, and a row-level security engine governed by three small TypeScript files. RBAC is fully **in-memory** in this build: the engine is constructed synchronously on startup from your code config and there is no RBAC schema to migrate.

## Highlights

- **Zero-boilerplate GraphQL CRUD.** Every table in your Drizzle namespace gets typed `Query` and `Mutation` fields — `list`, `single`, `insert`, `update`, `delete` — with filter, ordering, and pagination inputs derived from the column types.
- **Automatic relations.** Single-column foreign keys are promoted into forward (`one`) and inverse (`many`) GraphQL fields automatically; explicit Drizzle `relations(...)` declarations take precedence when you need them.
- **Built-in authentication.** REST `/auth/*` routes (`register`, `login`, `logout`, `me`) with bcrypt-hashed passwords, dual cookie + bearer-token sessions, sliding expiry, and constant-time login (dummy-hash compare for unknown emails).
- **Admin sub-app.** REST `/admin/*` endpoints for user CRUD and runtime role-membership changes, gated by the same RBAC engine that protects GraphQL.
- **Hardened GraphQL surface.** Depth-limited operations, optional introspection lockdown, optional HTTP-level auth gate, and a server-side list cap (`maxListLimit`) defend the auto-generated CRUD against runaway queries and unauthenticated probing.
- **Origin-based CSRF.** Same-origin gate is enabled by default via Hono's `csrf` middleware (with an `origin` allowlist option); disable it explicitly only when fronted by a CSRF-aware gateway.
- **Code-defined, in-memory RBAC.** Roles, access rights, and record rules are declared in TypeScript and compiled into the engine snapshot at startup — no migrations, no sync routines, no DB drift. User → role assignments live in process memory and can be mutated at runtime via the REST API or the engine handle.
- **Row-level security with a domain DSL.** Per-role, per-action record rules written in an Odoo-style domain language (`["&", [...], ["|", [...], [...]]]`) are compiled to SQL and AND-injected into every read, update, and delete.
- **Per-request enforcement wrapper.** `rdbFor(ctx)` returns a Drizzle handle that automatically applies the caller's RBAC envelope to `select`, `insert`, `update`, `delete` — use it in custom routes and they're protected for free.
- **Multi-role union semantics.** Users may hold any number of roles; grants combine as the union and per-role record rules OR together. Matches Odoo's behavior exactly.
- **Composable primitives.** `createApp` is a convenience layer over `buildSchema`, `buildRbac`, `buildRbacDb`, `buildAuthRoutes`, and `buildAdminRoutes` — use them directly when you need a custom pipeline.
- **Hermetic, no-mocks test suite.** Every subsystem is exercised end-to-end through the generated GraphQL schema against in-memory SQLite. Reusable fixtures are published under the `drizzle-graphql-rbac/testing` subpath.
- **Pino logger re-exported.** A pre-configured [pino](https://getpino.io/) root is exported as `logger`; framework code uses it via `logger.child({ component: "..." })`. Pretty + colorized via `pino-pretty` on a TTY, JSON otherwise. `LOG_LEVEL` env var controls the active level.

## At a glance


| Area              | What you get                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| Transport         | Hono app exposing GraphQL (via `graphql-yoga`) and REST sub-apps; runs on any Web Fetch host.      |
| Database          | Drizzle ORM. SQLite is the reference dialect; the engine only relies on `select()`.                |
| Auth              | Email + password, bcrypt-hashed, with cookie and `Authorization: Bearer` sessions.                 |
| Authorization     | Code-defined roles, CRUD grants, and row-level rules; built synchronously, held in process memory. |
| Persistence model | Two framework-owned tables: `users` and `sessions`. RBAC is in-memory.                             |
| Runtime mutation  | Role memberships live in the engine; the role catalog and grants are code-only.                    |


A working reference application is available in this monorepo's root (`../../`).

---

## Table of contents

- [Quick start](#quick-start)
  - [1. Install](#1-install)
  - [2. Define your DB](#2-define-your-db)
  - [3. Define your RBAC config](#3-define-your-rbac-config)
  - [4. Wire the app](#4-wire-the-app)
- [Running the server](#running-the-server)
  - [The three-stage precedence chain](#the-three-stage-precedence-chain)
  - [Framework default config](#framework-default-config)
  - [User config file (optional)](#user-config-file-optional)
  - [Secrets and `.env`](#secrets-and-env)
  - [CLI flags](#cli-flags)
  - [Booting](#booting)
  - [Logging](#logging)
  - [HTTP & GraphQL security gates](#http--graphql-security-gates)
- [Database](#database)
  - [Framework-owned tables](#framework-owned-tables)
  - [Schema management](#schema-management)
  - [Hand-bootstrap SQL](#hand-bootstrap-sql)
- [RBAC](#rbac)
  - [Defining roles](#defining-roles)
  - [The framework-owned `admin` role](#the-framework-owned-admin-role)
  - [Defining access rights](#defining-access-rights)
  - [Defining record rules](#defining-record-rules)
  - [Domain syntax](#domain-syntax)
  - [How rules combine across roles](#how-rules-combine-across-roles)
  - [Managing role membership](#managing-role-membership)
  - [Worked example](#worked-example)
- [REST API reference](#rest-api-reference)
  - [`/auth/*` — authentication](#auth--authentication)
  - [`/admin/*` — administration](#admin--administration)
- [The `createApp` API](#the-createapp-api)
  - [Options](#options)
  - [Returns](#returns)
  - [Per-request RBAC db](#per-request-rbac-db)
  - [Escape hatches](#escape-hatches)
- [Lower-level primitives](#lower-level-primitives)
- [Testing](#testing)
  - [Running tests](#running-tests)
  - [Reusable fixtures (`drizzle-graphql-rbac/testing`)](#reusable-fixtures-drizzle-graphql-rbactesting)
- [Package layout](#package-layout)

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

Write a tiny config file that points at your `db`/`schema`/`rbac`:

```ts
// server.config.ts
import { defineServerConfig } from "drizzle-graphql-rbac";
import { db } from "./src/db.js";
import * as schema from "./src/db.js";
import { roles } from "./src/roles.js";
import { accessRights } from "./src/accessRights.js";
import { recordRules } from "./src/recordRules.js";

export default defineServerConfig({
  db,
  schema,
  rbac: { roles, accessRights, recordRules },
  // Every other knob (port, GraphQL gates, CSRF, hidden columns…) has
  // a framework default — override here only what you need to change.
});
```

A `.env` file for secrets only (admin bootstrap, DB passwords, signing material):

```bash
# .env  (gitignored)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me-in-prod
```

And a one-line boot script:

```ts
// server.ts
import { runServer } from "drizzle-graphql-rbac";
await runServer();
```

Run it:

```bash
# Normal boot — does not touch the users table.
node --env-file=.env --import tsx server.ts --config ./server.config.ts

# First-time boot — also upsert the admin user from .env and assign the
# built-in `admin` role. Idempotent; safe to repeat. Failures here are
# logged but do not stop the server.
node --env-file=.env --import tsx server.ts --config ./server.config.ts --create-admin
```

That's the whole server. GraphiQL is at `/graphql`, REST auth at `/auth/*`, admin at `/admin/*`. The framework ships a built-in `admin` role (`isAdmin: true`, full bypass) — see [The framework-owned `admin` role](#the-framework-owned-admin-role) for how it interacts with `--create-admin`.

---

## Running the server

The framework cleanly separates four layers:

```
your-app/
├── .env                ← SECRETS only (gitignored): ADMIN_EMAIL, ADMIN_PASSWORD, …
├── server.config.ts    ← OPTIONAL knob overrides + your db/schema/rbac (no secrets)
├── server.ts           ← one line: `await runServer()`
└── package.json
```

### The three-stage precedence chain

`runServer()` resolves every setting through a strict, predictable chain:

```
CLI args
  ▲
  │  override
  │
user config file (knobs)   .env / shell env (secrets)
  ▲                          ▲
  │  override                │  override
  │                          │
framework default config     (no defaults — value stays undefined)
```

- **Knobs** (port, host, GraphQL gates, CSRF, hidden columns, …) cascade through all three levels. The framework default config is always the floor.
- **Secrets** (admin email/password) come from `.env` or the shell, and can be overridden by CLI flags. They are NEVER read from the config file — keep them out of source control.
- **Required-from-user** (`db`, `schema`, `rbac`) have no defaults and must be exported by the user config file. Everything else has a default.

### Framework default config

A baked-in, fully-typed object exported as `frameworkDefaultConfig` (also dynamically imported by `runServer`). Its job is to make the user's config file optional for routine setups:


| Knob                          | Default                                                |
| ----------------------------- | ------------------------------------------------------ |
| `port`                        | `3000`                                                 |
| `host`                        | `"0.0.0.0"`                                            |
| `publicDir`                   | `"./public"` (set to `null` to disable static serving) |
| `graphqlEndpoint`             | `"/graphql"`                                           |
| `graphqlMaxDepth`             | `10`                                                   |
| `maxListLimit`                | `200`                                                  |
| `csrf`                        | `{}` (same-origin)                                     |
| `hiddenOutputColumns`         | `{ users: ["passwordHash"], sessions: ["token"] }`     |
| `hiddenInputColumns`          | `{ users: ["passwordHash"], sessions: ["token", "userId"] }` |
| `logger`                      | `true`                                                 |
| `createAdmin`                 | `false` — opt in with `--create-admin` once both admin secrets are set |


```ts
import { frameworkDefaultConfig } from "drizzle-graphql-rbac";
// inspect the baseline in tests or tooling
```

### User config file (optional)

If you only need to plug in your `db`/`schema`/`rbac` and accept every default, the config file is tiny:

```ts
// server.config.ts
import { defineServerConfig } from "drizzle-graphql-rbac";
import { db } from "./src/db.js";
import * as schema from "./src/db.js";
import { roles } from "./src/roles.js";
import { accessRights } from "./src/accessRights.js";
import { recordRules } from "./src/recordRules.js";

export default defineServerConfig({
  db,
  schema,
  rbac: { roles, accessRights, recordRules },
});
```

Override any knob by simply setting it — your value wins over the framework default:

```ts
export default defineServerConfig({
  db, schema, rbac: { roles, accessRights, recordRules },

  // Overrides only — everything else inherits frameworkDefaultConfig.
  port: 8080,
  csrf: { origin: ["https://app.example.com"] },
  createAdmin: true, // upsert the admin user on every boot (idempotent)
});
```

The full option set is `ServerConfig`, which extends [`CreateAppOptions`](#the-createapp-api) with `port`, `host`, and `createAdmin`. **Do not put secrets in this file** — reference them via `process.env.*` only if you really must, but prefer letting the framework's `Secrets` layer resolve them for you.

The file can also default-export a JS object (`server.config.js`) if you don't want TS at boot time.

#### How the config path is resolved

`runServer` looks for the file in this order:

1. **`--config <path>`** (or `--config=<path>`) on the command line.
2. **`CONFIG_PATH`** environment variable.
3. The `configPath` argument to `runServer({ configPath })` / `loadServerConfig(path)`.

If none is set, `runServer` throws with a message naming the three sources.

### Secrets and `.env`

Secrets live in `.env`. Node ≥ 20.6 loads it natively via `--env-file=.env` — no `dotenv` dependency. **No configuration knobs in `.env`** — keep this file strictly for credentials and signing material.

```bash
# .env  (gitignored — secrets only)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me-in-prod
DATABASE_URL=file:./todo.db        # your app's own secrets are fine here too
```

Framework-recognized secrets:


| Secret           | Sources (in precedence order)                        | Used for                                                                   |
| ---------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `adminEmail`     | `--admin-email <s>` → `ADMIN_EMAIL`                  | Admin user creation (see below).                                           |
| `adminPassword`  | `--admin-password <s>` → `ADMIN_PASSWORD`            | Admin user creation.                                                       |


Admin creation is **opt-in** and only runs when `--create-admin` (or `createAdmin: true` in the config) is set AND both secrets resolve. When triggered, `runServer` upserts that user (bcrypt-hashed) and assigns them the framework's built-in `admin` role before serving the first request. The `admin` role itself is defined inside the framework (`isAdmin: true`, full bypass) — your app should never redefine it.

The bootstrap is **non-fatal**: if the upsert fails (DB locked, missing `users` table, etc.) the error is logged and the server still starts. If `--create-admin` is set but `ADMIN_EMAIL` / `ADMIN_PASSWORD` are missing or only one is provided, a warning is logged and the step is skipped — the server still starts.

Typical operational pattern: deploy with `--create-admin` once (or run a one-shot boot with it), then drop the flag on subsequent restarts.

Your app's own secrets (DB credentials, third-party API keys, …) are read by your config / `db.ts` modules via `process.env.*` — the framework only formally consumes the two above.

#### Operational env vars

Two env vars also influence runtime behavior and are NOT considered secrets:


| Variable    | Effect                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL` | Pino level — `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. Default `info`. Unknown values fall back silently to `info`.      |
| `NO_COLOR`  | Any non-empty value (or non-TTY stdout) disables `pino-pretty` colorization and emits newline-delimited JSON instead.                        |


Convention: set these in `.env` if you want them version-controlled per environment, or in your process supervisor / orchestrator otherwise. The framework treats both sources identically.

### CLI flags

Any knob or secret can be supplied on the command line — and the command line always wins.


| Flag                                                    | Maps to                          | Type      |
| ------------------------------------------------------- | -------------------------------- | --------- |
| `--config <path>` / `--config=<path>`                   | config file path                 | string    |
| `--port <n>`                                            | `port`                           | number    |
| `--host <s>`                                            | `host`                           | string    |
| `--public-dir <s>`                                      | `publicDir`                      | string    |
| `--graphql-endpoint <s>`                                | `graphqlEndpoint`                | string    |
| `--graphql-max-depth <n>`                               | `graphqlMaxDepth`                | number    |
| `--max-list-limit <n>`                                  | `maxListLimit`                   | number    |
| `--create-admin` / `--no-create-admin`                  | `createAdmin`                    | boolean   |
| `--admin-email <s>`                                     | secret `adminEmail`              | string    |
| `--admin-password <s>`                                  | secret `adminPassword`           | string    |
| `--log-level <s>`                                       | pino level (overrides `LOG_LEVEL`) | string  |


Boolean flags accept three forms: `--flag` (true), `--flag=false` (or `=0`), and `--no-flag` (false). Number flags reject non-numeric values with a clear error. Unknown flags are silently ignored so your own CLI can layer on top.

```bash
# Override port just for this run
node --env-file=.env --import tsx server.ts --config ./server.config.ts \
  --port 8080

# Create the admin user from .env on this boot (non-fatal on error)
node --env-file=.env --import tsx server.ts --config ./server.config.ts --create-admin

# Inject ad-hoc admin creds without writing to .env
node --env-file=.env --import tsx server.ts --config ./server.config.ts \
  --create-admin --admin-email ops@example.com --admin-password 'temp-rotate-me'
```

### Booting

The boot script:

```ts
// server.ts
import { runServer } from "drizzle-graphql-rbac";

const { rbac, config, secrets } = await runServer();

// Optional: do extra setup after the server is up. Anything you'd previously
// have done between createApp() and serve() goes here.
// rbac.assignRole(someUserId, "manager");
```

`runServer()` parses CLI flags, loads the config file, merges with `frameworkDefaultConfig`, resolves secrets, builds the app via `createApp`, optionally upserts the admin user (only when `--create-admin` / `createAdmin: true` is set — failures are logged but do not abort startup), and starts a Node listener via `@hono/node-server`. It returns:

- the standard `createApp` handle (`app`, `rbac`, `rdbFor`, `sudoDb`)
- the resolved `port` and `host`
- the fully-merged `config` (defaults ← user config ← CLI)
- the resolved `secrets` (env ← CLI)

#### Recommended `package.json` scripts

```json
{
  "scripts": {
    "dev":   "tsx watch --env-file=.env server.ts --config ./server.config.ts",
    "start": "tsx --env-file=.env server.ts --config ./server.config.ts",
    "build": "tsc -p .",
    "serve": "node --env-file=.env dist/server.js --config ./dist/server.config.js"
  }
}
```

- `--env-file=.env` is a Node flag (≥ 20.6) — Node loads the file before your script runs.
- Missing `.env` files are tolerated by Node when you pass `--env-file-if-exists=.env` instead; use it if your prod environment injects vars via the orchestrator.

#### Non-Node hosts

For Cloudflare Workers, Bun, Deno, or other Web Fetch hosts, skip `runServer` entirely — compose the pieces yourself:

```ts
import { parseCliArgs, loadServerConfig, frameworkDefaultConfig, createApp }
  from "drizzle-graphql-rbac";

const cli = parseCliArgs();
const user = await loadServerConfig();
if (!user?.db || !user?.schema || !user?.rbac) throw new Error("config required");
const cfg = { ...frameworkDefaultConfig, ...user, ...cli.knobs };
const { app } = createApp(cfg);
export default { fetch: app.fetch };
```

### Logging

The framework uses [pino](https://getpino.io/) and exports a pre-configured root logger. Use it directly or construct your own — there's no custom wrapper.

```ts
import { logger } from "drizzle-graphql-rbac";

const log = logger.child({ component: "billing" });
log.info({ invoiceId: 42, customerId: 7 }, "invoice issued");
log.warn({ attempt: 3 }, "retrying");
```

#### Framework-emitted components


| Component            | When                                                         |
| -------------------- | ------------------------------------------------------------ |
| `framework.app`      | `debug` line when the app is composed.                       |
| `framework.app.http` | Hono request log — 4xx → `warn`, 5xx → `error`, else `info`. |


Pass `logger: false` to `createApp` to silence the HTTP middleware, or `logger: (msg, ...rest) => {...}` to fully override the sink.

#### Bridging Drizzle's query logger

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

#### Want a different setup?

Construct your own pino root (custom transport, redact rules, OTLP exporter, etc.) and pass child loggers around in your app. The framework's own logging will keep using its own root, but you're not forced into ours.

### HTTP & GraphQL security gates

The `/graphql` endpoint always requires an authenticated session — anonymous requests get `401 { "error": "Authentication required" }` before parse. Schema introspection (`__schema` / `__type` selections and GraphiQL's autocomplete) is always restricted to admin sessions at validation time. Beyond those two non-negotiable gates, the following layers harden the auto-generated surface and are tunable via `createApp` options:


| Option                      | Default                                | What it does                                                                                                                |
| --------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `graphqlMaxDepth`           | `10`                                   | Rejects operations whose selection depth exceeds the cap at validation time.                                                |
| `maxListLimit`              | `200`                                  | Silently clamps any list/relation `limit` to this cap. Bounds resolver fan-out and data dumps.                              |
| `csrf`                      | `{}` (same-origin)                     | Origin-based CSRF gate on every route. Pass `{ origin }` to allowlist, `false` to disable.                                  |
| `hiddenOutputColumns`       | `users.passwordHash`, `sessions.token` | Strips columns from generated output types entirely.                                                                        |
| `hiddenInputColumns`        | `users.passwordHash`, `sessions.{token,userId}` | Strips columns from `Insert` / `Update` input types (mass-assignment defense). A caller-supplied value **replaces** the default — no merge. |

---

## Database

### Framework-owned tables

The framework owns just two tables — `users` and `sessions` — exported as `frameworkTables` from `drizzle-graphql-rbac/tables` (a schema-only subpath so `drizzle-kit`'s CJS loader doesn't pull in the runtime). Re-export them from your own schema module.

### Schema management

Let `drizzle-kit` manage the SQL. The typical workflow:

```bash
npx drizzle-kit push    # bootstrap a fresh DB from src/db.ts
npx drizzle-kit generate # produce SQL migrations
npx drizzle-kit migrate  # apply them
npx drizzle-kit studio   # browse the DB
```

Point `drizzle.config.ts` at your `src/db.ts` (or wherever you re-export `frameworkTables`).

### Hand-bootstrap SQL

If you must bootstrap by hand, the shape is:

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

## RBAC

### Defining roles

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


| Field     | Effect                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| `isAdmin` | Optional. Members bypass every RBAC check. The framework already provides one — you should rarely need a second. |


There is **no inheritance** — each role's grants stand alone. If `manager` should also have what `user` has, restate those grants under `manager`, or assign both roles to the user.

> Users hold roles via the engine's in-memory membership map. The admin REST endpoints manage assignments at runtime; the role catalog itself is code-only.

### The framework-owned `admin` role

The framework ships a single built-in role under the key `"admin"` with `isAdmin: true`. `createApp` automatically merges it in via `mergeFrameworkRbac` — app authors must NOT declare a role with key `"admin"` themselves; the merge throws on collision. The constant `ADMIN_ROLE` (`= "admin"`) is exported so tooling and seed scripts can reference the key without hard-coding the literal.

`isAdmin: true` is a **full bypass**: no access-rights check, no record-rule filter, no list cap, no hidden-column trimming. Use it strictly for human operators and service accounts that legitimately need god-mode. Grant ordinary feature access through normal `accessRights` entries on non-admin roles.

If you're calling `buildRbac` directly (lower-level than `createApp`) and want the framework admin, opt in:

```ts
import { mergeFrameworkRbac, buildRbac } from "drizzle-graphql-rbac";

const rbac = buildRbac(mergeFrameworkRbac({ roles, accessRights, recordRules }));
```

#### Creating the admin user

The `admin` *role* always exists. The admin *user* doesn't — `runServer` only creates one when you ask it to. The flow:

1. Put the credentials in `.env` (secrets only — never in the config file):

    ```bash
    ADMIN_EMAIL=admin@example.com
    ADMIN_PASSWORD=change-me-in-prod
    ```

2. Boot with `--create-admin` (or set `createAdmin: true` in your `server.config.ts`):

    ```bash
    node --env-file=.env --import tsx server.ts --config ./server.config.ts --create-admin
    ```

What `runServer` does when triggered:

- Bcrypt-hashes the password and **upserts** the row in `users` by email (creates if missing, updates `passwordHash` + `active: true` if present).
- Assigns the `admin` role to that user in the engine's in-memory membership map.
- Logs an `info` line with the resolved `userId`.

Safety properties:

- **Opt-in.** Without the flag (or the config knob), the framework never touches the users table on boot — even if `ADMIN_EMAIL` / `ADMIN_PASSWORD` are present in the environment.
- **Non-fatal.** If the upsert fails (locked DB, missing `users` table, schema mismatch, transient error, …), the failure is logged at `error` and the server still starts. The flag is safe to leave on in CI / restart-on-crash setups.
- **Half-set is a warning, not a failure.** If `--create-admin` is set but only one of email/password resolves (or both are missing), a `warn` is logged and the step is skipped — the server still starts.
- **CLI overrides env.** `--admin-email` / `--admin-password` flags take precedence over the `.env` values for the current boot, which is useful for ad-hoc credential rotation.

Typical operational patterns:

- **One-shot seed.** Deploy once with `--create-admin`, then drop the flag on subsequent restarts. Same effect as a manual seed script but with no script to maintain.
- **Always-on (idempotent).** Set `createAdmin: true` in the config file. Every boot re-asserts the row, so rotating the password is just a `.env` change + a restart.
- **REST-managed.** Leave the flag off and create the admin via `/auth/register` + an admin role assignment through `/admin/users/:id/roles`. Useful when admin credentials shouldn't live on the host filesystem.

`runServer` can also be programmatically suppressed via `runServer({ skipAdminBootstrap: true })` — useful in tests.

### Defining access rights

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

#### The shape

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

#### Deny by default

If no role the user holds grants `(resource, action)`, the engine throws `FORBIDDEN`. There is no implicit "everyone can read" — if you want one, define a `user` role, give it the grants, and assign `user` to everyone (or have your registration flow do it).

#### How grants combine

A user with **multiple roles** gets the **union** of their grants. A user in both `auditor` (read-only) and `manager` (full CRUD) has full CRUD on `todos`.

#### Resources the framework owns

The auto-generated GraphQL CRUD applies to every table in your schema namespace, including the framework tables (`users`, `sessions`). If you don't want clients reading `sessions` over GraphQL, simply don't grant `sessions.read` to any role (the default) — admin tooling can use the unwrapped `sudoDb` handle.

### Defining record rules

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

#### The shape

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

A role that **grants** an action with **no rule** on it gets unrestricted access. So the `user` example above lets `user` *read* every todo (no rule) but only *update / delete* their own (rule per action).

### Domain syntax

A **domain** is an array of leaves and combinators. Each leaf is `[field, operator, value]`. The `field` must be a column on the resource table.


| Operator             | Notes                                                    |
| -------------------- | -------------------------------------------------------- |
| `=`, `!=`            | `null` on either side becomes `IS NULL` / `IS NOT NULL`. |
| `<`, `<=`, `>`, `>=` | Numeric / lexicographic depending on column type.        |
| `in`, `not in`       | Value must be an array.                                  |
| `like`, `not like`   | Case-sensitive pattern match (SQL `LIKE`).               |
| `ilike`, `not ilike` | Case-insensitive pattern match.                          |


Combinators are written in **prefix notation** as control strings followed by their operands:


| Token | Arity      |
| ----- | ---------- |
| `&`   | binary AND |
| `|`   | binary OR  |
| `!`   | unary NOT  |


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

#### Placeholders

The engine injects `{ "current_user.id": ctx.user?.id ?? null }` before evaluating each rule. Reference it as a *string value* — the engine substitutes it at enforce time:

```ts
const own = [["assigneeId", "=", "current_user.id"]];
```

Anonymous callers get `null`, which makes equality against the placeholder match no rows — the safe default. To add more placeholders (e.g. `current_user.teamId` from a custom user shape), wrap `enforce` yourself.

### How rules combine across roles

If a user holds **multiple roles** that all grant the same action, their per-role rules **OR** together — holding *any* qualifying role is enough. A user with both `manager` (sees their team's todos) and `auditor` (sees published todos) sees the union: their team's todos *or* any published todo.

A granting role with **no rule** on `(resource, action)` is unrestricted on that grant — and unrestricted ORed with anything is still unrestricted. Mixing a role with no rule and a role with a rule yields no row filter at all (matches Odoo).

### Managing role membership

Memberships live in the engine. Programmatically:

```ts
const { rbac } = createApp({ ... });
rbac.assignRole(userId, "manager");
rbac.revokeRole(userId, "auditor");
rbac.listUserRoles(userId);  // ["manager"]
rbac.listRoleKeys();         // every role known to the engine, sorted
rbac.hasRole("ghost");       // false
rbac.isAdmin(userId);        // true if the user holds any role with isAdmin
```

> Because memberships are in-memory, they reset to empty on every restart. Seed your bootstrap admin (and any well-known accounts) explicitly after `createApp` returns — e.g. look up users by email and call `rbac.assignRole(id, "admin")`.

The same operations are exposed over REST under `/admin/users/:id/roles` — see [REST API reference](#rest-api-reference) below.

There is no endpoint for creating or deleting roles. To change what a role can do, edit `roles.ts` / `accessRights.ts` / `recordRules.ts` and redeploy.

### Worked example

Given the three example files above, a request from a user holding only `user`:


| Operation                                  | Outcome                                                 |
| ------------------------------------------ | ------------------------------------------------------- |
| `query { todos { id } }`                   | Lists every todo (read granted, no rule).               |
| `mutation updateTodos(...)` mine           | Succeeds — rule says `assigneeId = current_user.id`.    |
| `mutation updateTodos(...)` someone else's | `WHERE` narrows to my own; zero rows updated. No error. |
| `mutation deleteFromTodos(...)`            | Same as above — only my own get deleted.                |
| `mutation insertIntoTodos(...)`            | Granted (`create: true`).                               |
| `query { users { id } }`                   | `FORBIDDEN` — `user` has no grant on `users`.           |


---

## REST API reference

### `/auth/*` — authentication

All endpoints accept and return JSON. Successful login/register sets a session cookie (HttpOnly, SameSite=Lax, `Secure` in production). Bearer tokens (`Authorization: Bearer <token>`) are accepted as an alternative on every protected route.


| Method | Path             | Body                          | Returns                                          |
| ------ | ---------------- | ----------------------------- | ------------------------------------------------ |
| POST   | `/auth/register` | `{ name, email, password }`   | `{ user }` (201) + session cookie                |
| POST   | `/auth/login`    | `{ email, password }`         | `{ user }` (200) + session cookie                |
| POST   | `/auth/logout`   | —                             | `{ ok: true }` + clear-session cookie            |
| GET    | `/auth/me`       | —                             | `{ user }` (requires authenticated session)      |


Notes:
- Passwords are bcrypt-hashed (cost 12) on register and on admin password changes.
- `/auth/login` does a constant-time compare against a dummy hash on unknown / inactive emails so timing doesn't leak account existence.
- Duplicate email on register → `409 Email already registered`.

### `/admin/*` — administration

The admin sub-app is mounted behind `requireAuth` and a `requireAdmin` gate (caller must hold any role with `isAdmin: true`). Within that, each endpoint additionally checks the caller's grants on `users` as defense-in-depth.


| Method | Path                          | Body                                            | Returns                       |
| ------ | ----------------------------- | ----------------------------------------------- | ----------------------------- |
| GET    | `/admin/users`                | —                                               | `{ users: User[] }`           |
| POST   | `/admin/users`                | `{ name, email, password, active? }`            | `{ user }` (201)              |
| PATCH  | `/admin/users/:id`            | partial `{ name?, email?, password?, active? }` | `{ user }`                    |
| DELETE | `/admin/users/:id`            | —                                               | `{ ok: true }`                |
| GET    | `/admin/roles`                | —                                               | `{ roles: string[] }`         |
| GET    | `/admin/users/:id/roles`      | —                                               | `{ userId, roles: string[] }` |
| POST   | `/admin/users/:id/roles`      | `{ roleKey }`                                   | `{ userId, roles }` (201)     |
| DELETE | `/admin/users/:id/roles/:key` | —                                               | `{ userId, roles }` (200)     |


- `GET` endpoints require `users.read`; `POST` / `PATCH` / `DELETE` require the matching CRUD grant on `users`.
- Posting a `roleKey` that isn't defined in the code config returns `400`.
- Passwords on `POST /admin/users` and `PATCH /admin/users/:id` are bcrypt-hashed before write.

---

## The `createApp` API

### Options

```ts
const { app, rbac, rdbFor, sudoDb } = createApp({
  db,
  schema,
  rbac: { roles, accessRights, recordRules },

  // All optional — defaults shown:
  hiddenOutputColumns:        { users: ["passwordHash"], sessions: ["token"] },
  hiddenInputColumns:         { users: ["passwordHash"], sessions: ["token", "userId"] },
  typeNames:                  { /* override generated GraphQL type names */ },
  extraQueryFields:           { /* bespoke Query fields */ },
  extraMutationFields:        { /* bespoke Mutation fields */ },
  publicDir:                  "./public",  // null to disable static serving
  graphqlEndpoint:            "/graphql",
  logger:                     true,         // boolean | (msg, ...rest) => void
  graphqlMaxDepth:            10,           // reject deeper operations at validate time
  maxListLimit:               200,          // server-side cap on list/relation rows
  csrf:                       {},           // {} = same-origin; { origin } to allowlist; false to disable
});
```

See [HTTP & GraphQL security gates](#http--graphql-security-gates) for the security-relevant options.

### Returns

- **`app`** — a Hono app. Pass `app.fetch` to `@hono/node-server`'s `serve`, or to any Web Fetch host.
- **`rbac`** — the engine handle. Use it to seed memberships at startup and read/mutate them at runtime: `assignRole`, `revokeRole`, `listUserRoles`, `listRoleKeys`, `hasRole`, `isAdmin`, `enforce`.
- **`rdbFor(ctx)`** — per-request RBAC-bound Drizzle wrapper. Use it in custom routes so they're enforced just like the auto-CRUD.
- **`sudoDb`** — the raw, unwrapped Drizzle handle (same instance you passed in), re-exported under a name that flags its bypass semantics. Use only in pre-user bootstrap paths (startup seeding, seed scripts).

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

- **`sudoDb`** — the unwrapped Drizzle handle returned from `createApp`. Use it for the pre-auth bootstrap (resolving the session token), seed scripts, and anywhere that runs before there is a user.
- **`bypassResources: Set<string>`** — when constructing a custom `RbacDb`, list resources whose calls should pass through unchanged (e.g. `users` for the public `register` flow).

---

## Lower-level primitives

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

`buildRbac` returns `{ enforce, listRoleKeys, listUserRoles, assignRole, revokeRole, hasRole, isAdmin }`. You can write a custom `enforce` if you want extra placeholders, multi-tenancy filters, or audit logging — it just needs to return `Promise<{ where?: SQL }>` (and throw `GraphQLError` with `extensions.code = "FORBIDDEN"` to deny). See `src/graphql/rbac/rbac.ts` for the reference implementation.

---

## Testing

### Running tests

```bash
npm test --workspace drizzle-graphql-rbac
```

Tests use Node's built-in test runner via `tsx`, with hermetic in-memory SQLite databases per file. They exercise the engine and the wrapper end-to-end through the generated GraphQL schema, so the schema-as-output is the contract under test — when changing builder/filter/relation/RBAC logic, prefer adjusting or adding queries in the existing `*.test.ts` files over mocking internals.

### Reusable fixtures (`drizzle-graphql-rbac/testing`)

The framework's own fixtures are published under the `./testing` subpath for downstream apps:

```ts
import {
  transactionCase,         // wraps a test in a SAVEPOINT and rolls back on exit
  getSharedSqlite,         // process-wide in-memory better-sqlite3 handle
  applySchemaSql,          // applies Drizzle-emitted CREATE TABLEs to a DB
  clearAllRbacMemberships, // wipes in-memory role assignments between tests
  createAppTestHarness,    // boots a real createApp with in-memory DB + test users
} from "drizzle-graphql-rbac/testing";
```

`transactionCase(fn)` gives each test its own savepoint against a shared DB — inserts are visible inside the test and rolled back when it exits, so tests stay isolated without re-creating the schema each time. `createAppTestHarness(...)` boots the full app (auth, admin, GraphQL, RBAC) against an in-memory DB and returns a small request helper plus seeded user handles — useful for end-to-end tests in host apps.

---

## Package layout


| Path                                  | What's there                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | Public surface — re-exports everything below.                                                         |
| `src/app.ts`                          | `createApp` composition root.                                                                         |
| `src/tables.ts`                       | Drizzle definitions for `users` and `sessions` (also exported via `./tables`).                        |
| `src/frameworkRbac.ts`                | Framework-owned `admin` role + `mergeFrameworkRbac` helper.                                           |
| `src/auth/`                           | `/auth/*` REST sub-app, session primitives, Hono middleware, CSRF.                                    |
| `src/admin/`                          | `/admin/*` REST sub-app (user CRUD + role membership).                                                |
| `src/graphql/builder/`                | Schema generator: types, root fields, where/orderBy translation, relations introspection, depth limit. |
| `src/graphql/builder/relations.ts`    | Relation introspection (explicit + auto-promoted single-column FK).                                   |
| `src/graphql/rbac/config.ts`          | `defineRoles` / `defineAccessRights` / `defineRecordRules` + validation.                              |
| `src/graphql/rbac/rbac.ts`            | In-memory engine: snapshot, membership API, `enforce`, `isAdmin`.                                     |
| `src/graphql/rbac/rbacDb.ts`          | Per-request Drizzle proxy that auto-runs `enforce`.                                                   |
| `src/graphql/domain/`                 | Odoo-style domain parser + SQL translator.                                                            |
| `src/testing/`                        | Test fixtures (`transactionCase`, `createAppTestHarness`) re-exported via `./testing`.                |
| `src/logger.ts`                       | Pino root logger (pretty on TTY, JSON otherwise) re-exported from the package.                        |


Source layout is the source of truth — the public surface is everything re-exported from `src/index.ts`. The reference app at the repo root demonstrates a complete wiring (auto-seeded users + demo data, in-memory role binding, custom Hono routes that use `rdbFor`).
