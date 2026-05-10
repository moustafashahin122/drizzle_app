# Scripts and tests

## Seeds

### Admin seed (recommended)

Creates/updates an admin user, ensures an `Administration` group with `isAdmin=true` (bypasses RBAC), and adds the user to that group.

```bash
npm run seed:admin
```

Overrides:

- `ADMIN_EMAIL` (default `admin@example.com`)
- `ADMIN_PASSWORD` (default `admin123`)
- `ADMIN_NAME` (default `Admin`)

### Demo RBAC seed

Creates/updates two demo users and RBAC rules demonstrating record-level filtering on todos (demo user sees only their own assigned todos).

```bash
npx tsx src/scripts/seed-demo.ts
```

Override:

- `DEMO_PASSWORD` (default `demo123`)

## Tests

Tests use Node’s built-in test runner with `tsx`, and run against isolated in-memory SQLite databases.

Run all GraphQL-related tests:

```bash
npm test
```

Run a single test file:

```bash
node --import tsx --test src/graphql/builder.test.ts
```

Filter by test name (regex):

```bash
node --import tsx --test src/graphql/builder.test.ts --test-name-pattern "relation batching"
```

