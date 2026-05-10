# Architecture

This app is a single-process Node.js server that serves a static frontend and a GraphQL API backed by SQLite.

## High-level components

- **HTTP server**: Hono (`src/server.ts`)
  - GraphQL endpoint at `ALL /graphql` (via graphql-yoga)
  - Static assets served from `public/` for all other routes
- **Database**: SQLite (`todo.db`) accessed through Drizzle ORM (`src/db.ts`)
- **GraphQL**: executable schema generated from the Drizzle schema namespace (`src/graphql/*`)
- **Auth + sessions**: implemented in `src/graphql/auth.ts`
- **RBAC**: Odoo-like groups/ACLs/record rules in `src/graphql/rbac.ts` with an optional DB wrapper in `src/graphql/rbacDb.ts`

## Request flow

1. **Hono receives request** (`src/server.ts`)
2. If route is `/graphql`, it delegates to **graphql-yoga** and builds a per-request GraphQL context:
   - resolves `ctx.user` + `ctx.session` from either:
     - session cookie (preferred), or
     - `Authorization: Bearer <token>`
   - creates `ctx.batch` (a request-scoped map used for limited relation batching)
   - creates `ctx.db` as an RBAC-enforcing Drizzle wrapper
3. The auto-generated GraphQL resolvers execute Drizzle queries against `ctx.db`
4. For non-`/graphql` routes, static files are served from `public/`

## Key implementation files

- `src/server.ts`: server wiring, Yoga context, static hosting
- `src/db.ts`: schema + Drizzle `db` instance bound to `better-sqlite3`
- `src/graphql/index.ts`: GraphQL public entrypoint (`buildSchema` + scalars)
- `src/graphql/builder.ts`: schema generator (types + CRUD root fields)
- `src/graphql/relations.ts`: relation introspection (explicit + auto-FK)
- `src/graphql/filters.ts`: `where` / `orderBy` input construction and SQL translation
- `src/graphql/auth.ts`: auth schema extensions + session helpers
- `src/graphql/rbac.ts`: RBAC engine (groups, ACLs, record rules / domains)
- `src/graphql/rbacDb.ts`: RBAC-bound DB proxy (enforce at query finalization)

## Operational docs

- Run / migrations / tests: `docs/HOW_TO_RUN.md`
- GraphQL generator deep dive: `docs/explanations/src-graphql.md`
- Database details: `docs/DATABASE.md`
- Auth and RBAC: `docs/AUTH_AND_RBAC.md`
- Scripts and tests: `docs/SCRIPTS_AND_TESTS.md`

