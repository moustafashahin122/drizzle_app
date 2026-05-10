# Drizzle Todo App (Hono + GraphQL + Drizzle + SQLite)

Single-process **Hono** server with a **GraphQL** endpoint generated from the Drizzle schema in `src/db.ts` (SQLite via `better-sqlite3`). Includes a simple static HTML/JS frontend in `public/` that talks to the GraphQL API.

This repo does **not** use the `drizzle-graphql` npm package. The GraphQL schema generator is implemented in `src/graphql/` and mounted at `/graphql`.

## Documentation

- Run / migrations / tests: `docs/HOW_TO_RUN.md`
- GraphQL generator deep dive: `docs/explanations/src-graphql.md`
- Architecture overview: `docs/ARCHITECTURE.md`
- Database schema + Drizzle workflows: `docs/DATABASE.md`
- Auth, sessions, and RBAC: `docs/AUTH_AND_RBAC.md`
- Seeds, scripts, and tests: `docs/SCRIPTS_AND_TESTS.md`

## Run

```bash
cd drizzle_todo_app
npm install
npm run dev
```

- App: `http://localhost:3000`
- GraphiQL explorer: `http://localhost:3000/graphql`

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

> Note: the app can create its tables without a prior migrate step; see `src/db.ts` and `docs/DATABASE.md` for details.

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
JSON array). See `src/graphql/domain/README.md` for the full syntax.

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
evaluation time. Full reference: `src/graphql/domain/README.md`.

The SQLite database file `todo.db` is created automatically on first run.
# drizzle_app
