# How to run (dev, migrations, tests)

This app is a single-process Hono server that serves:

- The web UI at `http://localhost:3000/`
- GraphiQL at `http://localhost:3000/graphql`
- The GraphQL endpoint at `POST /graphql`

The SQLite database file is `todo.db` in the project root.

## Prerequisites

- Node.js + npm

## Install dependencies

```bash
npm install
```

## Run the app (development)

Starts the server with watch/reload:

```bash
npm run dev
```

Then open:

- App: `http://localhost:3000/`
- GraphiQL: `http://localhost:3000/graphql`

## Run the app (one-shot)

Runs the server once (no watch):

```bash
npm start
```

## Database migrations

Drizzle Kit is configured in `drizzle.config.ts`:

- **schema**: `./src/db.ts`
- **migrations output**: `./drizzle`
- **database**: `todo.db`

You can use either workflow below.

### Option A: Quick sync (fast iteration)

Diffs `src/db.ts` against `todo.db` and applies changes directly (no migration files):

```bash
npm run db:push
```

### Option B: Versioned migrations (recommended)

1) Generate migration SQL files from changes in `src/db.ts`:

```bash
npm run db:generate
```

2) Apply pending migrations to `todo.db`:

```bash
npm run db:migrate
```

Migration files are created under `drizzle/`.

### Inspect the database

Launch Drizzle Studio:

```bash
npm run db:studio
```

## Seed an admin user (optional)

Runs the admin seeding script:

```bash
npm run seed:admin
```

## Run tests

Runs the Node test runner against the GraphQL tests:

```bash
npm test
```

Run a single test file:

```bash
node --import tsx --test src/graphql/builder.test.ts
```

Filter tests by name:

```bash
npm test -- --test-name-pattern "<regex>"
```

