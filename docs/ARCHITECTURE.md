# Architecture

This app is a single-process Node.js server that serves a static frontend and a GraphQL API backed by SQLite.

## High-level components

- **HTTP server**: Hono (`src/server.ts`)
  - REST `/auth/*` for register/login/logout/me
  - REST `/admin/*` for the admin dashboard (RBAC-enforced user CRUD)
  - GraphQL endpoint at `ALL /graphql` (via graphql-yoga) — data only
  - Static assets served from `public/` for all other routes
- **Database**: SQLite (`todo.db`) accessed through Drizzle ORM (`src/db.ts`)
- **GraphQL**: executable schema generated from the Drizzle schema namespace (`src/graphql/*`)
- **Auth + sessions**: REST endpoints in `src/auth/routes.ts`; primitives in `src/auth/session.ts`; Hono middleware in `src/auth/middleware.ts`
- **Admin REST**: `src/admin/routes.ts` (the dashboard talks to these, not GraphQL)
- **RBAC**: Odoo-like groups/ACLs/record rules in `src/graphql/rbac/rbac.ts` with the per-request `RbacDb` wrapper in `src/graphql/rbac/rbacDb.ts`

## Request flow

1. **Hono receives request** (`src/server.ts`)
2. **Session middleware** (`src/auth/middleware.ts`) runs on `/auth/*`, `/admin/*`, and `/graphql`. It resolves `c.var.user` / `c.var.session` from:
   - session cookie (preferred), or
   - `Authorization: Bearer <token>`
3. If the route is `/auth/*`, the auth sub-app handles register/login/logout/me directly.
4. If the route is `/admin/*`, the admin sub-app gates on `requireAuth`, then runs CRUD through the per-request `RbacDb`.
5. If the route is `/graphql`, the user/session are stashed on the request and Yoga's context resolver picks them up; the auto-generated resolvers run against an RBAC-enforcing Drizzle wrapper (`ctx.db`).
6. For other routes, static files are served from `public/`.

## Key implementation files

- `src/server.ts`: server wiring, Yoga context, static hosting
- `src/db.ts`: schema + Drizzle `db` instance bound to `better-sqlite3`
- `src/graphql/index.ts`: GraphQL public entrypoint (`buildSchema` + scalars)
- `src/graphql/builder.ts`: schema generator (types + CRUD root fields)
- `src/graphql/relations.ts`: relation introspection (explicit + auto-FK)
- `src/graphql/filters.ts`: `where` / `orderBy` input construction and SQL translation
- `src/auth/routes.ts`: `/auth/*` REST endpoints (register, login, logout, me)
- `src/auth/session.ts`: token, cookie, session-resolution primitives
- `src/auth/middleware.ts`: Hono session middleware + `requireAuth` gate
- `src/admin/routes.ts`: `/admin/users` REST endpoints (RBAC-enforced)
- `src/graphql/rbac/rbac.ts`: RBAC engine (groups, ACLs, record rules / domains)
- `src/graphql/rbac/rbacDb.ts`: RBAC-bound DB proxy (enforce at query finalization)

## Operational docs

- Run / migrations / tests: `docs/HOW_TO_RUN.md`
- GraphQL generator deep dive: `docs/explanations/src-graphql.md`
- Database details: `docs/DATABASE.md`
- Auth and RBAC: `docs/AUTH_AND_RBAC.md`
- Scripts and tests: `docs/SCRIPTS_AND_TESTS.md`

