# Auth, Sessions, and RBAC

This app includes a minimal authentication system (users + sessions) and an Odoo-like RBAC system (groups, access rights, record rules).

## Auth and sessions

- **GraphQL auth fields** are provided by `src/graphql/auth.ts` and mounted via `extraQueryFields` / `extraMutationFields` in `src/server.ts`.
- **Token sources (precedence)**:
  - session cookie (preferred), otherwise
  - `Authorization: Bearer <token>`
- **Session storage**: `sessions` table in SQLite (`src/db.ts`)
- **Sliding expiry**: session expiry is refreshed when a valid token is used.

### Frontend behavior

The static frontend in `public/` stores a token in `localStorage` and sends it as `Authorization: Bearer <token>` to `/graphql`.

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

