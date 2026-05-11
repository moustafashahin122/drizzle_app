/**
 * @module app/testing/appTestCase
 *
 * App-level test fixture. Builds the app exactly the way `src/server.ts`
 * does — same schema, same roles, same access rights, same record rules —
 * but pointed at the framework's shared in-memory sqlite handle. Schema
 * DDL is materialized via `drizzle-kit`'s `pushSQLiteSchema` so there's no
 * hand-maintained `CREATE TABLE` to drift from `src/schema.ts`.
 *
 * Lifecycle:
 *
 *   process boot
 *     ├─ buildAppOnce() (lazy, idempotent)
 *     │   ├─ pushSQLiteSchema(appConfig.schema, drizzle)   ← idempotent DDL
 *     │   ├─ createApp({ db, ...appConfig })               ← prod wiring
 *     │   └─ build session-token mint helpers
 *     │
 *     │  for each suite using setupAppTestCase(setUp):
 *     │    ├─ before:    SAVEPOINT  + setUp(ctx) seeds reference data
 *     │    ├─ beforeEach SAVEPOINT  (per-test rollback)
 *     │    └─ after / afterEach: ROLLBACK TO ; RELEASE
 *     │
 *     └─ process exit
 *
 * RBAC role memberships are in-memory and NOT rolled back by savepoints.
 * `setupAppTestCase` calls `clearAllRbacMemberships` before each suite's
 * setUp so suites start from an empty RBAC slate.
 *
 * Public surface:
 *   - {@link setupAppTestCase}   — `transactionCase` wrapper that gives the
 *     suite a ready-to-use `{ app, rbac, db, schema, runHttp, runDirect,
 *     mintToken }` context.
 *   - {@link buildAppOnce}       — escape hatch for tests that need to wire
 *     a setup manually.
 */
import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/better-sqlite3";
import bcrypt from "bcryptjs";

// `drizzle-kit/api`'s ESM bundle uses a broken dynamic-require polyfill that
// throws on `require("fs")` under native ESM. The CJS entry works, so we
// load it through `createRequire`. See drizzle-team/drizzle-kit-mirror#…
const kitApi = createRequire(import.meta.url)("drizzle-kit/api") as {
  pushSQLiteSchema: (
    imports: Record<string, unknown>,
    drizzleInstance: unknown,
  ) => Promise<{ statementsToExecute: string[] }>;
};
import { graphql, type GraphQLSchema } from "graphql";
import {
  createApp,
  buildSchema as buildGraphqlSchema,
  issueSession,
} from "drizzle-graphql-rbac";
import type { BuiltRbac } from "drizzle-graphql-rbac";
import {
  applySchemaSql,
  getSharedSqlite,
  transactionCase,
  clearAllRbacMemberships,
} from "drizzle-graphql-rbac/testing";
import { appConfig } from "../appConfig.js";
import * as schema from "../schema.js";

/** Lazy-built singleton: one app per process, regardless of how many suites import this. */
interface AppHandle {
  sudoDb: ReturnType<typeof drizzle>;
  app: ReturnType<typeof createApp>["app"];
  rbac: BuiltRbac;
  rdbFor: ReturnType<typeof createApp>["rdbFor"];
  graphqlSchema: GraphQLSchema;
  schema: typeof schema;
}

let cached: Promise<AppHandle> | undefined;

export function buildAppOnce(): Promise<AppHandle> {
  if (cached) return cached;
  cached = (async () => {
    const sqlite = getSharedSqlite();
    sqlite.pragma("foreign_keys = ON");
    const sudoDb = drizzle(sqlite, { schema: appConfig.schema });

    // Materialize the schema DDL into the shared in-memory handle. We can't
    // use the returned `apply()` because it routes statements through
    // `drizzle.all()`, which better-sqlite3 rejects for DDL ("statement does
    // not return data"). Running the raw SQL via `sqlite.exec` sidesteps
    // that; on an already-populated DB the diff is empty so this is a no-op.
    const { statementsToExecute } = await kitApi.pushSQLiteSchema(
      appConfig.schema,
      sudoDb,
    );
    for (const stmt of statementsToExecute) sqlite.exec(stmt);

    const { app, rbac, rdbFor } = createApp({
      db: sudoDb,
      ...appConfig,
      // Tests never serve static files and don't need request logging noise.
      publicDir: null,
      logger: false,
    });

    // Rebuild the same GraphQL schema for direct (`graphql()`) invocation —
    // `createApp` doesn't expose its internal schema. Reusing the already-
    // built `rbac.enforce` keeps role memberships consistent between
    // runHttp and runDirect.
    const { schema: graphqlSchema } = buildGraphqlSchema(sudoDb, appConfig.schema, {
      hiddenOutputColumns: appConfig.hiddenOutputColumns,
      rbac: { enforce: rbac.enforce },
    });

    return { sudoDb, app, rbac, rdbFor, graphqlSchema, schema };
  })();
  return cached;
}

/** Shape returned to each suite's `setUp` (and via the `tc` proxy to each test). */
export interface AppTestCtx<Seed> {
  /**
   * Raw Drizzle handle over the shared in-memory sqlite. Named `sudoDb`
   * because direct use bypasses RBAC — appropriate for fixture seeding and
   * post-condition checks, not for exercising RBAC semantics. For that, use
   * `rdbFor(ctx)` or run the operation through `runHttp` / `runDirect`.
   */
  sudoDb: AppHandle["sudoDb"];
  /** Per-request RBAC-bound db factory. Construct one per simulated user. */
  rdbFor: AppHandle["rdbFor"];
  /** Hono app — call `app.fetch(new Request(...))`. */
  app: AppHandle["app"];
  /** RBAC engine — `assignRole(userId, key)` to grant memberships. */
  rbac: BuiltRbac;
  /** Schema namespace re-export. */
  schema: typeof schema;
  /**
   * Insert a session row for `userId` and return a Bearer token. Use the
   * returned string as `Authorization: Bearer <token>` to skip CSRF and
   * cookie plumbing in HTTP tests.
   */
  mintToken: (userId: number) => Promise<string>;
  /**
   * Execute a GraphQL query through the full Hono stack (session
   * middleware → RBAC → resolvers). Pass `asUserId` to mint and attach a
   * Bearer token automatically; omit it for an anonymous request.
   */
  runHttp: (
    query: string,
    opts?: { asUserId?: number; variables?: Record<string, unknown> },
  ) => Promise<{ status: number; body: any }>;
  /**
   * Execute a GraphQL query against the schema directly with a synthetic
   * context. Bypasses Hono/session middleware — faster, but doesn't cover
   * the auth wiring. Mirrors the in-package framework tests.
   */
  runDirect: (
    query: string,
    opts?: { user?: { id: number; name: string } | null; variables?: Record<string, unknown> },
  ) => ReturnType<typeof graphql>;
  /** Whatever the suite's `setUp` returned. Access via `tc.foo`. */
  seed: Seed;
}

/**
 * Wire a suite to the shared app. `setUp(base)` runs inside a SAVEPOINT
 * once per suite and may seed any reference data needed by the suite's
 * tests; whatever it returns is exposed as `tc.seed` and merged into the
 * proxy alongside the standard `{ app, rbac, db, schema, runHttp,
 * runDirect, mintToken }` fields.
 */
export function setupAppTestCase<Seed extends Record<string, unknown> = {}>(
  setUp?: (base: Omit<AppTestCtx<undefined>, "seed">) => Promise<Seed> | Seed,
): AppTestCtx<Seed> {
  return transactionCase(async () => {
    const h = await buildAppOnce();

    // Each suite starts from an empty RBAC slate. SAVEPOINTs only roll back
    // SQL state — role memberships are in-memory and need an explicit reset.
    clearAllRbacMemberships(h.rbac);

    const mintToken = async (userId: number) => {
      const { token } = await issueSession(h.sudoDb, h.schema, userId);
      return token;
    };

    const runHttp: AppTestCtx<Seed>["runHttp"] = async (query, opts = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.asUserId != null) {
        headers.authorization = `Bearer ${await mintToken(opts.asUserId)}`;
      }
      const res = await h.app.fetch(
        new Request("http://test.local/graphql", {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables: opts.variables ?? {} }),
        }),
      );
      const body = await res.json().catch(() => null);
      return { status: res.status, body };
    };

    const runDirect: AppTestCtx<Seed>["runDirect"] = (query, opts = {}) => {
      const user = opts.user === undefined ? null : opts.user;
      return graphql({
        schema: h.graphqlSchema,
        source: query,
        contextValue: {
          user,
          session: null,
          batch: new Map<string, unknown>(),
          db: h.rdbFor({ user: user as any, batch: new Map() }),
        },
        variableValues: opts.variables,
      });
    };

    const base: Omit<AppTestCtx<undefined>, "seed"> = {
      sudoDb: h.sudoDb,
      rdbFor: h.rdbFor,
      app: h.app,
      rbac: h.rbac,
      schema: h.schema,
      mintToken,
      runHttp,
      runDirect,
    };

    const seed = (setUp ? await setUp(base) : ({} as Seed)) as Seed;
    return { ...base, seed } as AppTestCtx<Seed>;
  });
}

/**
 * Insert a user row with a bcrypt'd password. Returns the inserted row so
 * tests can capture the auto-incremented `id`.
 */
export async function createUser(
  sudoDb: AppHandle["sudoDb"],
  attrs: { name: string; email: string; password?: string },
) {
  const passwordHash = await bcrypt.hash(attrs.password ?? "secret123", 4);
  const [row] = await sudoDb
    .insert(schema.users)
    .values({ name: attrs.name, email: attrs.email, passwordHash })
    .returning();
  return row;
}

// Re-export so test files have a single import for the fixture API.
export { applySchemaSql, getSharedSqlite, clearAllRbacMemberships };
