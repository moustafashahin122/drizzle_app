# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Hono server with tsx watch on `http://localhost:3000` (GraphiQL at `/graphql`).
- `npm start` — run server once without watch.
- `npm test` — runs the package's test suite (`drizzle-graphql-rbac` workspace) under Node's built-in test runner via `tsx`.
- `npm run db:push` — apply the Drizzle schema in `src/schema.ts` to `todo.db`. This is the bootstrap step on a fresh checkout. `src/schema.ts` imports the framework tables from `drizzle-graphql-rbac/tables` (the schema-only subpath) so `drizzle-kit`'s CJS loader doesn't pull in the app runtime. The file-backed Drizzle handle lives in `src/sudoDb.ts`.
- `npm run db:generate` / `npm run db:migrate` — generate and apply SQL migrations for production-style flows.
- `npm run db:studio` — Drizzle Studio for browsing `todo.db`.
- `npm run seed:demo` — runs `src/scripts/seedDemo.ts`, which upserts the three demo users (`demo_admin@example.com` admin, `demo_manager@example.com` manager, `demo_user@example.com` demo) with password `demo123` (override via `DEV_PASSWORD`) and, if `todos` is empty, seeds a demo project + todos. Safe to re-run; todo seeding is one-shot.
- Server startup runs `src/scripts/bootstrapUsers.ts`, which is now prod-only: in `NODE_ENV === "production"` it requires `ADMIN_EMAIL` / `ADMIN_PASSWORD` and upserts that single admin row. In dev it is a no-op — use `npm run seed:demo` to populate demo data.

## Architecture

This is a single-process Hono app that serves a static frontend (`public/`) and a GraphQL endpoint at `POST /graphql`.

### Drizzle schema (`src/schema.ts`)

Re-exports the framework-owned tables (`users`, `sessions`) from `drizzle-graphql-rbac/tables` and defines the app-owned `todos` table. The `todos.assignee_id` column has a `.references(() => users.id)` FK — this single-column FK is what the GraphQL layer auto-promotes into a relation field (forward `assigneeId` and inverse `todos`). The DB schema is managed entirely through `drizzle-kit` against these declarations; there is no raw-SQL bootstrap script.

### In-memory RBAC (`src/roles.ts`, `src/accessRights.ts`, `src/recordRules.ts`)

Roles, per-role CRUD grants, and per-role row-level rules are declared in three small TypeScript files. There is **no inheritance** — flatten any shared grants. The framework provides the `admin` role (full bypass) automatically — `createApp` merges it in, and declaring `admin` in app code throws at startup.

RBAC is fully in-memory: `createApp` builds the engine snapshot synchronously from the code config, and user → role memberships live in process memory. There are no RBAC tables and no startup sync. Memberships reset on restart; `server.ts` re-seeds well-known accounts (admin, demo1) by email after `createApp` returns.

The admin dashboard's `/admin/users/:id/roles` endpoints add/remove memberships at runtime through the engine's `assignRole` / `revokeRole` API.

### Custom GraphQL builder (`packages/drizzle-graphql-rbac/src/graphql/builder/`)

This app does **not** use the `drizzle-graphql` npm package. `builder.ts` is a hand-rolled schema generator that takes a Drizzle DB + a `* as schema` namespace and emits an executable `GraphQLSchema`. The pipeline:

1. **`relations.ts`** — introspects the schema namespace and merges two relation sources, in order of precedence: explicit Drizzle `relations(...)` declarations, then auto-promoted single-column FKs (forward "one" + inverse "many"). Composite FKs are skipped.
2. **`builder.ts` Pass 1** — for each table builds a `GraphQLObjectType` with a *lazy* fields thunk (so cyclic types resolve through the same registered object), plus `Insert` / `Update` / `Where` / `OrderBy` input types. Required Insert fields = `notNull && !hasDefault && !generated`.
3. **`builder.ts` Pass 2 (`addRootFields`)** — wires per-table root fields:
   - Query: `<jsKey>(where, orderBy, limit, offset)`, `<jsKey>Single(where, orderBy)`
   - Mutation: `insertInto<Type>`, `insertInto<Type>Single`, `update<Type>`, `deleteFrom<Type>`
   - Mutations use `.returning()` to emit affected rows.
4. **`filters.ts`** — translates the `where` / `orderBy` GraphQL inputs into Drizzle SQL via `whereToSql` / `orderByToSql`. Supported per-field operators: `eq, ne, lt, lte, gt, gte, inArray, notInArray, like, ilike, notLike, notIlike, isNull`. Logical combinators `AND`, `OR`, `NOT` are at the top of `where`.

### Recursion and the column-vs-relation rule

A relation field replaces a same-named scalar column on the **output** type only — e.g. `todos.assigneeId` becomes an object reference to the `Assignee` row, so `todos { assigneeId { name } }` traverses, but `todos { assigneeId }` will not return the integer. The original scalar is still reachable inside `where`, `set`, Insert, and Update inputs (those iterate the unchanged column map). Because relation field types reference the same registered `GraphQLObjectType`, arbitrary nested traversal works automatically (e.g. `todos { assigneeId { todos { assigneeId { name } } } }`). Resolvers issue one query per relation field per parent row — there is no DataLoader batching.

### Server wiring (`src/server.ts`)

`createApp(...)` builds the GraphQL schema, the RBAC engine, and the Hono app in one call; the result is handed to `@hono/node-server`'s `serve`. Static assets are served from `./public`. After `createApp` returns, the server seeds a small set of in-memory role memberships (admin/demo) from a hard-coded email map.

## Tests

Tests live in `packages/drizzle-graphql-rbac/src/` next to the modules they cover and use Node's built-in test runner. They construct an in-memory or temp SQLite DB and exercise the schema builder end-to-end through GraphQL queries — the schema-as-output is the contract under test, so when changing builder/filter/relation/RBAC logic, prefer adjusting or adding queries in these files over mocking internals.
