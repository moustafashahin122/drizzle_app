# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Hono server with tsx watch on `http://localhost:3000` (GraphiQL at `/graphql`).
- `npm start` — run server once without watch.
- `npm test` — runs the node test runner against `src/graphql/*.test.ts` via `tsx`. To run a single test file: `node --import tsx --test src/graphql/builder.test.ts`. To filter by name: append `--test-name-pattern '<regex>'`.
- `npx tsx src/scripts/init-db.ts` — idempotent `CREATE TABLE IF NOT EXISTS` for `todo.db`. Use this instead of `drizzle-kit push` — `drizzle-kit` can't load this workspace's TS-only package entry (`drizzle-graphql-rbac` exports `./src/index.ts`), so the kit commands fail with `Cannot find module './app.js'`. The init script bootstraps the framework tables (`users`, `sessions`, `roles`, `access_rights`, `record_rules`, `user_roles`) plus `todos`. The script also detects and migrates the legacy `user_roles(role_key)` schema by dropping the old table — then `syncRbacFromCode` (run automatically on server start) populates `roles`, `access_rights`, and `record_rules` from the code config.
- `npm run db:studio` — Drizzle Studio for browsing `todo.db` (read-only browse works; do not rely on `db:push`).

## Architecture

This is a single-process Hono app that serves a static frontend (`public/`) and a GraphQL endpoint at `POST /graphql`. There is no separation between `backend/` and `frontend/` — those top-level directories exist but are empty stubs; all real code lives in `src/` and `public/`.

### Drizzle schema (`src/db.ts`)

Re-exports the framework-owned tables (`users`, `sessions`, `roles`, `access_rights`, `record_rules`, `user_roles`) from `drizzle-graphql-rbac` and defines the app-owned `todos` table. The `todos.assignee_id` column has a `.references(() => users.id)` FK — this single-column FK is what the GraphQL layer auto-promotes into a relation field (forward `assigneeId` and inverse `todos`).

### Code-defined RBAC with DB sync (`src/roles.ts`, `src/accessRights.ts`, `src/recordRules.ts`)

Roles, per-role CRUD grants, and per-role row-level rules are declared in three small TypeScript files. Each entry carries an `xid` ("external id", like Odoo's `xml_id`) that anchors its identity in the DB across rebuilds. There is **no inheritance** — flatten any shared grants.

The framework provides the `admin` role (full bypass, xid `dgr.role.admin`) automatically — `createApp` merges it into the user's config. App-side files only define app-specific roles (e.g. `demo`); declaring `admin` or any `dgr.`-prefixed xid in app code throws at startup.

On server start, `createApp` kicks off `syncRbacFromCode` in the background (via `queueMicrotask`, after `serve(...)` begins listening) to reconcile the DB with the code:
- Roles whose xid is no longer in code are cascade-deleted (their `user_roles`, `access_rights`, and `record_rules` rows go too).
- Code-defined roles are upserted by xid; CRUD-flag changes update the AR row in place; domain changes update the RR row.
- The engine snapshot is reloaded after sync; the cache is cleared.

Tests can `await app.rbacReady` if they need the snapshot before issuing requests. The admin dashboard's `/admin/users/:id/roles` endpoints add/remove memberships at runtime against the synced `roles` table. See `docs/AUTH_AND_RBAC.md`.

### Custom GraphQL builder (`src/graphql/`)

Despite the README's wording, this app does **not** use the `drizzle-graphql` npm package. `src/graphql/builder.ts` is a hand-rolled schema generator that takes a Drizzle DB + a `* as schema` namespace and emits an executable `GraphQLSchema`. The pipeline:

1. **`relations.ts`** — introspects the schema namespace and merges three relation sources, in order of precedence: explicit Drizzle `relations(...)` declarations, then auto-promoted single-column FKs (forward "one" + inverse "many"). Composite FKs are skipped.
2. **`builder.ts` Pass 1** — for each table builds a `GraphQLObjectType` with a *lazy* fields thunk (so cyclic types resolve through the same registered object), plus `Insert` / `Update` / `Where` / `OrderBy` input types. Required Insert fields = `notNull && !hasDefault && !generated`.
3. **`builder.ts` Pass 2 (`addRootFields`)** — wires per-table root fields:
   - Query: `<jsKey>(where, orderBy, limit, offset)`, `<jsKey>Single(where, orderBy)`
   - Mutation: `insertInto<Type>`, `insertInto<Type>Single`, `update<Type>`, `deleteFrom<Type>`
   - Mutations use `.returning()` to emit affected rows.
4. **`filters.ts`** — translates the `where` / `orderBy` GraphQL inputs into Drizzle SQL via `whereToSql` / `orderByToSql`. Supported per-field operators: `eq, ne, lt, lte, gt, gte, inArray, notInArray, like, ilike, notLike, notIlike, isNull`. Logical combinators `AND`, `OR`, `NOT` are at the top of `where`.

### Recursion and the column-vs-relation rule

A relation field replaces a same-named scalar column on the **output** type only — e.g. `todos.assigneeId` becomes an object reference to the `Assignee` row, so `todos { assigneeId { name } }` traverses, but `todos { assigneeId }` will not return the integer. The original scalar is still reachable inside `where`, `set`, Insert, and Update inputs (those iterate the unchanged column map). Because relation field types reference the same registered `GraphQLObjectType`, arbitrary nested traversal works automatically (e.g. `todos { assigneeId { todos { assigneeId { name } } } }`). Resolvers issue one query per relation field per parent row — there is no DataLoader batching.

### Server wiring (`src/server.ts`)

`buildSchema(db, dbModule)` is called once at startup; the resulting schema is mounted on `graphql-yoga`, which Hono delegates to via `app.all("/graphql", ...)`. Static assets are served from `./public`.

## Tests

Tests live next to the modules they cover (`builder.test.ts`, `filters.test.ts`, `relations.test.ts`) and use Node's built-in test runner. They construct an in-memory or temp SQLite DB and exercise the schema builder end-to-end through GraphQL queries — the schema-as-output is the contract under test, so when changing builder/filter/relation logic, prefer adjusting or adding queries in these files over mocking internals.
