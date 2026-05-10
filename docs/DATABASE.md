# Database (SQLite + Drizzle)

The app uses SQLite via `better-sqlite3`. The on-disk database file is `todo.db` in the project root.

## Schema location

- **Schema source of truth**: `src/db.ts`
- **Drizzle Kit config**: `drizzle.config.ts`
  - `schema: "./src/db.ts"`
  - `dbCredentials.url: "todo.db"`
  - migrations output: `./drizzle`

## Tables (summary)

All tables are defined in `src/db.ts`.

- **`users`**
  - `email` is unique
  - `passwordHash` exists in DB but is hidden from GraphQL output (`src/server.ts`)
- **`todos`**
  - optional `assigneeId` FK to `users.id`
- **`sessions`**
  - `token` is unique
  - `expiresAt` is updated to implement sliding expiry
- **`groups`**
  - `isAdmin=true` bypasses RBAC checks
- **`userGroups`**
  - join table linking users ↔ groups
- **`accessRights`**
  - per-group CRUD grants by `resource`
- **`recordRules`**
  - row-level rules by group/resource/perm type, stored as JSON-encoded “domain”

## Migrations workflows

Two supported workflows (see `docs/HOW_TO_RUN.md` for exact commands):

- **Quick sync (fast iteration)**: `npm run db:push`
  - diffs `src/db.ts` against `todo.db` and applies changes directly
- **Versioned migrations**: `npm run db:generate` + `npm run db:migrate`
  - emits SQL files under `drizzle/` and applies them idempotently

## Inspecting the DB

- Drizzle Studio: `npm run db:studio`

## Seeds

- **Admin seed**: `npm run seed:admin` (`src/scripts/seed-admin.ts`)
- **Demo seed** (manual): `npx tsx src/scripts/seed-demo.ts`

## Notes / gotchas

- **Relative DB path**: runtime uses `new Database("todo.db")` (relative to the current working directory). If you run the server from a different cwd, you can accidentally create/use a different DB file.
- **SQLite FK enforcement**: `src/db.ts` enables `PRAGMA foreign_keys = ON` for the app connection. Other tools/connections may not enforce FKs unless they enable it too.

