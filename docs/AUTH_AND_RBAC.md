# Auth, Sessions, and RBAC

This app includes a minimal authentication system (users + sessions) and an Odoo-like RBAC system (groups, access rights, record rules).

## Auth and sessions

Authentication is **REST only** — there are no `register` / `login` / `logout` / `me` GraphQL fields. The endpoints live under `/auth/*` and are owned by `src/auth/routes.ts`:

| Method | Path             | Body                              | Auth |
|--------|------------------|-----------------------------------|------|
| POST   | `/auth/register` | `{ name, email, password }`       | no   |
| POST   | `/auth/login`    | `{ email, password }`             | no   |
| POST   | `/auth/logout`   | —                                 | yes  |
| GET    | `/auth/me`       | —                                 | yes  |

- **Token sources (precedence)**:
  - session cookie `sid` (HttpOnly, set by `/auth/login` and `/auth/register`), otherwise
  - `Authorization: Bearer <token>` (for non-browser clients)
- **Session storage**: `sessions` table in SQLite (`src/db.ts`)
- **Sliding expiry**: session expiry is refreshed when a valid token is used.

The same `sessionMiddleware` (`src/auth/middleware.ts`) is mounted on `/graphql` so resolvers see `ctx.user` exactly as before.

### Admin dashboard endpoints

The admin dashboard's user CRUD also runs over REST (`src/admin/routes.ts`), enforced by RBAC via `RbacDb`:

| Method | Path                | Body                                | Auth |
|--------|---------------------|-------------------------------------|------|
| GET    | `/admin/users`      | —                                   | yes  |
| POST   | `/admin/users`      | `{ name, email, password, active? }`| yes  |
| PATCH  | `/admin/users/:id`  | partial `{ name, email, active }`   | yes  |
| DELETE | `/admin/users/:id`  | —                                   | yes  |

### Frontend behavior

The static frontend in `public/` relies on the HttpOnly session cookie — no token in `localStorage`. `app.js` exposes `login`, `register`, `logout`, `getMe`, `requireAuth`, and an `api(path, opts)` helper for the admin REST calls.

## RBAC model (implementation)

RBAC is implemented in `src/graphql/rbac.ts` and uses the following DB tables (see `src/db.ts`):

- `groups`: group definitions, optional parent group (`parentGroupId`), and `isAdmin`
- `userGroups`: user ↔ group membership
- `accessRights`: per-group CRUD grants by `resource`
- `recordRules`: per-group row-level rules by `resource` + `permType`, stored as a JSON-encoded “domain”

### Enforcement points

There are two layers:

- **GraphQL resolver enforcement**: the generated CRUD resolvers call `rbac.enforce(...)` (wired in `src/server.ts` via `buildSchema(..., { rbac: { enforce } })`).
- **RBAC-bound DB wrapper**: `src/graphql/rbacDb.ts` can wrap Drizzle chains so row filters are AND-injected at query finalization.

### Admin bypass

If a user is in a group with `groups.isAdmin = true`, RBAC checks are bypassed (intended for the seeded “Administration” group).

## Seeds demonstrating RBAC

- `src/scripts/seed-admin.ts`: creates/updates an admin user and an `Administration` group (`isAdmin=true`).
- `src/scripts/seed-demo.ts`: creates demo users and a sample record rule that scopes `todos` reads to “assigned to current user”.

## Domain rules (record rules)

Record rules use an Odoo-style domain expression that is parsed and compiled to SQL by `parseDomain()` / `domainToSql()` in `src/graphql/rbac.ts`.

The docs file `docs/RBAC.md` contains the original PRD-style design notes; this page documents what’s actually implemented in this repo.

