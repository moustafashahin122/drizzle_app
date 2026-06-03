# drizzle-todo-demo

A single-process Hono app that exposes a GraphQL API (`POST /graphql`, GraphiQL at `GET /graphql`) backed by Drizzle ORM + SQLite, with an in-memory RBAC layer. Static frontend served from `public/`.

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture overview.

## Prerequisites

- Node.js 20+
- `npm install`

## Running the app

```bash
# 1. Apply the schema to a fresh todo.db
npm run db:push

# 2. (Optional) Seed demo users + todos
#    Creates demo_admin@example.com / demo_manager@example.com / demo_user@example.com
#    Password: demo123 (override via DEV_PASSWORD)
npm run seed:demo

# 3. Start the server
npm run dev      # tsx watch on http://localhost:3000
# or
npm start        # one-shot, no watch
```

Endpoints:
- `http://localhost:3000/` — static frontend
- `http://localhost:3000/graphql` — GraphQL endpoint + GraphiQL (requires login session cookie)
- `POST /auth/login` with `{ email, password }` — sets `sid` cookie

### Creating an admin user

The initial admin is not auto-created. Use the framework's CLI flag:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret npx tsx src/server.ts --create-admin
```

## Running the tests

```bash
npm test
```

Runs `src/*.test.ts` plus the `drizzle-graphql-rbac` workspace suite under Node's built-in test runner via `tsx`. Tests use in-memory SQLite — no setup needed.

## Running the stress test

The stress test (`src/scripts/stressTest.ts`) logs in as the three demo users and fans out concurrent workers issuing a randomised mix of GraphQL queries and mutations against a running server. It reports throughput, error counts, and latency percentiles per operation kind.

**Requires the server to be running and the demo users to be seeded.**

```bash
# Terminal 1: start the server
npm run db:push
npm run seed:demo
npm start

# Terminal 2: run the stress test
npx tsx src/scripts/stressTest.ts
```

Options (all optional):

| Flag                | Default                  | Description                                  |
| ------------------- | ------------------------ | -------------------------------------------- |
| `--url=<base>`      | `http://localhost:3000`  | Target server base URL                       |
| `--concurrency=<n>` | `32`                     | Number of parallel workers                   |
| `--duration=<s>`    | `15`                     | Test duration in seconds                     |
| `--users=<csv>`     | three demo users         | Comma-separated emails to log in as          |

Override the demo password via `DEV_PASSWORD=...` if you seeded with a non-default password.

Example — heavier 60s run at 128 concurrent workers:

```bash
npx tsx src/scripts/stressTest.ts --concurrency=128 --duration=60
```

## Useful commands

| Command                   | What it does                                           |
| ------------------------- | ------------------------------------------------------ |
| `npm run dev`             | Hono server with tsx watch on `:3000`                  |
| `npm start`               | Server once, no watch                                  |
| `npm test`                | Full test suite (app + framework workspace)            |
| `npm run db:push`         | Apply `src/schema.ts` to `todo.db`                     |
| `npm run db:generate`     | Generate SQL migration                                 |
| `npm run db:migrate`      | Apply SQL migrations                                   |
| `npm run db:studio`       | Drizzle Studio for browsing `todo.db`                  |
| `npm run seed:demo`       | Upsert demo users + initial todos (idempotent)         |
| `npm run seed:demo:reset` | Reset and reseed demo data                             |

## VS Code

`.vscode/launch.json` provides launch configs for **Debug server (tsx)**, **Debug server (no watch)**, **Run tests**, and **Attach to running server** (port 9229).
