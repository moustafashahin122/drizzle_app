# Auth, Sessions, and RBAC

This app includes a minimal authentication system (users + sessions) and an Odoo-like RBAC system (roles, access rights, record rules).

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

The same `sessionMiddleware` is mounted on `/graphql` so resolvers see `ctx.user` exactly as before.

### Admin dashboard endpoints

The admin dashboard's user CRUD and role-membership management run over REST (provided by the framework's `buildAdminRoutes`), enforced by RBAC via `RbacDb`:

| Method | Path                          | Body                                | Auth |
|--------|-------------------------------|-------------------------------------|------|
| GET    | `/admin/users`                | —                                   | yes  |
| POST   | `/admin/users`                | `{ name, email, password, active? }`| yes  |
| PATCH  | `/admin/users/:id`            | partial `{ name, email, active }`   | yes  |
| DELETE | `/admin/users/:id`            | —                                   | yes  |
| GET    | `/admin/roles`                | —                                   | yes  |
| GET    | `/admin/users/:id/roles`      | —                                   | yes  |
| POST   | `/admin/users/:id/roles`      | `{ roleKey }`                       | yes  |
| DELETE | `/admin/users/:id/roles/:key` | —                                   | yes  |

Roles themselves are code-defined and synced to the `roles` DB table on server start; the membership endpoints only manage the user → role assignment (writing `user_roles` rows by role id). Posting a `roleKey` that doesn't exist in the synced `roles` table returns 400.

### Frontend behavior

The static frontend in `public/` relies on the HttpOnly session cookie — no token in `localStorage`. `app.js` exposes `login`, `register`, `logout`, `getMe`, `requireAuth`, and an `api(path, opts)` helper for the admin REST calls.

## RBAC model (implementation)

RBAC is **code-defined with DB sync**: roles, access rights, and record rules live in three small TypeScript files in the host app. Each entry carries an `xid` (external id) that anchors its identity in matching DB tables. On server start, `createApp` reconciles the DB to match the code (in the background — the server starts listening immediately).

| Source                  | Where it lives                                  |
|-------------------------|-------------------------------------------------|
| Framework `admin` role  | `drizzle-graphql-rbac/src/frameworkRbac.ts` (auto-merged by `createApp`) |
| App roles               | `src/roles.ts` (`defineRoles`) → `roles` table  |
| Access rights           | `src/accessRights.ts` (`defineAccessRights`) → `access_rights` |
| Record rules            | `src/recordRules.ts` (`defineRecordRules`) → `record_rules` |
| User → role assignment  | `user_roles` table (FK to `roles.id`)           |

There is no inheritance — flatten any shared grants. Each role's grants stand alone.

### Sync semantics

`syncRbacFromCode(db, schema, resolved)` reconciles the DB in three phases:

1. **Roles** — load existing rows. Any whose xid is no longer in code is cascade-deleted (its `user_roles`, `access_rights`, and `record_rules` rows go too). Then upsert each code-defined role by xid.
2. **Access rights** — delete by missing xid; upsert by xid (rewrite if any of role / resource / CRUD booleans changed).
3. **Record rules** — same pattern, with the JSON-serialized domain compared on update.

The engine reads from an in-memory snapshot built post-sync. Tests can `await app.rbacReady` if they need the snapshot loaded before issuing requests.

### Enforcement points

There are two layers:

- **GraphQL resolver enforcement**: the generated CRUD resolvers call `rbac.enforce(...)`, wired through `createApp({ rbac: { roles, accessRights, recordRules } })`.
- **RBAC-bound DB wrapper**: `RbacDb` wraps Drizzle chains so row filters are AND-injected at query finalization. The admin REST handlers use it for user CRUD.

### Admin bypass

If a user holds a role with `isAdmin: true` in `roles.ts`, RBAC checks are bypassed. The seeded `admin` role demonstrates this.

## Seeds demonstrating RBAC

- `src/scripts/seed-admin.ts`: creates/updates an admin user and assigns them the code-defined `admin` role.
- `src/scripts/seed-demo.ts`: creates demo users; `demo1` is assigned the `demo` role, whose record rule scopes `todos` to "assigned to current user".

## Domain rules (record rules)

Record rules use an Odoo-style domain expression that is parsed and compiled to SQL by `parseDomain()` / `domainToSql()` in the framework's `src/graphql/domain` module.

The docs file `docs/RBAC.md` contains the PRD-style design notes; this page documents what's actually implemented in this repo.
