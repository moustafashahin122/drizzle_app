# Drizzle Todo App (Hono + GraphQL + Drizzle + SQLite)

Single-process **Hono** server with a **GraphQL** endpoint generated from the Drizzle schema in `src/db.ts` (SQLite via `better-sqlite3`). Includes a simple static HTML/JS frontend in `public/` that talks to the GraphQL API.

This repo does **not** use the `drizzle-graphql` npm package. The GraphQL schema generator is implemented in `src/graphql/` and mounted at `/graphql`.

## Run

```bash
cd drizzle_todo_app
npm install
npm run db:push      # one-time on fresh checkout: apply schema to todo.db
npm run dev
```

- App: `http://localhost:3000`
- GraphiQL explorer: `http://localhost:3000/graphql`

### Environment variables

`npm run dev` and `npm start` load `.env` when present (`tsx --env-file-if-exists=.env`).

| Variable                        | When            | Purpose                                                |
| ------------------------------- | --------------- | ------------------------------------------------------ |
| `PORT`                          | Optional        | HTTP port (default `3000`)                             |
| `LOG_LEVEL`                     | Optional        | `trace`/`debug`/`info`/`warn`/`error`/`fatal`/`silent` |
| `DEV_PASSWORD`                  | Dev only        | Password for auto-seeded demo users (default `demo123`)|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Production only | Required at startup (see [User seeding](#user-seeding))|
| `ADMIN_NAME`                    | Production only | Display name for the bootstrapped admin (default `Admin`) |

## Auth, sessions, and RBAC

REST `/auth/*` (`register`, `login`, `logout`, `me`) sets an HttpOnly `sid` session cookie; non-browser clients can use `Authorization: Bearer <token>` instead. The GraphQL endpoint runs the same session middleware, so any authenticated request — cookie or bearer — is identified before resolvers run.

RBAC is fully **in-memory** and code-defined across three small files:

- `src/roles.ts` — role catalog (`demo`, `manager`; framework auto-injects `admin`).
- `src/accessRights.ts` — per-role CRUD grants per resource (JS table key).
- `src/recordRules.ts` — per-role row-level filters in an Odoo-style domain DSL. The `demo` role's todos rules use `[["assigneeId", "=", "current_user.id"]]` so each demo user only sees their own rows.

There is **no inheritance** — flatten shared grants. Multi-role users get the union of grants; per-role record rules OR together. Memberships live in process memory and reset on restart — the server re-binds them at startup from a hard-coded email map (`src/demoUsers.ts`).

## User seeding

The server seeds users automatically at startup (`src/scripts/bootstrapUsers.ts`):

- **Dev** (`NODE_ENV !== "production"`): upserts three users with password `demo123` (override via `DEV_PASSWORD`):
  - `demo_admin@example.com` — `admin` role (full bypass).
  - `demo_manager@example.com` — `manager` role (full todo CRUD, still RBAC-checked).
  - `demo_user@example.com` — `demo` role (record rule scopes todos to "assigned to me").

  On the **first boot of an empty DB**, it also seeds a `Demo project` and seven demo todos distributed across the three users (plus one unassigned). Seeding is one-shot: any pre-existing row in `todos` skips it, so developer edits aren't clobbered on restart. Delete `todo.db` and re-run `npm run db:push` to reset.

- **Production** (`NODE_ENV === "production"`): upserts a single admin row from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (optional `ADMIN_NAME`) and **throws** if either is missing. No demo users or demo data.

## Logging

Logging uses [pino](https://getpino.io/) via the shared `logger` exported from `drizzle-graphql-rbac`. Six levels — `trace`, `debug`, `info`, `warn`, `error`, `fatal` (plus `silent`).

Pick a level in either of two ways (CLI flag wins over env, env wins over the `info` default):

```bash
# CLI flag — remember the `--` so npm forwards the arg to the script
npm run dev   -- --log-level=debug
npm start     -- --log-level warn
npx tsx src/server.ts --log-level=trace

# Env var
LOG_LEVEL=debug npm run dev
LOG_LEVEL=warn  npm start
```

Unknown levels fall back to `info`.

Output is colorized via `pino-pretty` when stdout is a TTY, and newline-delimited JSON otherwise. Set `NO_COLOR=1` to force JSON in a TTY.

Components emitted by this app:

| Component        | When                                                              |
|------------------|-------------------------------------------------------------------|
| `app.server`           | Startup and in-memory role seeding.                         |
| `app.db`               | Drizzle SQL queries (bridged into pino at `debug`).         |
| `app.bootstrap`        | User + demo-data seed at startup (`src/scripts/bootstrapUsers.ts`). |

Framework components: `framework.app`, `framework.app.http` (see `packages/drizzle-graphql-rbac/README.md`).

To see SQL traces, run with `LOG_LEVEL=debug`. The Drizzle `logger` option in `src/db.ts` forwards `logQuery(query, params)` to the shared pino root — there is no separate `console.log` path.

## Database migrations

Drizzle Kit drives both the schema (`src/db.ts`) and the SQLite file (`todo.db`, configured in `drizzle.config.ts`). Two workflows are supported:

### Quick sync (dev)

Push the current schema directly to the database without generating migration files:

```bash
npm run db:push
```

Use this for fast iteration. It diffs `src/db.ts` against the live DB and applies the changes in place.

### Versioned migrations (recommended for shared/prod DBs)

1. **Generate** SQL migration files from changes in `src/db.ts`:

   ```bash
   npm run db:generate
   ```

   Files are written to `./drizzle/` (the `out` directory in `drizzle.config.ts`). Commit them.

2. **Apply** pending migrations to the database:

   ```bash
   npm run db:migrate
   ```

   Drizzle records applied migrations in the `__drizzle_migrations` table so re-runs are idempotent.

A typical change loop:

```bash
# 1. edit src/db.ts
npm run db:generate     # creates drizzle/0001_xxx.sql
npm run db:migrate      # applies it to todo.db
npm run dev             # restart / hot reload picks up new types
```

### Inspect the database

```bash
npm run db:studio
```

Opens Drizzle Studio in the browser for browsing/editing rows.

> The schema is in `src/schema.ts` (re-exporting the framework's `users` / `sessions` from `drizzle-graphql-rbac/tables`) and is consumed by `drizzle-kit` via `drizzle.config.ts`. There is no raw-SQL bootstrap script — `db:push` is the canonical first step.

## Endpoints

The server exposes three surfaces:

- **REST `/auth/*`** — authentication only. Register, login, logout, and "who am I?" all happen here. The successful responses set an HttpOnly session cookie (`sid`); a bearer token is also accepted for non-browser clients.

  | Method | Path             | Body                              | Auth |
  |--------|------------------|-----------------------------------|------|
  | POST   | `/auth/register` | `{ name, email, password }`       | no   |
  | POST   | `/auth/login`    | `{ email, password }`             | no   |
  | POST   | `/auth/logout`   | —                                 | yes  |
  | GET    | `/auth/me`       | —                                 | yes  |

- **REST `/admin/*`** — admin dashboard's user CRUD. RBAC-enforced.

  | Method | Path                 | Body                                |
  |--------|----------------------|-------------------------------------|
  | GET    | `/admin/users`       | —                                   |
  | POST   | `/admin/users`       | `{ name, email, password, active? }`|
  | PATCH  | `/admin/users/:id`   | partial `{ name, email, active }`   |
  | DELETE | `/admin/users/:id`   | —                                   |

- **GraphQL `POST /graphql`** — application data (todos, assignees, etc.). No auth fields here.

```
POST http://localhost:3000/graphql
Content-Type: application/json
```

Body shape:

```json
{ "query": "<graphql operation>", "variables": { } }
```

---

## CRUD Examples

### Create

Insert a single todo:

```graphql
mutation CreateTodo {
  insertIntoTodosSingle(values: { title: "buy milk", completed: false }) {
    id
    title
    completed
    createdAt
  }
}
```

With variables:

```graphql
mutation CreateTodo($title: String!) {
  insertIntoTodosSingle(values: { title: $title, completed: false }) {
    id
    title
    completed
  }
}
```

```json
{ "title": "write docs" }
```

Insert many at once:

```graphql
mutation CreateMany {
  insertIntoTodos(
    values: [
      { title: "task A" }
      { title: "task B", completed: true }
    ]
  ) {
    id
    title
    completed
  }
}
```

---

### Read

List all todos:

```graphql
query AllTodos {
  todos {
    id
    title
    completed
    createdAt
  }
}
```

Sorted, with pagination:

```graphql
query Paged {
  todos(orderBy: { id: desc }, limit: 10, offset: 0) {
    id
    title
    completed
  }
}
```

Filter (only incomplete) — `where` accepts an Odoo polish-prefix domain (a
JSON array). See [Filter operators](#filter-operators-cheat-sheet) for the
full syntax.

```graphql
query Pending($w: JSON) {
  todos(where: $w, orderBy: { id: ASC }) {
    id
    title
  }
}
```

```json
{ "w": [["completed", "=", false]] }
```

More complex filter (title contains "buy" OR completed=true):

```graphql
query Search($w: JSON) {
  todos(where: $w) {
    id
    title
    completed
  }
}
```

```json
{ "w": ["|", ["title", "ilike", "%buy%"], ["completed", "=", true]] }
```

Read a single todo by id:

```graphql
query OneTodo($w: JSON) {
  todosSingle(where: $w) {
    id
    title
    completed
    createdAt
  }
}
```

```json
{ "w": [["id", "=", 1]] }
```

---

### Update

Update one todo by id:

```graphql
mutation MarkDone($w: JSON) {
  updateTodos(where: $w, set: { completed: true }) {
    id
    title
    completed
  }
}
```

```json
{ "w": [["id", "=", 1]] }
```

Rename a todo:

```graphql
mutation Rename($w: JSON, $title: String!) {
  updateTodos(where: $w, set: { title: $title }) {
    id
    title
  }
}
```

```json
{ "w": [["id", "=", 1]], "title": "buy oat milk" }
```

Bulk update — mark all incomplete todos as complete:

```graphql
mutation CompleteAll($w: JSON) {
  updateTodos(where: $w, set: { completed: true }) {
    id
    completed
  }
}
```

```json
{ "w": [["completed", "=", false]] }
```

---

### Delete

Delete one todo by id:

```graphql
mutation DeleteTodo($w: JSON) {
  deleteFromTodos(where: $w) {
    id
  }
}
```

```json
{ "w": [["id", "=", 1]] }
```

Delete all completed todos:

```graphql
mutation ClearDone($w: JSON) {
  deleteFromTodos(where: $w) {
    id
    title
  }
}
```

```json
{ "w": [["completed", "=", true]] }
```

---

## curl examples

Create:

```bash
curl -X POST http://localhost:3000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation($t:String!){insertIntoTodosSingle(values:{title:$t}){id title completed}}","variables":{"t":"buy milk"}}'
```

List:

```bash
curl -X POST http://localhost:3000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ todos { id title completed } }"}'
```

Update:

```bash
curl -X POST http://localhost:3000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation($w:JSON){updateTodos(where:$w, set:{completed:true}){id completed}}","variables":{"w":[["id","=",1]]}}'
```

Delete:

```bash
curl -X POST http://localhost:3000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation($w:JSON){deleteFromTodos(where:$w){id}}","variables":{"w":[["id","=",1]]}}'
```

---

## Filter operators (cheat sheet)

`where` is a JSON Odoo polish-prefix domain. Per-leaf operators:

- `=`, `!=` (alias `<>`) — equals / not equals
- `<`, `<=`, `>`, `>=` — comparisons
- `in`, `not in` — set membership
- `like`, `ilike`, `not like`, `not ilike` — pattern match
- `=?` — equal-or-null (drops the predicate when the value resolves to `null`,
  useful with placeholders)

Combinators (prefix, polish-style):

- `&` — AND of next two sub-expressions (also the implicit combinator across
  remaining top-level items)
- `|` — OR of next two sub-expressions
- `!` — NOT of the next sub-expression

Dotted field paths traverse single-column relations:
`[["assigneeId.email", "ilike", "%@x.com"]]` →
`assigneeId IN (SELECT id FROM assignees WHERE email ILIKE …)`.

The string `"current_user.id"` is substituted from the request context at
evaluation time. Full reference: `packages/drizzle-graphql-rbac/README.md`.

The SQLite database file `todo.db` is created on first run of `npm run db:push`.

## Tests

```bash
npm test            # app tests + framework workspace tests
npm run test:app    # app-level tests only (src/*.test.ts)
```

Tests use Node's built-in test runner under `tsx` and run against isolated in-memory SQLite databases.
